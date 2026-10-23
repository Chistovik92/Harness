/**
 * Google (Gemini) provider.
 * Uses :streamGenerateContent with alt=sse; the API key is sent in a header,
 * never in the URL, so it cannot leak into logs or error messages.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk } from './sse'

export class GoogleProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind = 'google'

  constructor(config: ProviderConfig) {
    super()
    this.id = config.id
    this.name = config.name
  }

  requiresKey() { return true }
  isConfigured(config: ProviderConfig) { return Boolean(config.apiKey) }

  async listModels(_config: ProviderConfig): Promise<ModelInfo[]> {
    return [
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: this.id, kind: this.kind, contextWindow: 2000000 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: this.id, kind: this.kind, contextWindow: 1000000 },
    ]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { config, model, messages, temperature = 0.7, maxTokens = 4096, signal } = opts
    if (!config.apiKey) {
      yield { type: 'error', error: 'API key not configured' }
      return
    }

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const body: Record<string, unknown> = {
      contents: messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok || !res.body) {
        yield await httpErrorChunk(res)
        return
      }

      for await (const payload of readSSE(res, signal)) {
        try {
          const parts: { text?: string }[] = JSON.parse(payload).candidates?.[0]?.content?.parts ?? []
          const text = parts.map((p) => p.text ?? '').join('')
          if (text) yield { type: 'text', content: text }
        } catch {
          // partial frame
        }
      }
      yield { type: 'done' }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        yield { type: 'done' }
        return
      }
      yield { type: 'error', error: errorMessage(err) }
    }
  }
}
