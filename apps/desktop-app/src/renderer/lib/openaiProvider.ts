/**
 * OpenAI-compatible provider (DeepSeek, OpenAI, Groq, Together, OpenRouter, etc.)
 * Uses the standard /v1/chat/completions endpoint with SSE streaming and
 * native tool calling.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ToolCall, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk, resilientFetch } from './sse'
import { DEEPSEEK_MODELS, OPENAI_MODELS, GROQ_MODELS, TOGETHER_MODELS, OPENROUTER_MODELS, RETIRED_MODEL_IDS } from './cloudModels'

/** Curated fallbacks for the well-known built-in providers. */
const FALLBACKS: Record<string, { id: string; name: string; contextWindow?: number }[]> = {
  deepseek: DEEPSEEK_MODELS,
  openai: OPENAI_MODELS,
  groq: GROQ_MODELS,
  together: TOGETHER_MODELS,
  openrouter: OPENROUTER_MODELS,
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
    }
  }
  return { role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) }
}

type PartialCall = { id: string; name: string; args: string }

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

  /**
   * Live model list from GET /models; falls back to a curated list of current
   * models for known providers (or the configured default model for custom
   * gateways) when the endpoint is unavailable.
   */
  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const toInfo = (m: { id: string; name: string; contextWindow?: number }): ModelInfo =>
      ({ ...m, provider: this.id, kind: this.kind, contextWindow: m.contextWindow })
    const fallback: ModelInfo[] = FALLBACKS[this.id]
      ? FALLBACKS[this.id].map(toInfo)
      : [{ id: config.defaultModel || this.defaultModel, name: config.defaultModel || this.defaultModel, provider: this.id, kind: this.kind, contextWindow: undefined }]
    if (!config.apiKey) return fallback
    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '')
    try {
      const res = await resilientFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      }, { timeoutMs: 20_000, retries: 0 })
      if (!res.ok) return fallback
      const data = await res.json() as unknown
      const raw: unknown = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data
      if (!Array.isArray(raw)) return fallback
      const models = raw
        .map((m: any) => ({
          id: typeof m === 'string' ? m : String(m?.id ?? ''),
          name: typeof m === 'string' ? m : String(m?.name ?? m?.id ?? ''),
          contextWindow: Number(m?.context_length ?? m?.context_window ?? m?.top_provider?.context_length) || undefined,
        }))
        .filter((m) => m.id && !RETIRED_MODEL_IDS.has(m.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(toInfo)
      return models.length > 0 ? models : fallback
    } catch {
      return fallback
    }
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { config, model, messages, temperature = 0.7, maxTokens = 4096, signal, tools } = opts
    if (!config.apiKey) {
      yield { type: 'error', error: 'API key not configured' }
      return
    }

    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '')
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toOpenAIMessage),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }

    try {
      const res = await resilientFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok || !res.body) {
        yield await httpErrorChunk(res)
        return
      }

      const calls = new Map<number, PartialCall>()
      for await (const payload of readSSE(res, signal)) {
        if (payload === '[DONE]') break
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta
          if (delta?.content) yield { type: 'text', content: delta.content }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = calls.get(tc.index ?? 0) ?? { id: '', name: '', args: '' }
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name += tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
            calls.set(tc.index ?? 0, slot)
          }
        } catch {
          // keep-alive or partial frame
        }
      }

      if (calls.size > 0) {
        const toolCalls: ToolCall[] = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([i, c]) => ({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, arguments: parseToolArguments(c.args) }))
        yield { type: 'tool_calls', toolCalls }
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
