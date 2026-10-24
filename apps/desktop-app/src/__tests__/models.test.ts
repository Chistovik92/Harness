import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { buildProfile, parametersFromName } from '../renderer/lib/modelProfile'
import { HfAuth, pkcePair, authorizeUrl, HF_CLIENT_ID, type StoredAuth } from '../electron/hfAuth'
import { EncryptedStore } from '../electron/store'
import { generateKey } from '../electron/secureStore'
import { listGgufFiles, downloadHubFile, profileFromRecord } from '../electron/hfHub'

describe('model profiles', () => {
  it('rates Russian by family and downgrades small models', () => {
    const big = buildProfile({ id: 'Qwen/Qwen2.5-7B-Instruct', runtime: 'gguf', parameters: 7.6e9, languages: ['en'] })
    expect(big.russian).toBe('good')
    expect(big.strengths).toEqual(expect.arrayContaining(['coding', 'chat', 'writing', 'tools', 'multilingual']))

    const small = buildProfile({ id: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', runtime: 'gguf', parameters: 1.78e9, languages: ['en'] })
    expect(small.russian).toBe('fair')
    expect(small.strengths).not.toContain('tools')
    expect(small.tier).toBe('light')
  })

  it('knows weak and unsupported cases', () => {
    expect(buildProfile({ id: 'Xenova/gpt2', runtime: 'onnx' }).russian).toBe('none')
    expect(buildProfile({ id: 'HuggingFaceTB/SmolLM2-135M-Instruct', runtime: 'onnx', parameters: 135e6 })).toMatchObject({ russian: 'none', tier: 'demo' })
    expect(buildProfile({ id: 'meta-llama/Llama-3.1-8B-Instruct', runtime: 'gguf' }).russian).toBe('fair')
    expect(buildProfile({ id: 'microsoft/Phi-3-mini-4k-instruct', runtime: 'gguf' }).russian).toBe('weak')
    expect(buildProfile({ id: 'someone/unknown-model', runtime: 'gguf' }).russian).toBe('unknown')
  })

  it('detects Russian-tuned models, code, vision and cloud models', () => {
    expect(buildProfile({ id: 'IlyaGusev/saiga_llama3_8b', runtime: 'gguf' }).russian).toBe('native')
    expect(buildProfile({ id: 'Qwen/Qwen2.5-Coder-7B-Instruct', runtime: 'gguf' }).strengths).toContain('coding')
    expect(buildProfile({ id: 'x/some-vl-model', runtime: 'gguf', pipelineTag: 'image-text-to-text' }).strengths).toContain('vision')
    const claude = buildProfile({ id: 'claude-3-5-sonnet-20241022', runtime: 'cloud', contextLength: 200000 })
    expect(claude).toMatchObject({ russian: 'native', runtime: 'cloud', contextLength: 200000 })
    expect(claude.strengths).toEqual(expect.arrayContaining(['writing', 'coding', 'tools', 'vision']))
    expect(claude.tier).toBeUndefined()
  })

  it('uses the card as an extra signal and reads the base model of quantised repos', () => {
    const p = profileFromRecord({ id: 'bartowski/Qwen2.5-32B-Instruct-GGUF', tags: ['gguf', 'chat', 'base_model:Qwen/Qwen2.5-32B-Instruct', 'base_model:quantized:Qwen/Qwen2.5-32B-Instruct', 'license:apache-2.0'], cardData: { language: ['en', 'ru'] }, gguf: { total: 32.7e9, context_length: 32768 } }, 'gguf')
    expect(p).toMatchObject({ russian: 'good', parameters: 32.7e9, contextLength: 32768, license: 'apache-2.0', tier: 'strong' })
    expect(p.languages).toContain('ru')
  })

  it('parses parameter counts from names', () => {
    expect(parametersFromName('Qwen2.5-1.5B-Instruct')).toBe(1.5e9)
    expect(parametersFromName('SmolLM2-135M')).toBe(135e6)
    expect(parametersFromName('gpt2')).toBeUndefined()
  })
})

describe('Hugging Face sign-in (PKCE)', () => {
  let dir: string
  let store: EncryptedStore<StoredAuth>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-'))
    const key = generateKey()
    store = new EncryptedStore<StoredAuth>(path.join(dir, 'auth.enc.json'), async () => key, () => null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const callback = (redirect: string, params: Record<string, string>) =>
    new Promise<void>((resolve) => {
      const url = new URL(redirect)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      http.get(url, (res) => { res.resume(); res.on('end', () => resolve()) })
    })

  it('creates a valid S256 challenge and authorize URL', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
    const url = new URL(authorizeUrl('http://127.0.0.1:1/callback', 'st', challenge))
    expect(url.searchParams.get('client_id')).toBe(HF_CLIENT_ID)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('read-repos')
  })

  it('completes the flow, ignores a forged state, stores tokens encrypted and refreshes them', async () => {
    let tokenBody = new URLSearchParams()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/oauth/token')) {
        tokenBody = new URLSearchParams(String(init?.body))
        const refresh = tokenBody.get('grant_type') === 'refresh_token'
        return new Response(JSON.stringify({ access_token: refresh ? 'token-2' : 'token-1', refresh_token: 'refresh-1', expires_in: refresh ? 3600 : 0 }), { status: 200 })
      }
      if (target.endsWith('/oauth/userinfo')) return new Response(JSON.stringify({ preferred_username: 'tester', name: 'Test User' }))
      throw new Error(`unexpected fetch ${target}`)
    }))

    let challenge = ''
    const auth = new HfAuth(store, async (authorize) => {
      const params = new URL(authorize).searchParams
      challenge = params.get('code_challenge') ?? ''
      const redirect = params.get('redirect_uri')!
      // A forged request must not complete the login; the genuine one does.
      await callback(redirect, { code: 'evil', state: 'wrong' })
      await callback(redirect, { code: 'good-code', state: params.get('state')! })
    }, 0)

    const status = await auth.login()
    expect(status).toMatchObject({ loggedIn: true, user: { name: 'tester' } })
    expect(tokenBody.get('code')).toBe('good-code')
    expect(crypto.createHash('sha256').update(tokenBody.get('code_verifier')!).digest('base64url')).toBe(challenge)
    expect(tokenBody.get('client_id')).toBe(HF_CLIENT_ID)
    expect(tokenBody.has('client_secret')).toBe(false)

    const raw = fs.readFileSync(path.join(dir, 'auth.enc.json'), 'utf8')
    expect(raw).not.toContain('token-1')

    // expires_in was 0, so the next getToken refreshes.
    expect(await auth.getToken()).toBe('token-2')
    expect(tokenBody.get('grant_type')).toBe('refresh_token')

    await auth.logout()
    expect(await auth.status()).toEqual({ loggedIn: false })
    expect(await auth.getToken()).toBeNull()
  })

  it('reports a rejected token exchange and an access_denied callback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid code' }), { status: 400 })))
    const rejected = new HfAuth(store, async (authorize) => {
      const params = new URL(authorize).searchParams
      await callback(params.get('redirect_uri')!, { code: 'x', state: params.get('state')! })
    }, 0)
    await expect(rejected.login()).rejects.toThrow(/Invalid code/)

    const denied = new HfAuth(store, async (authorize) => {
      const params = new URL(authorize).searchParams
      await callback(params.get('redirect_uri')!, { error: 'access_denied', error_description: 'User refused' })
    }, 0)
    await expect(denied.login()).rejects.toThrow(/User refused/)
  })
})

describe('GGUF hub client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists quantisations, groups shards and hides projector files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { type: 'file', path: 'model-Q4_K_M.gguf', size: 100, lfs: { size: 1000 } },
      { type: 'file', path: 'model-Q2_K.gguf', size: 100, lfs: { size: 500 } },
      { type: 'file', path: 'big/model-Q8_0-00002-of-00002.gguf', lfs: { size: 3000 } },
      { type: 'file', path: 'big/model-Q8_0-00001-of-00002.gguf', lfs: { size: 4000 } },
      { type: 'file', path: 'mmproj-model-f16.gguf', lfs: { size: 10 } },
      { type: 'file', path: 'README.md', size: 5 },
    ]))))
    const files = await listGgufFiles('org/repo')
    expect(files.map((f) => [f.quant, f.size])).toEqual([['Q2_K', 500], ['Q4_K_M', 1000], ['Q8_0', 7000]])
    const sharded = files.find((f) => f.quant === 'Q8_0')!
    expect(sharded.parts).toEqual(['big/model-Q8_0-00001-of-00002.gguf', 'big/model-Q8_0-00002-of-00002.gguf'])
    expect(sharded.file).toBe(sharded.parts[0])
    await expect(listGgufFiles('../evil')).rejects.toThrow()
  })

  it('resumes an interrupted download with a Range request and finishes atomically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-'))
    try {
      const destination = path.join(dir, 'org', 'repo', 'm.gguf')
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(`${destination}.part`, 'abcd')
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).Range).toBe('bytes=4-')
        return new Response('efghij', { status: 206, headers: { 'content-length': '6' } })
      })
      vi.stubGlobal('fetch', fetchMock)
      const progress = vi.fn()
      await downloadHubFile({ repoId: 'org/repo', file: 'm.gguf', destination, token: 'tok', onProgress: progress })
      expect(fs.readFileSync(destination, 'utf8')).toBe('abcdefghij')
      expect(fs.existsSync(`${destination}.part`)).toBe(false)
      expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
      expect(progress).toHaveBeenLastCalledWith({ file: 'm.gguf', loaded: 10, total: 10 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('explains access errors and rejects traversal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-'))
    try {
      await expect(downloadHubFile({ repoId: 'org/repo', file: 'm.gguf', destination: path.join(dir, 'm.gguf') })).rejects.toThrow(/войдите/i)
      await expect(downloadHubFile({ repoId: 'org/repo', file: '../m.gguf', destination: path.join(dir, 'x.gguf') })).rejects.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
