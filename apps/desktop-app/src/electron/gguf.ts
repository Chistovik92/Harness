/**
 * Main-process side of the GGUF engine. llama.cpp runs in a separate child
 * process: a native crash (out of memory, GPU driver fault) then kills only
 * that process and the app survives. The model stays loaded between messages,
 * and tool calls are bridged to the agent tools.
 */

import fs from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import type { ToolCall, ToolDef, Message } from '../renderer/lib/providers'
import type { AgentEvent } from './agent/loop'
import type { ToolResult } from './agent/types'

const IDLE_UNLOAD_MS = 10 * 60 * 1000
/** Tool output fed back into a small local context window. */
const LOCAL_TOOL_OUTPUT_LIMIT = 6000
const STDERR_TAIL_CHARS = 3000

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

type WorkerMessage = {
  type: string
  id?: string
  error?: string
  text?: string
  content?: string
  contextSize?: number
  gpu?: string
  callId?: string
  name?: string
  args?: Record<string, unknown>
}

type Entry = {
  modelPath: string
  child: ChildProcess
  ready: Promise<{ contextSize: number; gpu: string }>
  /** Last stderr output, kept to explain an unexpected exit. */
  stderr: { text: string }
}

const describeExit = (code: number | null, signal: NodeJS.Signals | null) =>
  signal ? `сигнал ${signal}` : `код ${code ?? 'неизвестен'}`

/** 0xC0000005 (access violation) / SIGSEGV: llama.cpp hit missing or invalid data, not a shortage of memory. */
const isMemoryFault = (code: number | null, signal: NodeJS.Signals | null) =>
  code === 3221225477 || code === -1073741819 || code === 139 || signal === 'SIGSEGV'

function explainCrash(code: number | null, signal: NodeJS.Signals | null, stage: string): string {
  const what = `Процесс llama.cpp аварийно завершился ${stage} (${describeExit(code, signal)}). Приложение продолжает работать.`
  return isMemoryFault(code, signal)
    ? `${what} Это сбой доступа к памяти внутри llama.cpp: файл модели повреждён, скачан не полностью, это вспомогательная (draft/MTP) часть модели или архитектура не поддерживается встроенной версией llama.cpp. Скачайте другой файл (или квантизацию) из репозитория.`
    : `${what} Вероятнее всего модели не хватило памяти (ОЗУ или видеопамяти): выберите модель меньшего размера или квантизацию Q4 и закройте другие программы.`
}
export class GgufEngine {
  private entry: Entry | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 0
  /** Children we stopped ourselves: their exit is expected, not a crash. */
  private readonly stopped = new WeakSet<ChildProcess>()

  constructor(private readonly workerPath: string, private readonly logPath?: string) {}

  private writeLog(text: string) {
    if (!this.logPath) return
    try { fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] ${text}\n`) } catch { /* logging must never break chat */ }
  }

  private start(modelPath: string): Entry {
    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node for this child.
    const child = fork(this.workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const stderr = { text: '' }
    child.stderr?.on('data', (chunk: Buffer) => { stderr.text = (stderr.text + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
    child.on('message', (msg: WorkerMessage) => { if (msg.type === 'log' && msg.text) this.writeLog(msg.text) })

    const ready = new Promise<{ contextSize: number; gpu: string }>((resolve, reject) => {
      const onMessage = (msg: WorkerMessage) => {
        if (msg.type === 'loaded') { child.off('message', onMessage); resolve({ contextSize: msg.contextSize ?? 0, gpu: msg.gpu ?? 'cpu' }) }
        else if (msg.type === 'error' && msg.id === undefined) { child.off('message', onMessage); reject(new Error(msg.error ?? 'Не удалось загрузить модель')) }
      }
      child.on('message', onMessage)
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (!this.stopped.has(child)) this.writeLog(`load: process exited (${describeExit(code, signal)}) stderr: ${stderr.text}`)
        reject(new Error(explainCrash(code, signal, 'при загрузке модели')))
      })
    })
    ready.catch(() => this.unload(child))
    child.once('exit', () => { if (this.entry?.child === child) this.entry = null })
    child.send({ type: 'load', modelPath })
    return { modelPath, child, ready, stderr }
  }

  private unload(child: ChildProcess) {
    this.stopped.add(child)
    try { child.kill() } catch { /* already gone */ }
    if (this.entry?.child === child) this.entry = null
  }

  private acquire(modelPath: string): Entry {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.entry && (this.entry.modelPath !== modelPath || this.entry.child.exitCode !== null || !this.entry.child.connected)) {
      this.unload(this.entry.child)
    }
    this.entry ??= this.start(modelPath)
    return this.entry
  }

  private scheduleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { if (this.entry) this.unload(this.entry.child) }, IDLE_UNLOAD_MS)
    this.idleTimer.unref?.()
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.entry) this.unload(this.entry.child)
  }

  /** Library errors are English; explain the common ones in plain Russian. */
  private translate(message: string): string {
    if (/context size of \d+ is too large for the available VRAM/i.test(message)) {
      return 'Модель вместе с контекстом не помещается в видеопамять. Выберите модель меньше (меньше параметров или квантизация Q4/IQ3 вместо Q8) или закройте программы, занимающие видеопамять.'
    }
    return message
  }

  async *chat(opts: GgufChatOptions): AsyncGenerator<AgentEvent> {
    const entry = this.acquire(opts.modelPath)
    try {
      await entry.ready
    } catch (err) {
      yield { type: 'error', error: this.withLogHint(this.translate(err instanceof Error ? err.message : String(err))) }
      return
    }

    const id = `g${++this.nextId}`
    const queue: AgentEvent[] = []
    let finished = false
    let wake: (() => void) | null = null
    const push = (event: AgentEvent, last = false) => { queue.push(event); if (last) finished = true; wake?.(); wake = null }

    const onMessage = (msg: WorkerMessage) => {
      if (msg.id !== id) return
      if (msg.type === 'text' && msg.content) push({ type: 'text', content: msg.content })
      else if (msg.type === 'thought' && msg.content) push({ type: 'thought', content: msg.content })
      else if (msg.type === 'done') push({ type: 'text', content: '' }, true)
      else if (msg.type === 'error') push({ type: 'error', error: this.withLogHint(this.translate(msg.error ?? 'Ошибка модели')) }, true)
      else if (msg.type === 'tool_request' && msg.callId && msg.name) void this.handleTool(entry.child, msg.callId, msg.name, msg.args ?? {}, opts, push)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.writeLog(`chat: process exited (${describeExit(code, signal)}) stderr: ${entry.stderr.text}`)
      push({ type: 'error', error: this.withLogHint(explainCrash(code, signal, 'во время ответа')) }, true)
    }
    entry.child.on('message', onMessage)
    entry.child.once('exit', onExit)
    const onAbort = () => this.send(entry.child, { type: 'abort', id })
    opts.signal.addEventListener('abort', onAbort, { once: true })

    this.send(entry.child, {
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
      entry.child.off('message', onMessage)
      entry.child.off('exit', onExit)
      this.scheduleUnload()
    }
  }

  private withLogHint(message: string): string {
    return this.logPath ? `${message}\n(подробности в журнале: ${this.logPath})` : message
  }

  private send(child: ChildProcess, message: Record<string, unknown>) {
    try { if (child.connected) child.send(message) } catch (err) { this.writeLog(`send failed: ${String(err)}`) }
  }

  private async handleTool(
    child: ChildProcess, callId: string, name: string, args: Record<string, unknown>,
    opts: GgufChatOptions, push: (event: AgentEvent) => void,
  ): Promise<void> {
    const call: ToolCall = { id: callId, name, arguments: args }
    push({ type: 'tool_start', toolCall: call, summary: opts.summarize?.(call) ?? name })
    const result: ToolResult = opts.runTool ? await opts.runTool(call) : { output: 'Инструменты недоступны', isError: true }
    push({ type: 'tool_result', toolCallId: callId, name, output: result.output.slice(0, 4000), isError: result.isError })
    this.send(child, { type: 'tool_result', callId, output: result.output.slice(0, LOCAL_TOOL_OUTPUT_LIMIT) })
  }
}
