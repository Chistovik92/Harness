/**
 * Main-process side of the GGUF engine: owns the llama.cpp worker, keeps the
 * model loaded between messages, and bridges tool calls to the agent tools.
 */

import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { ToolCall, ToolDef, Message } from '../renderer/lib/providers'
import type { AgentEvent } from './agent/loop'
import type { ToolResult } from './agent/types'

const IDLE_UNLOAD_MS = 10 * 60 * 1000
/** Tool output fed back into a small local context window. */
const LOCAL_TOOL_OUTPUT_LIMIT = 6000

export type GgufChatOptions = {
  modelPath: string
  messages: Pick<Message, 'role' | 'content'>[]
  tools?: ToolDef[]
  /** Let reasoning models think before answering (slower). */
  thinking?: boolean
  temperature: number
  maxTokens: number
  signal: AbortSignal
  /** Executes a tool behind the permission gate; supplied by the caller in agent mode. */
  runTool?: (call: ToolCall) => Promise<ToolResult>
  summarize?: (call: ToolCall) => string
}

type Entry = { modelPath: string; worker: Worker; ready: Promise<{ contextSize: number; gpu: string }> }

export class GgufEngine {
  private entry: Entry | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 0

  constructor(private readonly workerPath: string, private readonly logPath?: string) {}

  private writeLog(text: string) {
    if (!this.logPath) return
    try { fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] ${text}
`) } catch { /* logging must never break chat */ }
  }

  private start(modelPath: string): Entry {
    const worker = new Worker(this.workerPath)
    worker.on('message', (msg: { type: string; text?: string }) => { if (msg.type === 'log' && msg.text) this.writeLog(msg.text) })
    const ready = new Promise<{ contextSize: number; gpu: string }>((resolve, reject) => {
      const onMessage = (msg: { type: string; error?: string; contextSize?: number; gpu?: string; id?: string }) => {
        if (msg.type === 'loaded') { worker.off('message', onMessage); resolve({ contextSize: msg.contextSize ?? 0, gpu: msg.gpu ?? 'cpu' }) }
        else if (msg.type === 'error' && msg.id === undefined) { worker.off('message', onMessage); reject(new Error(msg.error ?? 'Не удалось загрузить модель')) }
      }
      worker.on('message', onMessage)
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Процесс llama.cpp завершился при загрузке модели')))
    })
    ready.catch(() => this.unload(worker))
    worker.once('exit', () => { if (this.entry?.worker === worker) this.entry = null })
    worker.postMessage({ type: 'load', modelPath })
    return { modelPath, worker, ready }
  }

  private unload(worker: Worker) {
    void worker.terminate()
    if (this.entry?.worker === worker) this.entry = null
  }

  private acquire(modelPath: string): Entry {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.entry && this.entry.modelPath !== modelPath) { this.unload(this.entry.worker) }
    this.entry ??= this.start(modelPath)
    return this.entry
  }

  private scheduleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { if (this.entry) this.unload(this.entry.worker) }, IDLE_UNLOAD_MS)
    this.idleTimer.unref?.()
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.entry) this.unload(this.entry.worker)
  }

  async *chat(opts: GgufChatOptions): AsyncGenerator<AgentEvent> {
    const entry = this.acquire(opts.modelPath)
    try {
      await entry.ready
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
      return
    }

    const id = `g${++this.nextId}`
    const queue: AgentEvent[] = []
    let finished = false
    let wake: (() => void) | null = null
    const push = (event: AgentEvent, last = false) => { queue.push(event); if (last) finished = true; wake?.(); wake = null }

    const onMessage = (msg: { type: string; id?: string; content?: string; error?: string; callId?: string; name?: string; args?: Record<string, unknown> }) => {
      if (msg.id !== id) return
      if (msg.type === 'text' && msg.content) push({ type: 'text', content: msg.content })
      else if (msg.type === 'thought' && msg.content) push({ type: 'thought', content: msg.content })
      else if (msg.type === 'done') push({ type: 'text', content: '' }, true)
      else if (msg.type === 'error') push({ type: 'error', error: `${msg.error ?? 'Ошибка модели'}${this.logPath ? `
(подробности в журнале: ${this.logPath})` : ''}` }, true)
      else if (msg.type === 'tool_request' && msg.callId && msg.name) void this.handleTool(entry.worker, msg.callId, msg.name, msg.args ?? {}, opts, push)
    }
    const onExit = () => push({ type: 'error', error: 'Процесс llama.cpp неожиданно завершился (возможно, не хватило памяти)' }, true)
    entry.worker.on('message', onMessage)
    entry.worker.once('exit', onExit)
    const onAbort = () => entry.worker.postMessage({ type: 'abort', id })
    opts.signal.addEventListener('abort', onAbort, { once: true })

    entry.worker.postMessage({
      type: 'chat', id,
      messages: opts.messages, tools: opts.tools ?? [], temperature: opts.temperature, maxTokens: opts.maxTokens, thinking: opts.thinking === true,
    })

    try {
      while (true) {
        const event = queue.shift()
        if (event) { if ((event.type !== 'text' && event.type !== 'thought') || event.content) yield event; continue }
        if (finished) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort)
      entry.worker.off('message', onMessage)
      entry.worker.off('exit', onExit)
      this.scheduleUnload()
    }
  }

  private async handleTool(
    worker: Worker, callId: string, name: string, args: Record<string, unknown>,
    opts: GgufChatOptions, push: (event: AgentEvent) => void,
  ): Promise<void> {
    const call: ToolCall = { id: callId, name, arguments: args }
    push({ type: 'tool_start', toolCall: call, summary: opts.summarize?.(call) ?? name })
    const result: ToolResult = opts.runTool ? await opts.runTool(call) : { output: 'Инструменты недоступны', isError: true }
    push({ type: 'tool_result', toolCallId: callId, name, output: result.output.slice(0, 4000), isError: result.isError })
    worker.postMessage({ type: 'tool_result', callId, output: result.output.slice(0, LOCAL_TOOL_OUTPUT_LIMIT) })
  }
}
