/**
 * Anthropic (Claude) provider.
 * Uses /v1/messages with SSE streaming and native tool use.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ToolCall, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk, resilientFetch } from './sse'
import { parseToolArguments } from './openaiProvider'

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }

/**
 * Anthropic wants tool results as `tool_result` blocks inside a *user* turn, and
 * consecutive results must share one turn, so adjacent `tool` messages are merged.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Record<string, unknown>[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })
      out.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

type PartialUse = { id: string; name: string; json: string }

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

  /**
   * Live model list from GET /v1/models (Anthropic added this endpoint in 2024);
   * falls back to a curated list of current models when the API is unavailable.
   */
  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const fallback: ModelInfo[] = [
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', provider: this.id, kind: this.kind, contextWindow: 200000 },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', provider: this.id, kind: this.kind, contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: this.id, kind: this.kind, contextWindow: 200000 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: this.id, kind: this.kind, contextWindow: 200000 },
    ]
    if (!config.apiKey) return fallback
    try {
      const res = await resilientFetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      }, { timeoutMs: 20_000, retries: 0 })
      if (!res.ok) return fallback
      const data = await res.json()
      if (!Array.isArray(data?.data)) return fallback
      const models = data.data
        .filter((m: any) => typeof m?.id === 'string' && m.id.startsWith('claude'))
        .map((m: any) => ({ id: m.id, name: m.display_name ?? m.id, provider: this.id, kind: this.kind, contextWindow: 200000 }))
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

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // Anthropic accepts temperature in [0, 1] only.
      temperature: Math.min(1, Math.max(0, temperature)),
      messages: toAnthropicMessages(messages),
      stream: true,
    }
    if (system) body.system = system
    if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))

    try {
      const res = await resilientFetch('https://api.anthropic.com/v1/messages', {
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

      const uses = new Map<number, PartialUse>()
      for await (const payload of readSSE(res, signal)) {
        try {
          const data = JSON.parse(payload)
          if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
            uses.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' })
          } else if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
            const use = uses.get(data.index)
            if (use) use.json += data.delta.partial_json ?? ''
          } else if (data.type === 'content_block_delta' && data.delta?.text) {
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

      if (uses.size > 0) {
        const toolCalls: ToolCall[] = [...uses.entries()].sort(([a], [b]) => a - b).map(([, u]) => ({ id: u.id, name: u.name, arguments: parseToolArguments(u.json) }))
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
