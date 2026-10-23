/**
 * DeepSeek Harness Desktop — Unified LLM Provider layer.
 *
 * Supports:
 * - OpenAI-compatible APIs (DeepSeek, OpenAI, Groq, Together, OpenRouter, etc.)
 * - Anthropic (Claude)
 * - Google (Gemini)
 * - Hugging Face (Inference API + local Transformers.js models)
 *
 * Keys are stored locally in Electron userData (encrypted at rest) and never leave the machine.
 */

export type ProviderId = string

export type ProviderKind =
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'huggingface-api'
  | 'huggingface-local'

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export type ModelInfo = {
  id: string
  name: string
  provider: ProviderId
  kind: ProviderKind
  contextWindow?: number
  local?: boolean        // true if model runs locally (HF local)
  downloaded?: boolean   // HF local model present on disk
}

export type ProviderConfig = {
  id: ProviderId
  name: string
  kind: ProviderKind
  apiKey?: string        // stored encrypted locally
  baseUrl?: string       // for openai-compatible
  defaultModel?: string
  enabled: boolean
}

export type ChatOptions = {
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  signal?: AbortSignal
}

export type ChatChunk = {
  type: 'text' | 'done' | 'error'
  content?: string
  error?: string
}

export abstract class LLMProvider {
  abstract readonly id: ProviderId
  abstract readonly name: string
  abstract readonly kind: ProviderKind

  abstract requiresKey(): boolean
  abstract isConfigured(config: ProviderConfig): boolean

  abstract listModels(config: ProviderConfig): Promise<ModelInfo[]>
  abstract chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk>
}

const providers = new Map<ProviderKind, (config: ProviderConfig) => LLMProvider>()

export function registerProvider(kind: ProviderKind, factory: (config: ProviderConfig) => LLMProvider) {
  providers.set(kind, factory)
}

export function createProvider(kind: ProviderKind, config: ProviderConfig): LLMProvider | undefined {
  const factory = providers.get(kind)
  if (!factory) return undefined
  return factory(config)
}

export function availableKinds(): ProviderKind[] {
  return Array.from(providers.keys())
}
