/**
 * Hugging Face provider (API + local).
 *
 * API mode: Hugging Face Inference Providers router, which speaks the
 * OpenAI-compatible chat-completions protocol, so it reuses that provider.
 * Local mode: executed by the Electron main process (see electron/localHf.ts);
 * this class only describes the available local models.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'
import { OpenAICompatibleProvider } from './openaiProvider'

const HF_ROUTER_URL = 'https://router.huggingface.co/v1'

export class HuggingFaceProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind
  readonly local: boolean
  private readonly api: OpenAICompatibleProvider

  constructor(config: ProviderConfig & { local?: boolean }) {
    super()
    this.id = config.id
    this.name = config.name
    this.local = config.local === true
    this.kind = this.local ? 'huggingface-local' : 'huggingface-api'
    this.api = new OpenAICompatibleProvider({ ...config, baseUrl: HF_ROUTER_URL, kind: 'openai-compatible' })
  }

  requiresKey() { return !this.local }
  isConfigured(config: ProviderConfig) { return this.local || Boolean(config.apiKey) }

  async listModels(_config: ProviderConfig): Promise<ModelInfo[]> {
    if (this.local) {
      return [
        { id: 'Xenova/llama2.c-stories15M', name: 'Llama2.c Stories (15M, local)', provider: this.id, kind: this.kind, local: true, contextWindow: 2048 },
        { id: 'Xenova/gpt2', name: 'GPT-2 (117M, local)', provider: this.id, kind: this.kind, local: true, contextWindow: 1024 },
      ]
    }
    return [
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B (HF API)', provider: this.id, kind: this.kind, contextWindow: 131072 },
      { id: 'google/gemma-2-9b-it', name: 'Gemma 2 9B (HF API)', provider: this.id, kind: this.kind, contextWindow: 8192 },
    ]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    if (this.local) {
      yield { type: 'error', error: 'Local Hugging Face models are executed by the main process' }
      return
    }
    if (!opts.config.apiKey) {
      yield { type: 'error', error: 'Войдите в аккаунт Hugging Face (раздел «Локальные модели») или добавьте токен в «Провайдеры API»' }
      return
    }
    yield* this.api.chat({ ...opts, config: { ...opts.config, baseUrl: HF_ROUTER_URL } })
  }
}
