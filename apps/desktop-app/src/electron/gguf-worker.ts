/**
 * llama.cpp child process (node-llama-cpp). Keeps one GGUF model loaded and serves
 * chat requests, optionally with function calling. Tool calls are executed by
 * the main process: the worker sends `tool_request` and waits for `tool_result`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
// DSH_CONTEXT_CAP lets tests reproduce a memory-starved machine.
const MAX_CONTEXT = Number(process.env.DSH_CONTEXT_CAP) || 8192
const MIN_CONTEXT = Math.min(2048, MAX_CONTEXT)
const THINK_BUDGET_TOKENS = 2048
/** Below this many tokens the full tool list + agent prompt would eat most of the context. */
const COMPACT_CONTEXT = 8192
const CORE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash'])
/** node-llama-cpp's message when the history (system prompt included) cannot be squeezed into the context. */
const CONTEXT_FULL = /context shift strategy|fits the context size|context size.*(exceed|too small)/i
/** VRAM reserved for the context when deciding how many layers to put on the GPU. */
const GPU_FIT_CONTEXT = 4096
/** Errors that mean "the model's own chat template could not be applied". */
const TEMPLATE_ERROR = /unexpected token|syntaxerror|jinja|template|chat ?wrapper|is not defined|cannot read propert/i

// Runs as a forked child process: a native crash here must not take the app down.
const post = (message: Record<string, unknown>) => { try { process.send?.(message) } catch { /* parent is gone */ } }
const GB = 1024 ** 3
const formatGb = (bytes: number) => `${(bytes / GB).toFixed(1)} ГБ`
const log = (text: string) => post({ type: 'log', text })

let lib: any
let llama: any
let model: any
let context: any
let sequence: any
/** Index into the wrapper chain that worked last, so a broken template is only probed once. */
let wrapperIndex = 0
/** Tokens the loaded context can hold; small when memory is tight. */
let contextTokens = 0
const aborts = new Map<string, AbortController>()
const pendingTools = new Map<string, (output: string) => void>()
let busy: Promise<void> = Promise.resolve()

// The model's own (Jinja) template first; ChatML and a generic format as fallbacks.
const wrapperChain: (() => unknown)[] = [
  () => undefined,
  () => new lib.ChatMLChatWrapper(),
  () => new lib.GeneralChatWrapper(),
]

/** Largest context that fits the memory that is actually free, backing off if needed. */
async function createContext(): Promise<any> {
  const train = Number(model.trainContextSize) || MAX_CONTEXT
  const maxContext = Math.min(train, MAX_CONTEXT)
  try {
    return await model.createContext({ contextSize: { min: Math.min(MIN_CONTEXT, maxContext), max: maxContext } })
  } catch (err) {
    log(`auto context failed, backing off: ${err instanceof Error ? err.message : String(err)}`)
  }
  let size = maxContext
  while (true) {
    try {
      return await model.createContext({ contextSize: size })
    } catch (err) {
      if (size <= MIN_CONTEXT) throw err
      size = Math.max(MIN_CONTEXT, Math.floor(size / 2))
    }
  }
}

async function load(modelPath: string): Promise<void> {
  lib = await importEsm('node-llama-cpp')
  const fileName = path.basename(modelPath)
  if (/(^|[-_.])draft([-_.]|$)/i.test(fileName)) {
    throw new Error(`Файл «${fileName}» — вспомогательная (draft) модель для спекулятивного декодирования, отдельно она не работает и роняет llama.cpp. Скачайте основной файл этого репозитория (без «draft» в имени; у моделей с MTP надёжнее вариант «noMTP»).`)
  }
  llama = await lib.getLlama()

  // Loading a model that does not fit makes the OS thrash or the GPU driver abort: refuse up front.
  const weights = fs.statSync(modelPath).size
  const vram = await Promise.resolve(llama.getVramState?.()).catch(() => null)
  const freeRam = os.freemem()
  const freeVram = Number(vram?.free) || 0
  if (weights * 1.1 > freeRam + freeVram) {
    throw new Error(`Модель (${formatGb(weights)}) не поместится в память: свободно ${formatGb(freeRam)} ОЗУ и ${formatGb(freeVram)} видеопамяти. Закройте другие программы или выберите модель меньше (меньше параметров или квантизация Q4 вместо Q8).`)
  }

  // Offload as many layers as leave room for the context; if even that does not fit, run on the CPU.
  const attempts: Record<string, unknown>[] = [
    { gpuLayers: { fitContext: { contextSize: GPU_FIT_CONTEXT } } },
    { gpuLayers: 0 },
  ]
  let lastError: unknown
  for (const options of attempts) {
    try {
      model = await llama.loadModel({ modelPath, ...options })
      context = await createContext()
      lastError = undefined
      break
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      log(`load attempt ${JSON.stringify(options)} failed: ${message}`)
      try { await model?.dispose() } catch { /* already disposed */ }
      model = undefined
      // Only memory problems are worth retrying with another placement.
      if (!/vram|context size|memory|allocat/i.test(message)) throw err
    }
  }
  if (lastError) throw lastError
  sequence = context.getSequence()
  contextTokens = Number(context.contextSize) || 0
  post({ type: 'loaded', contextSize: contextTokens, gpu: llama.gpu || 'cpu' })
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

/** Short descriptions and only the essential tools: small contexts cannot afford the full set. */
function compactTools(tools: ToolSpec[]): ToolSpec[] {
  return tools
    .filter((t) => CORE_TOOLS.has(t.name))
    .map((t) => ({ ...t, description: (t.description.split(/(?<=[.!?])\s/)[0] ?? t.description).slice(0, 110) }))
}

/** Replaces the long agent system prompt with a few lines, keeping the workspace and OS facts. */
function compactSystem(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'system' || !m.content.startsWith('You are an autonomous')) return m
    const facts = m.content.split('\n').filter((l) => /^(Workspace folder|OS):/.test(l))
    const intro = "You are a coding assistant that can use tools to read, edit and search files and run commands. Prefer tools over guessing. Reply in the user's language."
    return { ...m, content: [intro, ...facts].join('\n') }
  })
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
    let messages = req.messages
    let tools = req.tools
    if (tools.length > 0 && contextTokens > 0 && contextTokens < COMPACT_CONTEXT) {
      tools = compactTools(tools)
      messages = compactSystem(messages)
    }
    // Tool definitions plus the prompt must leave most of the context for the conversation and the answer.
    const promptTokens = Math.ceil((JSON.stringify(tools).length + messages.reduce((n, m) => n + m.content.length, 0)) / 3)
    if (tools.length > 0 && contextTokens > 0 && promptTokens > contextTokens * 0.65) {
      throw new Error(`Контекст модели (${contextTokens} токенов) слишком мал для режима агента: описания инструментов и подсказка занимают около ${promptTokens} токенов. Выберите модель поменьше (тогда останется память под больший контекст) или отключите режим агента.`)
    }
    const budget = contextTokens > 0 ? Math.max(256, Math.floor(contextTokens / 2)) : req.maxTokens
    const turns = toHistory(messages)
    const last = turns.pop()
    if (!last || last.type !== 'user') throw new Error('Последнее сообщение должно быть от пользователя')

    session = new lib.LlamaChatSession({ contextSequence: sequence, ...(wrapper ? { chatWrapper: wrapper } : {}) })
    if (turns.length > 0) session.setChatHistory(turns)

    const functions: Record<string, unknown> = {}
    let callCounter = 0
    for (const tool of tools) {
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

    const thoughtTokens = req.thinking ? Math.min(THINK_BUDGET_TOKENS, Math.floor(budget / 2)) : 0
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
      ...(tools.length > 0 ? { functions } : {}),
      maxTokens: Math.min(req.maxTokens, budget) + thoughtTokens,
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
        if (CONTEXT_FULL.test(message)) {
          // A long answer ran into the end of the context: keep what was written instead of failing.
          if (state.emitted) {
            post({ type: 'text', id: req.id, content: `\n\n… (ответ оборван: закончился контекст модели, ${contextTokens} токенов)` })
            post({ type: 'done', id: req.id })
            return
          }
          failure = new Error(`Запрос вместе с подсказкой не помещается в контекст модели (${contextTokens} токенов). Начните новый чат, отключите режим агента или выберите модель поменьше.`)
          break
        }
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

process.on('message', (msg: Incoming) => {
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

// The app closed the channel (quit or crash): nothing left to serve.
process.on('disconnect', () => process.exit(0))
