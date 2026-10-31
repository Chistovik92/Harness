import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { encrypt, decrypt, generateKey, isValidKey } from '../electron/secureStore'
import { isValidModelId } from '../electron/localHf'
import { createThinkRouter } from '../electron/thinkRouter'
import { readSSE, resilientFetch } from '../renderer/lib/sse'
import { OpenAICompatibleProvider } from '../renderer/lib/openaiProvider'
import { GoogleProvider } from '../renderer/lib/googleProvider'
import { AnthropicProvider } from '../renderer/lib/anthropicProvider'
import type { ChatChunk, ProviderConfig } from '../renderer/lib/providers'

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(body, { status })
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const cfg = (extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: 't', name: 'T', kind: 'openai-compatible', enabled: true, apiKey: 'test-key', ...extra })

afterEach(() => vi.restoreAllMocks())

describe('secureStore', () => {
  it('round-trips text including unicode', () => {
    const key = generateKey()
    const payload = encrypt('[{"apiKey":"тест-123"}]', key)
    expect(decrypt(payload, key)).toBe('[{"apiKey":"тест-123"}]')
  })

  it('rejects tampered ciphertext (auth tag is enforced)', () => {
    const key = generateKey()
    const parts = encrypt('secret', key).split('.')
    const ct = Buffer.from(parts[2], 'base64')
    ct[0] ^= 0xff
    parts[2] = ct.toString('base64')
    expect(() => decrypt(parts.join('.'), key)).toThrow()
  })

  it('rejects a wrong key and malformed payloads', () => {
    const payload = encrypt('secret', generateKey())
    expect(() => decrypt(payload, generateKey())).toThrow()
    expect(() => decrypt('garbage', generateKey())).toThrow()
    expect(isValidKey(generateKey())).toBe(true)
    expect(isValidKey(Buffer.alloc(5))).toBe(false)
  })
})

describe('readSSE', () => {
  it('handles CRLF, frames split across chunks and a trailing line without newline', async () => {
    const res = sseResponse(['data: {"a":1}\r\n\r\nda', 'ta: {"a":2}\n', 'data: [DONE]'])
    const payloads: string[] = []
    for await (const p of readSSE(res)) payloads.push(p)
    expect(payloads).toEqual(['{"a":1}', '{"a":2}', '[DONE]'])
  })
})

describe('OpenAICompatibleProvider', () => {
  it('streams text deltas and ends with done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ])))
    const p = new OpenAICompatibleProvider(cfg({ baseUrl: 'https://x.test/v1' }))
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], config: cfg() }))
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.content).join('')).toBe('Hello')
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('falls back to the provider default base URL', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAICompatibleProvider(cfg({ baseUrl: 'https://api.deepseek.com/v1' }))
    await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], config: cfg() }))
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('reports HTTP errors and network failures as error chunks instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    const p = new OpenAICompatibleProvider(cfg())
    const http = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], config: cfg() }))
    expect(http[0]).toMatchObject({ type: 'error' })
    expect(http[0].error).toContain('401')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const net = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], config: cfg() }))
    expect(net[0]).toEqual({ type: 'error', error: 'ECONNRESET' })
  })

  it('treats a user abort as a clean finish, not an error', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError') }))
    const p = new OpenAICompatibleProvider(cfg())
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], config: cfg(), signal: controller.signal }))
    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('refuses to call the API without a key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAICompatibleProvider(cfg())
    const chunks = await collect(p.chat({ model: 'm', messages: [], config: cfg({ apiKey: undefined }) }))
    expect(chunks[0]).toMatchObject({ type: 'error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GoogleProvider', () => {
  it('uses alt=sse, keeps the key out of the URL and maps roles', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const p = new GoogleProvider(cfg({ kind: 'google' }))
    const chunks = await collect(p.chat({
      model: 'gemini-1.5-flash',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }],
      config: cfg({ kind: 'google' }),
    }))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('alt=sse')
    expect(url).not.toContain('test-key')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key')
    const body = JSON.parse(String(init.body))
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model'])
    expect(body.systemInstruction.parts[0].text).toBe('s')
    expect(chunks[0]).toEqual({ type: 'text', content: 'ok' })
  })
})

describe('AnthropicProvider', () => {
  it('omits an empty system prompt and clamps temperature', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"type":"message_stop"}\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const p = new AnthropicProvider(cfg({ kind: 'anthropic' }))
    await collect(p.chat({ model: 'm', temperature: 1.8, messages: [{ role: 'user', content: 'u' }], config: cfg({ kind: 'anthropic' }) }))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect('system' in body).toBe(false)
    expect(body.temperature).toBe(1)
  })
})

describe('resilientFetch', () => {
  it('retries a 500 once and succeeds, and retries transient network errors', async () => {
    const responses = [new Response('boom', { status: 500 }), new Response('ok')]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const res = await resilientFetch('https://x.test/v1/models')
    expect(res.status).toBe(200)

    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('ok')))
    const retry = await resilientFetch('https://x.test/v1/models')
    expect(retry.status).toBe(200)
  })

  it('does not retry 4xx or a user abort, and stops after the retry budget', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await resilientFetch('https://x.test', {}, { retries: 2 })
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const fail = vi.fn(async () => { throw new Error('down') })
    vi.stubGlobal('fetch', fail)
    await expect(resilientFetch('https://x.test', {}, { retries: 1 })).rejects.toThrow('down')
    expect(fail).toHaveBeenCalledTimes(2)

    const controller = new AbortController()
    const aborting = vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError') })
    vi.stubGlobal('fetch', aborting)
    await expect(resilientFetch('https://x.test', { signal: controller.signal })).rejects.toThrow()
    expect(aborting).toHaveBeenCalledTimes(1)
  })
})

describe('dynamic model lists', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('OpenAI-compatible: reads /models, tolerates strings and a broken endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'zeta/model', context_length: 128000 },
      'plain-id',
      { id: 'alpha/model', top_provider: { context_length: 32000 } },
    ] }), { status: 200 })))
    const p = new OpenAICompatibleProvider(cfg({ baseUrl: 'https://openrouter.test/api/v1' }))
    const models = await p.listModels(cfg({ apiKey: 'k' }))
    expect(models.map((m) => m.id)).toEqual(['alpha/model', 'plain-id', 'zeta/model'])
    expect(models.find((m) => m.id === 'alpha/model')?.contextWindow).toBe(32000)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const fb = await p.listModels(cfg({ apiKey: 'k', defaultModel: 'deepseek-chat' }))
    expect(fb).toEqual([{ id: 'deepseek-chat', name: 'deepseek-chat', provider: 't', kind: 'openai-compatible', contextWindow: 4096 }])

    const noKey = await p.listModels(cfg({ apiKey: undefined, defaultModel: 'm' }))
    expect(noKey).toHaveLength(1)
  })

  it('Anthropic: lists live models and falls back to current defaults', async () => {
    const p = new AnthropicProvider(cfg({ kind: 'anthropic' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5' },
      { id: 'not-a-claude', display_name: 'X' },
    ] }), { status: 200 })))
    const live = await p.listModels(cfg({ apiKey: 'k' }))
    expect(live.map((m) => m.id)).toEqual(['claude-opus-4-5-20251101'])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const fb = await p.listModels(cfg({ apiKey: 'k' }))
    expect(fb.some((m) => m.id === 'claude-opus-4-5-20251101')).toBe(true)
    expect(fb.some((m) => m.id === 'claude-sonnet-4-5-20250929')).toBe(true)
  })

  it('Google: lists generateContent models with token limits and falls back', async () => {
    const p = new GoogleProvider(cfg({ kind: 'google' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }), { status: 200 })))
    const live = await p.listModels(cfg({ apiKey: 'k' }))
    expect(live).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 't', kind: 'google', contextWindow: 1048576 }])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const fb = await p.listModels(cfg({ apiKey: 'k' }))
    expect(fb.some((m) => m.id === 'gemini-2.5-pro')).toBe(true)
    expect(fb.some((m) => m.id === 'gemini-1.5-pro')).toBe(true)
  })
})

describe('isValidModelId', () => {
  it('accepts org/name ids and rejects path traversal', () => {
    expect(isValidModelId('Xenova/gpt2')).toBe(true)
    expect(isValidModelId('../etc/passwd')).toBe(false)
    expect(isValidModelId('../evil')).toBe(false)
    expect(isValidModelId('org/..')).toBe(false)
    expect(isValidModelId('a/b/c')).toBe(false)
    expect(isValidModelId(42)).toBe(false)
  })
})

describe('createThinkRouter', () => {
  const run = (chunks: string[]) => {
    const text: string[] = []
    const thought: string[] = []
    const router = createThinkRouter((t) => text.push(t), (t) => thought.push(t))
    for (const c of chunks) router.push(c)
    router.flush()
    return { text: text.join(''), thought: thought.join('') }
  }

  it('passes plain answers through untouched', () => {
    expect(run(['Hello', ' world'])).toEqual({ text: 'Hello world', thought: '' })
  })

  it('moves a leading think block to thoughts, even when tags are split across chunks', () => {
    expect(run(['<th', 'ink>I should ', 'add numbers</th', 'ink>51'])).toEqual({ text: '51', thought: 'I should add numbers' })
    expect(run(['\n<think>\n\n</think>\n\nAnswer'])).toEqual({ text: '\n\nAnswer', thought: '' })
  })

  it('does not swallow text that merely starts like a tag, and flushes unfinished thoughts', () => {
    expect(run(['<th', 'at is odd'])).toEqual({ text: '<that is odd', thought: '' })
    expect(run(['<think>unfinished reasoning'])).toEqual({ text: '', thought: 'unfinished reasoning' })
  })
})

describe('runtime requirements', () => {
  it('ships an Electron whose Node understands import attributes (needed by node-llama-cpp)', () => {
    // Electron < 31 bundles Node < 20.10: importing node-llama-cpp there fails with
    // "SyntaxError: Unexpected token 'with'" and local GGUF chat never starts.
    const pkg = JSON.parse(fs.readFileSync(path.resolve('node_modules/electron/package.json'), 'utf8')) as { version: string }
    expect(Number(pkg.version.split('.')[0])).toBeGreaterThanOrEqual(33)
  })
})
