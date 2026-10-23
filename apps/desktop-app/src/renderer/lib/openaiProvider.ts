/**
 * OpenAI-compatible provider (DeepSeek, OpenAI, Groq, Together, OpenRouter, etc.)
 * Uses the standard /v1/chat/completions endpoint with SSE streaming.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'

export class OpenAICompatibleProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind = 'openai-compatible'

  constructor(config: ProviderConfig) {
    super()
    this.id = config.id
    this.name = config.name
  }

  requiresKey() { return true }
  isConfigured(config: ProviderConfig) { return Boolean(config.apiKey) }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    // Return a hint model if we can't reach the endpoint; real models fetched lazily
    return [
      {
        id: config.defaultModel || 'gpt-3.5-turbo',
        name: config.defaultModel || 'gpt-3.5-turbo',
        provider: this.id,
        kind: this.kind,
        contextWindow: 4096,
      },
    ]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { config, model, messages, temperature = 0.7, maxTokens = 4096, signal } = opts
    if (!config.apiKey) {
      yield { type: 'error', error: 'API key not configured' }
      return
    }

    const base = config.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1'
    const url = `${base}/chat/completions`

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
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
        if (signal?.aborted) {
          reader.cancel()
          yield { type: 'done' }
          return
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const data = JSON.parse(payload)
            const delta = data.choices?.[0]?.delta?.content ?? ''
            if (delta) yield { type: 'text', content: delta }
          } catch {
            // skip unparseable
          }
        }
      }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
