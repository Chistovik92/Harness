/**
 * llama.cpp worker (node-llama-cpp). Keeps one GGUF model loaded and serves
 * chat requests, optionally with function calling. Tool calls are executed by
 * the main process: the worker sends `tool_request` and waits for `tool_result`.
 */

import { parentPort } from 'node:worker_threads'

interface ChatMessage { role: string; content: string }
interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

type Incoming =
  | { type: 'load'; modelPath: string }
  | { type: 'chat'; id: string; messages: ChatMessage[]; tools: ToolSpec[]; temperature: number; maxTokens: number }
  | { type: 'tool_result'; callId: string; output: string }
  | { type: 'abort'; id: string }

// The library is ESM-only; keep a real dynamic import() under CommonJS output.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
const MAX_CONTEXT = 8192
const MIN_CONTEXT = 2048

const post = (message: Record<string, unknown>) => parentPort?.postMessage(message)

let lib: any
let llama: any
let model: any
let context: any
let sequence: any
const aborts = new Map<string, AbortController>()
const pendingTools = new Map<string, (output: string) => void>()
let busy: Promise<void> = Promise.resolve()

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

async function chat(req: Extract<Incoming, { type: 'chat' }>): Promise<void> {
  const controller = new AbortController()
  aborts.set(req.id, controller)
  let session: any
  try {
    const turns = toHistory(req.messages)
    const last = turns.pop()
    if (!last || last.type !== 'user') throw new Error('Последнее сообщение должно быть от пользователя')

    session = new lib.LlamaChatSession({ contextSequence: sequence })
    if (turns.length > 0) session.setChatHistory(turns)

    const functions: Record<string, unknown> = {}
    let callCounter = 0
    for (const tool of req.tools) {
      functions[tool.name] = lib.defineChatSessionFunction({
        description: tool.description,
        params: cleanSchema(tool.parameters),
        handler: async (args: unknown) => {
          const callId = `${req.id}:${callCounter++}`
          const result = new Promise<string>((resolve) => pendingTools.set(callId, resolve))
          post({ type: 'tool_request', id: req.id, callId, name: tool.name, args })
          return result
        },
      })
    }

    await session.prompt(last.text, {
      ...(req.tools.length > 0 ? { functions } : {}),
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      signal: controller.signal,
      stopOnAbortSignal: true,
      onTextChunk: (text: string) => { if (text) post({ type: 'text', id: req.id, content: text }) },
    })
    post({ type: 'done', id: req.id })
  } catch (err) {
    if (controller.signal.aborted) post({ type: 'done', id: req.id })
    else post({ type: 'error', id: req.id, error: err instanceof Error ? err.message : String(err) })
  } finally {
    aborts.delete(req.id)
    for (const [callId, resolve] of pendingTools) if (callId.startsWith(`${req.id}:`)) { resolve('Прервано'); pendingTools.delete(callId) }
    try { session?.dispose({ disposeSequence: false }) } catch { /* already disposed */ }
    try { await sequence.clearHistory() } catch { /* sequence reset is best effort */ }
  }
}

parentPort?.on('message', (msg: Incoming) => {
  if (msg.type === 'load') {
    load(msg.modelPath).catch((err) => post({ type: 'error', error: err instanceof Error ? err.message : String(err) }))
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
