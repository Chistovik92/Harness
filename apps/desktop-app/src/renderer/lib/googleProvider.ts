/**
 * Google (Gemini) provider.
 * Uses :streamGenerateContent with alt=sse; the API key is sent in a header,
 * never in the URL, so it cannot leak into logs or error messages.
 * Supports function calling (functionDeclarations).
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ToolCall, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { readSSE, errorMessage, isAbortError, httpErrorChunk, resilientFetch } from './sse'
import { GOOGLE_MODELS } from './cloudModels'

type GeminiContent = { role: 'user' | 'model'; parts: Record<string, unknown>[] }

/** Adjacent `tool` results are merged into a single user turn of functionResponse parts. */
export function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name ?? 'tool', response: { result: m.content } } }
      const last = out[out.length - 1]
      if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) last.parts.push(part)
      else out.push({ role: 'user', parts: [part] })
    } else if (m.role === 'assistant') {
      const parts: Record<string, unknown>[] = []
      if (m.content) parts.push({ text: m.content })
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.arguments } })
      if (parts.length > 0) out.push({ role: 'model', parts })
    } else if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] })
    }
  }
  return out
}

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

  /**
   * Live model list from GET /v1beta/models; falls back to a curated list of
   * current models when the API is unavailable.
   */
  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const toInfo = (m: { id: string; name: string; contextWindow?: number }): ModelInfo =>
      ({ ...m, provider: this.id, kind: this.kind, contextWindow: m.contextWindow })
    const fallback = GOOGLE_MODELS.map(toInfo)
    if (!config.apiKey) return fallback
    try {
      const res = await resilientFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
        headers: { 'x-goog-api-key': config.apiKey },
      }, { timeoutMs: 20_000, retries: 0 })
      if (!res.ok) return fallback
      const data = await res.json() as { models?: any[] }
      if (!Array.isArray(data?.models)) return fallback
      const models = data.models
        .filter((m: any) => typeof m?.name === 'string' && m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => toInfo({
          id: m.name.replace(/^models\//, ''),
          name: m.displayName ?? m.name,
          contextWindow: Number(m?.inputTokenLimit) || undefined,
        }))
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
      contents: toGeminiContents(messages),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    if (tools?.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

    try {
      const res = await resilientFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok || !res.body) {
        yield await httpErrorChunk(res)
        return
      }

      const toolCalls: ToolCall[] = []
      for await (const payload of readSSE(res, signal)) {
        try {
          const parts: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] =
            JSON.parse(payload).candidates?.[0]?.content?.parts ?? []
          const text = parts.map((p) => p.text ?? '').join('')
          if (text) yield { type: 'text', content: text }
          for (const p of parts) {
            if (p.functionCall) toolCalls.push({ id: `call_${toolCalls.length}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {} })
          }
        } catch {
          // partial frame
        }
      }
      if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls }
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
