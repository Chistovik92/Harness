import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GgufEngine } from '../electron/gguf'
import type { AgentEvent } from '../electron/agent/loop'

// A stand-in for gguf-worker.js: answers chats, and dies like a native crash on demand.
const FAKE_WORKER = `
let lastId = null
process.on('message', (msg) => {
  if (msg.type === 'load') process.send({ type: 'loaded', contextSize: 4096, gpu: 'cpu' })
  else if (msg.type === 'chat') {
    const last = msg.messages[msg.messages.length - 1].content
    lastId = msg.id
    if (last === 'crash') process.exit(139)
    if (last === 'oom') process.exit(1)
    if (last === 'tool') process.send({ type: 'tool_request', id: msg.id, callId: msg.id + ':0', name: 'read_file', args: { path: 'a.txt' } })
    else { process.send({ type: 'text', id: msg.id, content: 'echo: ' + last }); process.send({ type: 'done', id: msg.id }) }
  } else if (msg.type === 'tool_result') {
    process.send({ type: 'text', id: lastId, content: 'tool said: ' + msg.output })
    process.send({ type: 'done', id: lastId })
  }
})
process.on('disconnect', () => process.exit(0))
`

let dir: string
let engine: GgufEngine

afterEach(() => {
  engine?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-'))
  const worker = path.join(dir, 'fake-worker.cjs')
  fs.writeFileSync(worker, FAKE_WORKER)
  const log = path.join(dir, 'gguf.log')
  engine = new GgufEngine(worker, log)
  return { log }
}

async function chat(content: string, extra: Partial<Parameters<GgufEngine['chat']>[0]> = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of engine.chat({ modelPath: 'model.gguf', messages: [{ role: 'user', content }], temperature: 0.7, maxTokens: 10, signal: new AbortController().signal, ...extra })) events.push(e)
  return events
}

describe('GgufEngine process isolation', () => {
  it('streams a reply from the child process', async () => {
    setup()
    expect(await chat('hello')).toEqual([{ type: 'text', content: 'echo: hello' }])
  })

  it('survives a crashed engine process, reports it, and respawns for the next message', async () => {
    const { log } = setup()
    expect(await chat('first')).toEqual([{ type: 'text', content: 'echo: first' }])

    const crashed = await chat('crash')
    expect(crashed).toHaveLength(1)
    expect(crashed[0]).toMatchObject({ type: 'error' })
    expect((crashed[0] as { error: string }).error).toMatch(/аварийно/)
    expect((crashed[0] as { error: string }).error).toContain(log)

    // The host process is alive and the engine starts a fresh child.
    expect(await chat('again')).toEqual([{ type: 'text', content: 'echo: again' }])
    expect(fs.readFileSync(log, 'utf8')).toContain('process exited')
  })

  it('tells a memory fault (corrupt/unsupported model) apart from running out of memory', async () => {
    setup()
    const fault = (await chat('crash'))[0] as { error: string }
    expect(fault.error).toMatch(/доступа к памяти/)
    expect(fault.error).toMatch(/draft/)
    const oom = (await chat('oom'))[0] as { error: string }
    expect(oom.error).toMatch(/не хватило памяти/)
  })

  it('bridges tool requests to the caller and back', async () => {
    setup()
    const seen: string[] = []
    const events = await chat('tool', {
      runTool: async (call) => { seen.push(`${call.name}:${JSON.stringify(call.arguments)}`); return { output: 'file contents', isError: false } },
      summarize: (call) => `Чтение ${call.name}`,
    })
    expect(seen).toEqual(['read_file:{"path":"a.txt"}'])
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_result', 'text'])
    expect(events[2]).toMatchObject({ content: 'tool said: file contents' })
  })
})
