/**
 * Minimal Server-Sent Events reader shared by all HTTP providers.
 *
 * Yields the payload of every `data:` line. Handles CRLF line endings,
 * multi-chunk lines, a trailing line without a final newline and abort.
 */

export async function* readSSE(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const onAbort = () => { reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = parseDataLine(line)
        if (payload !== null) yield payload
      }
    }
    buffer += decoder.decode()
    const tail = parseDataLine(buffer)
    if (tail !== null) yield tail
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function parseDataLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))
}

export type ResilientFetchOptions = {
  /** Limit on time-to-first-byte (response headers); the body stream itself is not limited. */
  timeoutMs?: number
  /** Extra attempts after 429/5xx or a network error. */
  retries?: number
}

/**
 * fetch with a connect timeout and one retry on 429/5xx or a transient network
 * error. A user abort (`init.signal`) is never retried and rethrows immediately.
 */
export async function resilientFetch(url: string, init: RequestInit = {}, opts: ResilientFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 60_000, retries = 1 } = opts
  for (let attempt = 0; ; attempt++) {
    const timeout = new AbortController()
    const onOuterAbort = () => timeout.abort()
    init.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: timeout.signal })
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.body?.cancel().catch(() => {})
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        attempt++
        continue
      }
      return res
    } catch (err) {
      if (init.signal?.aborted) throw err
      if (attempt < retries) {
        attempt++
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

export async function httpErrorChunk(res: Response): Promise<{ type: 'error'; error: string }> {
  const text = await res.text().catch(() => '')
  return { type: 'error', error: `HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ''}` }
}
