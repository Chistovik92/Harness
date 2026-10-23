/**
 * Google (Gemini) provider.
 * Uses the generativeLanguage API with SSE.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'

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

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${config.apiKey}`

    const body = {
      contents: messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      yield { type: 'error', error: `HTTP ${res.status}: ${text}` }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        if (signal?.aborted) { reader.cancel(); yield { type: 'done' }; return }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          try {
            const data = JSON.parse(payload)
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
            if (text) yield { type: 'text', content: text }
          } catch {
            // skip
          }
        }
      }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
