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

const post = (message: Record<string, unknown>) => parentPort?.postMessage(message)

const PROGRESS_INTERVAL_MS = 150
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
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:'
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

  const streamer = new transformers.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => { if (text) post({ type: 'text', content: text }) },
  })
  const options = {
    max_new_tokens: maxTokens,
    do_sample: temperature > 0,
    ...(temperature > 0 ? { temperature } : {}),
    streamer,
  }

  try {
    await generator(messages, options)
  } catch (err) {
    // Base models have no chat template: fall back to a plain transcript prompt.
    if (!/chat_template/i.test(String((err as Error)?.message))) throw err
    await generator(flatPrompt(messages), options)
  }
  post({ type: 'done' })
}

run().catch((err: unknown) => {
  post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
})
