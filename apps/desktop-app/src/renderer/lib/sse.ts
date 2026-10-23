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

export async function httpErrorChunk(res: Response): Promise<{ type: 'error'; error: string }> {
  const text = await res.text().catch(() => '')
  return { type: 'error', error: `HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ''}` }
}
