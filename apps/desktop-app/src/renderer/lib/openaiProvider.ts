/**
 * OpenAI-compatible provider (DeepSeek, OpenAI, Groq, Together, OpenRouter, etc.)
 * Uses the standard /v1/chat/completions endpoint with SSE streaming.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk } from './sse'

export class OpenAICompatibleProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind = 'openai-compatible'
  private readonly defaultBaseUrl: string
  private readonly defaultModel: string

  constructor(config: ProviderConfig) {
    super()
    this.id = config.id
    this.name = config.name
    this.defaultBaseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
    this.defaultModel = config.defaultModel ?? 'gpt-4o-mini'
  }

  requiresKey() { return true }
  isConfigured(config: ProviderConfig) { return Boolean(config.apiKey) }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const id = config.defaultModel || this.defaultModel
    return [{ id, name: id, provider: this.id, kind: this.kind, contextWindow: 4096 }]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { config, model, messages, temperature = 0.7, maxTokens = 4096, signal } = opts
    if (!config.apiKey) {
      yield { type: 'error', error: 'API key not configured' }
      return
    }

    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '')
    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok || !res.body) {
        yield await httpErrorChunk(res)
        return
      }

      for await (const payload of readSSE(res, signal)) {
        if (payload === '[DONE]') break
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content ?? ''
          if (delta) yield { type: 'text', content: delta }
        } catch {
          // keep-alive or partial frame
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
