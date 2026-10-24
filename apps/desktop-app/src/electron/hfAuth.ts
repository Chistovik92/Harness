/**
 * "Sign in with Hugging Face": OAuth 2.0 authorization code flow with PKCE
 * (a public client — no secret is embedded in the app). The browser is opened
 * through the system, the code comes back to a loopback server on 127.0.0.1,
 * and tokens are stored encrypted.
 *
 * The token gives access to gated/private models and to Inference Providers.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import type { EncryptedStore } from './store'

export const HF_CLIENT_ID = 'adcbb717-e9f1-430a-8c75-679832fb6f41'
export const HF_REDIRECT_PORT = 53682
export const HF_SCOPES = 'openid profile read-repos inference-api'

const AUTHORIZE_URL = 'https://huggingface.co/oauth/authorize'
const TOKEN_URL = 'https://huggingface.co/oauth/token'
const USERINFO_URL = 'https://huggingface.co/oauth/userinfo'
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000
const REFRESH_MARGIN_MS = 60 * 1000

export type HfUser = { name: string; fullName?: string; avatar?: string }
export type StoredAuth = { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string; user?: HfUser } | null
export type AuthStatus = { loggedIn: boolean; user?: HfUser }

const base64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(48))
  return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', HF_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', HF_SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0f172a;color:#f1f5f9;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>${title}</h1><p>${text}</p></div>`

export class HfAuth {
  constructor(
    private readonly store: EncryptedStore<StoredAuth>,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly port: number = HF_REDIRECT_PORT,
  ) {}

  async status(): Promise<AuthStatus> {
    const auth = await this.store.read()
    return auth ? { loggedIn: true, user: auth.user } : { loggedIn: false }
  }

  /** A valid access token (refreshed when about to expire), or null when signed out. */
  async getToken(): Promise<string | null> {
    const auth = await this.store.read()
    if (!auth) return null
    if (auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken
    if (!auth.refreshToken) { await this.store.clear(); return null }
    try {
      const refreshed = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: HF_CLIENT_ID })
      const next: StoredAuth = { ...auth, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? auth.refreshToken, expiresAt: refreshed.expiresAt }
      await this.store.update(() => ({ value: next, result: undefined }))
      return next.accessToken
    } catch (err) {
      console.error('Hugging Face token refresh failed:', err)
      await this.store.clear()
      return null
    }
  }

  async logout(): Promise<void> {
    await this.store.clear()
  }

  async login(signal?: AbortSignal): Promise<AuthStatus> {
    const { verifier, challenge } = pkcePair()
    const state = base64url(crypto.randomBytes(16))
    const { code, redirectUri } = await this.waitForCode(state, challenge, signal)

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: HF_CLIENT_ID, code_verifier: verifier,
    })
    const user = await this.fetchUser(tokens.accessToken).catch(() => undefined)
    await this.store.update(() => ({ value: { ...tokens, user }, result: undefined }))
    return { loggedIn: true, user }
  }

  private waitForCode(state: string, challenge: string, signal?: AbortSignal): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const server = http.createServer()
      const finish = (error?: Error, value?: { code: string; redirectUri: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        // Let the browser receive the final page before the socket goes away.
        setTimeout(() => server.close(), 500).unref?.()
        if (error) reject(error)
        else resolve(value!)
      }
      const onAbort = () => finish(new Error('Вход отменён'))
      const timer = setTimeout(() => finish(new Error('Время ожидания входа истекло')), LOGIN_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })

      server.on('error', (err: NodeJS.ErrnoException) => finish(new Error(err.code === 'EADDRINUSE'
        ? `Порт ${this.port} занят другой программой: закройте её и повторите вход`
        : `Не удалось запустить локальный сервер входа: ${err.message}`)))

      server.on('request', (req, res) => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : this.port
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`)
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return }

        const respond = (status: number, title: string, text: string) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(PAGE(title, text))
        }
        const error = url.searchParams.get('error')
        if (error) { respond(400, 'Вход не выполнен', url.searchParams.get('error_description') ?? error); finish(new Error(`Hugging Face: ${url.searchParams.get('error_description') ?? error}`)); return }
        if (url.searchParams.get('state') !== state) { respond(400, 'Некорректный запрос', 'Неверный параметр state.'); return }
        const code = url.searchParams.get('code')
        if (!code) { respond(400, 'Некорректный запрос', 'Нет кода авторизации.'); return }
        respond(200, 'Готово', 'Вход выполнен. Можно закрыть эту вкладку и вернуться в DeepSeek Harness.')
        finish(undefined, { code, redirectUri: `http://127.0.0.1:${actualPort}/callback` })
      })

      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : this.port
        this.openExternal(authorizeUrl(`http://127.0.0.1:${actualPort}/callback`, state, challenge)).catch((err) => finish(new Error(`Не удалось открыть браузер: ${err.message}`)))
      })
    })
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; scope?: string }> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
    if (!res.ok || !body.access_token) {
      throw new Error(`Hugging Face отклонил запрос токена: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`)
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope,
    }
  }

  private async fetchUser(accessToken: string): Promise<HfUser> {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`userinfo HTTP ${res.status}`)
    const info = (await res.json()) as { preferred_username?: string; name?: string; picture?: string }
    return { name: info.preferred_username ?? info.name ?? 'Hugging Face', fullName: info.name, avatar: info.picture }
  }
}
