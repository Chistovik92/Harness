/**
 * llama.cpp worker (node-llama-cpp). Keeps one GGUF model loaded and serves
 * chat requests, optionally with function calling. Tool calls are executed by
 * the main process: the worker sends `tool_request` and waits for `tool_result`.
 */

import { parentPort } from 'node:worker_threads'
import { createThinkRouter } from './thinkRouter'

interface ChatMessage { role: string; content: string }
interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

type ChatRequest = {
  type: 'chat'
  id: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  temperature: number
  maxTokens: number
  /** Allow the model's hidden reasoning ("thinking") before it answers. */
  thinking: boolean
}

type Incoming =
  | { type: 'load'; modelPath: string }
  | ChatRequest
  | { type: 'tool_result'; callId: string; output: string }
  | { type: 'abort'; id: string }

// The library is ESM-only; keep a real dynamic import() under CommonJS output.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
const MAX_CONTEXT = 8192
const MIN_CONTEXT = 2048
const THINK_BUDGET_TOKENS = 2048
/** Errors that mean "the model's own chat template could not be applied". */
const TEMPLATE_ERROR = /unexpected token|syntaxerror|jinja|template|chat ?wrapper|is not defined|cannot read propert/i

const post = (message: Record<string, unknown>) => parentPort?.postMessage(message)
const log = (text: string) => post({ type: 'log', text })

let lib: any
let llama: any
let model: any
let context: any
let sequence: any
/** Index into the wrapper chain that worked last, so a broken template is only probed once. */
let wrapperIndex = 0
const aborts = new Map<string, AbortController>()
const pendingTools = new Map<string, (output: string) => void>()
let busy: Promise<void> = Promise.resolve()

// The model's own (Jinja) template first; ChatML and a generic format as fallbacks.
const wrapperChain: (() => unknown)[] = [
  () => undefined,
  () => new lib.ChatMLChatWrapper(),
  () => new lib.GeneralChatWrapper(),
]

async function load(modelPath: string): Promise<void> {
  lib = await importEsm('node-llama-cpp')
  llama = await lib.getLlama()
  model = await llama.loadModel({ modelPath })
  const train = Number(model.trainContextSize) || MAX_CONTEXT
  // Large contexts need a lot of memory: back off until one fits.
  let size = Math.min(train, MAX_CONTEXT)
  while (true) {
    try {
      context = await model.createContext({ contextSize: size })
      break
    } catch (err) {
      if (size <= MIN_CONTEXT) throw err
      size = Math.max(MIN_CONTEXT, Math.floor(size / 2))
    }
  }
  sequence = context.getSequence()
  post({ type: 'loaded', contextSize: size, gpu: llama.gpu || 'cpu' })
}

/** node-llama-cpp accepts a restricted JSON-schema dialect: keep structure, drop prose keys. */
function cleanSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') continue
    out[key] = cleanSchema(value)
  }
  return out
}

function toHistory(messages: ChatMessage[]) {
  const history: any[] = []
  for (const m of messages) {
    if (m.role === 'system') history.push({ type: 'system', text: m.content })
    else if (m.role === 'user') history.push({ type: 'user', text: m.content })
    else if (m.role === 'assistant') history.push({ type: 'model', response: [m.content] })
  }
  return history
}

/** One generation with the given wrapper; `state.emitted` tells whether any output already reached the user. */
async function generate(req: ChatRequest, wrapperIdx: number, signal: AbortSignal, state: { emitted: boolean }): Promise<void> {
  const wrapper = wrapperChain[wrapperIdx]()
  let session: any
  try {
    const turns = toHistory(req.messages)
    const last = turns.pop()
    if (!last || last.type !== 'user') throw new Error('Последнее сообщение должно быть от пользователя')

    session = new lib.LlamaChatSession({ contextSequence: sequence, ...(wrapper ? { chatWrapper: wrapper } : {}) })
    if (turns.length > 0) session.setChatHistory(turns)

    const functions: Record<string, unknown> = {}
    let callCounter = 0
    for (const tool of req.tools) {
      functions[tool.name] = lib.defineChatSessionFunction({
        description: tool.description,
        params: cleanSchema(tool.parameters),
        handler: async (args: unknown) => {
          state.emitted = true
          const callId = `${req.id}:${callCounter++}`
          const result = new Promise<string>((resolve) => pendingTools.set(callId, resolve))
          post({ type: 'tool_request', id: req.id, callId, name: tool.name, args })
          return result
        },
      })
    }

    const thoughtTokens = req.thinking ? THINK_BUDGET_TOKENS : 0
    // With thinking off, reasoning markers (e.g. a bare "Thinking" header) are noise.
    const emitThought = (text: string) => { if (req.thinking && text) post({ type: 'thought', id: req.id, content: text }) }
    const emitText = (raw: string) => {
      // Reasoning models start the answer with blank lines.
      const text = state.emitted ? raw : raw.replace(/^\s+/, '')
      if (!text) return
      state.emitted = true
      post({ type: 'text', id: req.id, content: text })
    }
    const router = createThinkRouter(emitText, emitThought)
    await session.prompt(last.text, {
      ...(req.tools.length > 0 ? { functions } : {}),
      maxTokens: req.maxTokens + thoughtTokens,
      temperature: req.temperature,
      topP: 0.9,
      topK: 40,
      signal,
      stopOnAbortSignal: true,
      // Reasoning models spend the whole answer budget "thinking" unless it is capped.
      budgets: { thoughtTokens },
      onResponseChunk: (chunk: { type?: string; segmentType?: string; text: string }) => {
        if (!chunk.text) return
        if (chunk.type === 'segment') {
          if (chunk.segmentType === 'thought') emitThought(chunk.text)
          return
        }
        router.push(chunk.text)
      },
    })
    router.flush()
  } finally {
    try { session?.dispose({ disposeSequence: false }) } catch { /* already disposed */ }
    try { await sequence.clearHistory() } catch { /* sequence reset is best effort */ }
  }
}

async function chat(req: ChatRequest): Promise<void> {
  const controller = new AbortController()
  aborts.set(req.id, controller)
  const state = { emitted: false }
  let failure: unknown = null
  try {
    for (let i = wrapperIndex; i < wrapperChain.length; i++) {
      try {
        await generate(req, i, controller.signal, state)
        wrapperIndex = i
        post({ type: 'done', id: req.id })
        return
      } catch (err) {
        if (controller.signal.aborted) { post({ type: 'done', id: req.id }); return }
        failure = err
        const message = err instanceof Error ? err.message : String(err)
        log(`wrapper #${i} failed: ${err instanceof Error ? (err.stack ?? message) : message}`)
        // Retry with another template only when nothing has been shown yet.
        if (state.emitted || !TEMPLATE_ERROR.test(message)) break
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    post({ type: 'error', id: req.id, error: message })
  } finally {
    aborts.delete(req.id)
    for (const [callId, resolve] of pendingTools) if (callId.startsWith(`${req.id}:`)) { resolve('Прервано'); pendingTools.delete(callId) }
  }
}

parentPort?.on('message', (msg: Incoming) => {
  if (msg.type === 'load') {
    load(msg.modelPath).catch((err) => {
      log(`load failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    })
  } else if (msg.type === 'chat') {
    // One generation at a time: they share a single context sequence.
    busy = busy.then(() => chat(msg))
  } else if (msg.type === 'tool_result') {
    pendingTools.get(msg.callId)?.(msg.output)
    pendingTools.delete(msg.callId)
  } else if (msg.type === 'abort') {
    aborts.get(msg.id)?.abort()
  }
})
