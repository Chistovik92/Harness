/**
 * Anthropic (Claude) provider.
 * Uses /v1/messages with SSE streaming.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'

export class AnthropicProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind = 'anthropic'

  constructor(config: ProviderConfig) {
    super()
    this.id = config.id
    this.name = config.name
  }

  requiresKey() { return true }
  isConfigured(config: ProviderConfig) { return Boolean(config.apiKey) }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    return [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: this.id, kind: this.kind, contextWindow: 200000 },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', provider: this.id, kind: this.kind, contextWindow: 200000 },
    ]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { config, model, messages, temperature = 0.7, maxTokens = 4096, signal } = opts
    if (!config.apiKey) {
      yield { type: 'error', error: 'API key not configured' }
      return
    }

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const chatMessages = messages.filter((m) => m.role !== 'system')

    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
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
        if (signal?.aborted) { reader.cancel(); yield { type: 'done' }; return }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          try {
            const data = JSON.parse(payload)
            if (data.type === 'content_block_delta' && data.delta?.text) {
              yield { type: 'text', content: data.delta.text }
            }
            if (data.type === 'message_stop') yield { type: 'done' }
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
