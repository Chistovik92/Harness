/**
 * Runs local Hugging Face models (transformers.js) in a worker thread and
 * exposes the result as an async generator of chat chunks.
 */

import { Worker } from 'node:worker_threads'
import type { ChatChunk } from '../renderer/lib/providers'

export type DownloadProgress = { file?: string; loaded?: number; total?: number; status?: string }

export type LocalRunOptions = {
  workerPath: string
  cacheDir: string
  model: string
  messages?: { role: string; content: string }[]
  onProgress?: (progress: DownloadProgress) => void
  temperature?: number
  maxTokens?: number
  mode?: 'generate' | 'download'
  signal?: AbortSignal
}

const HF_MODEL_ID = /^[\w.-]+\/[\w.-]+$/

export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && HF_MODEL_ID.test(id)
}

export async function* runLocalModel(opts: LocalRunOptions): AsyncGenerator<ChatChunk> {
  if (!isValidModelId(opts.model)) {
    yield { type: 'error', error: `Invalid model id: ${String(opts.model)}` }
    return
  }

  const queue: ChatChunk[] = []
  let finished = false
  let wake: (() => void) | null = null
  const notify = () => { wake?.(); wake = null }

  const worker = new Worker(opts.workerPath, {
    workerData: {
      mode: opts.mode ?? 'generate',
      model: opts.model,
      messages: opts.messages ?? [],
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 256,
      cacheDir: opts.cacheDir,
    },
  })

  worker.on('message', (msg: (ChatChunk | { type: 'progress' }) & DownloadProgress) => {
    if (msg.type === 'progress') { opts.onProgress?.(msg); return }
    queue.push(msg)
    if (msg.type === 'done' || msg.type === 'error') finished = true
    notify()
  })
  worker.on('error', (err: Error) => {
    queue.push({ type: 'error', error: err.message })
    finished = true
    notify()
  })
  worker.on('exit', () => { finished = true; notify() })

  const onAbort = () => { void worker.terminate() }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const chunk = queue.shift()
      if (chunk) {
        yield chunk
        if (chunk.type === 'done' || chunk.type === 'error') return
        continue
      }
      if (finished) {
        yield { type: 'done' }
        return
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    void worker.terminate()
  }
}
