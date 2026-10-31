/**
 * Provider registry — singleton holding instantiated providers keyed by provider id.
 */

import { LLMProvider, type ProviderConfig, type ProviderKind, type ModelInfo, type ChatOptions, type ChatChunk } from './providers'

class ProviderRegistry {
  private providers = new Map<string, LLMProvider>()

  register(id: string, provider: LLMProvider) {
    this.providers.set(id, provider)
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id)
  }

  all(): LLMProvider[] {
    return Array.from(this.providers.values())
  }

  byKind(kind: ProviderKind): LLMProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.kind === kind)
  }

  async listAllModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const [id, p] of this.providers.entries()) {
      try {
        const models = await p.listModels(this.configFor(id))
        out.push(...models)
      } catch {
        // skip providers that fail to list
      }
    }
    return out
  }

  async *chat(providerId: string, opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const p = this.providers.get(providerId)
    if (!p) {
      yield { type: 'error', error: `Provider ${providerId} not found` }
      return
    }
    yield* p.chat({ ...opts, config: { ...this.configFor(providerId), ...opts.config, id: p.id, kind: p.kind } })
  }

  private configFor(id: string): ProviderConfig {
    const p = this.providers.get(id)
    if (!p) throw new Error(`Provider ${id} not found`)
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      enabled: true,
    } as ProviderConfig
  }
}

export const providerRegistry = new ProviderRegistry()
