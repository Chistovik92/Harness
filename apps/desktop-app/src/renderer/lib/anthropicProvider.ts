/**
 * Anthropic (Claude) provider.
 * Uses /v1/messages with SSE streaming.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk } from './sse'

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

  async listModels(_config: ProviderConfig): Promise<ModelInfo[]> {
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
    const chatMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // Anthropic accepts temperature in [0, 1] only.
      temperature: Math.min(1, Math.max(0, temperature)),
      messages: chatMessages,
      stream: true,
    }
    if (system) body.system = system

    try {
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
        yield await httpErrorChunk(res)
        return
      }

      for await (const payload of readSSE(res, signal)) {
        try {
          const data = JSON.parse(payload)
          if (data.type === 'content_block_delta' && data.delta?.text) {
            yield { type: 'text', content: data.delta.text }
          } else if (data.type === 'error') {
            yield { type: 'error', error: data.error?.message ?? 'Anthropic stream error' }
            return
          } else if (data.type === 'message_stop') {
            break
          }
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
