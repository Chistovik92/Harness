/**
 * DeepSeek Harness Desktop — Hugging Face local inference Worker.
 *
 * Runs @xenova/transformers in a separate worker thread so the UI never
 * blocks while a local model downloads or generates. Results are posted
 * back to the main process through parentPort.
 */

import { parentPort, workerData } from 'node:worker_threads'

interface HFWorkerData {
  mode: 'generate' | 'download'
  model: string
  prompt: string
  temperature: number
  maxTokens: number
  cacheDir: string
}

// transformers.js is ESM-only; keep a real dynamic import() under CommonJS output.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

async function run(): Promise<void> {
  const { mode, model, prompt, temperature, maxTokens, cacheDir } = workerData as HFWorkerData

  const transformers = await importEsm('@xenova/transformers')
  transformers.env.cacheDir = cacheDir
  transformers.env.allowLocalModels = false

  const generator = await transformers.pipeline('text-generation', model)
  if (mode === 'download') {
    parentPort?.postMessage({ type: 'done' })
    return
  }

  const output = await generator(prompt, {
    max_new_tokens: maxTokens,
    temperature: Math.max(temperature, 0.01),
    do_sample: temperature > 0,
  })

  const full: string = Array.isArray(output) ? (output[0]?.generated_text ?? '') : (output?.generated_text ?? '')
  const text = full.startsWith(prompt) ? full.slice(prompt.length) : full
  if (text) parentPort?.postMessage({ type: 'text', content: text })
  parentPort?.postMessage({ type: 'done' })
}

run().catch((err: unknown) => {
  parentPort?.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
})
