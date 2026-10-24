/**
 * DeepSeek Harness Desktop — Hugging Face local inference Worker.
 *
 * Runs @huggingface/transformers (ONNX runtime) in a worker thread so the UI
 * never blocks while a model downloads or generates. Downloads report progress;
 * generation streams text. Results are posted back through parentPort.
 */

import { parentPort, workerData } from 'node:worker_threads'

interface ChatMessage { role: string; content: string }

interface HFWorkerData {
  mode: 'generate' | 'download'
  model: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  cacheDir: string
}

// The library is ESM-only; keep a real dynamic import() under CommonJS output.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

// Smallest usable weights first: not every repository ships every quantisation.
const DTYPES = ['q4', 'q8', 'fp16', 'fp32']
const DEFAULT_CONTEXT = 2048
const MIN_NEW_TOKENS = 16
const PROGRESS_INTERVAL_MS = 150
// Base models have no chat template and keep inventing both sides of a dialogue.
const TRANSCRIPT_STOP = /\n?(user|human|assistant)\s*:/i

const post = (message: Record<string, unknown>) => parentPort?.postMessage(message)
const lastProgressAt = new Map<string, number>()

async function loadPipeline(transformers: any, model: string) {
  let lastError: unknown
  for (const dtype of DTYPES) {
    try {
      return await transformers.pipeline('text-generation', model, {
        dtype,
        progress_callback: (p: any) => {
          const now = Date.now()
          const throttled = p?.status === 'progress' && now - (lastProgressAt.get(p.file) ?? 0) < PROGRESS_INTERVAL_MS
          if ((p?.status === 'progress' || p?.status === 'done') && !throttled) {
            lastProgressAt.set(p.file, now)
            post({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total, status: p.status })
          }
        },
      })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function flatPrompt(messages: ChatMessage[]): string {
  const label = (role: string) => (role === 'assistant' ? 'Assistant' : role === 'system' ? 'System' : 'User')
  return messages.map((m) => `${label(m.role)}: ${m.content}`).join('\n') + '\nAssistant:'
}

/** Longest sequence the model can attend to (positions), whatever the architecture calls it. */
function contextLength(generator: any): number {
  const cfg = generator.model?.config ?? {}
  const value = cfg.max_position_embeddings ?? cfg.n_positions ?? cfg.n_ctx ?? cfg.max_sequence_length
  return typeof value === 'number' && value > 0 ? value : DEFAULT_CONTEXT
}

function tokenCount(generator: any, text: string): number {
  const encoded = generator.tokenizer(text)
  const dims = encoded.input_ids?.dims
  return Array.isArray(dims) ? Number(dims[dims.length - 1]) : text.length
}

interface Prompt { text: string; chatTemplate: boolean; tokens: number }

/** Renders the conversation, dropping the oldest turns until it fits the context window. */
function buildPrompt(generator: any, messages: ChatMessage[], budget: number): Prompt {
  let turns = messages
  while (true) {
    let text: string
    let chatTemplate = true
    try {
      text = generator.tokenizer.apply_chat_template(turns, { tokenize: false, add_generation_prompt: true })
    } catch {
      text = flatPrompt(turns)
      chatTemplate = false
    }
    const tokens = tokenCount(generator, text)
    const droppable = turns.findIndex((m) => m.role !== 'system')
    if (tokens <= budget || turns.length <= 1 || droppable === -1 || droppable === turns.length - 1) {
      return { text, chatTemplate, tokens }
    }
    turns = turns.filter((_, i) => i !== droppable)
  }
}

async function run(): Promise<void> {
  const { mode, model, messages, temperature, maxTokens, cacheDir } = workerData as HFWorkerData

  const transformers = await importEsm('@huggingface/transformers')
  transformers.env.cacheDir = cacheDir
  transformers.env.allowLocalModels = false

  const generator = await loadPipeline(transformers, model)
  if (mode === 'download') {
    post({ type: 'done' })
    return
  }

  const context = contextLength(generator)
  const wanted = Math.min(maxTokens, Math.max(MIN_NEW_TOKENS, Math.floor(context / 2)))
  const prompt = buildPrompt(generator, messages, context - wanted)
  const newTokens = Math.min(wanted, context - prompt.tokens)
  if (newTokens < 1) throw new Error(`Запрос не помещается в контекст модели (${context} токенов)`)

  const stopping = new transformers.InterruptableStoppingCriteria()
  let emitted = ''
  const streamer = new transformers.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (!text) return
      emitted += text
      if (!prompt.chatTemplate) {
        const stop = emitted.search(TRANSCRIPT_STOP)
        if (stop >= 0) {
          const already = emitted.length - text.length
          const keep = text.slice(0, Math.max(0, stop - already))
          if (keep) post({ type: 'text', content: keep })
          stopping.interrupt()
          return
        }
      }
      post({ type: 'text', content: text })
    },
  })

  await generator(prompt.text, {
    max_new_tokens: newTokens,
    do_sample: temperature > 0,
    ...(temperature > 0 ? { temperature } : {}),
    // Greedy decoding of small base models loops without a penalty.
    repetition_penalty: prompt.chatTemplate ? 1.05 : 1.3,
    add_special_tokens: !prompt.chatTemplate,
    streamer,
    stopping_criteria: stopping,
  })
  post({ type: 'done' })
}

run().catch((err: unknown) => {
  post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
})
