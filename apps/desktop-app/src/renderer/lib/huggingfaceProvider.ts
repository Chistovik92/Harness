/**
 * Hugging Face provider (API + local).
 *
 * API mode: uses HF Inference API with a token.
 * Local mode: delegates to Electron main process which runs transformers.js
 * in a Node worker; results stream back via preload bridge.
 */

import { LLMProvider, type ProviderConfig, type ModelInfo, type Message, type ChatOptions, type ChatChunk, type ProviderId, type ProviderKind } from './providers'

export class HuggingFaceProvider extends LLMProvider {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind
  readonly local: boolean

  constructor(config: ProviderConfig & { local?: boolean }) {
    super()
    this.id = config.id
    this.name = config.name
    this.local = config.local === true
    this.kind = this.local ? 'huggingface-local' : 'huggingface-api'
  }

  requiresKey() { return !this.local }
  isConfigured(config: ProviderConfig) { return this.local || Boolean((config as any).apiKey) }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    if (this.local) {
      return [
        { id: 'Xenova/llama2.c-stories15M', name: 'Llama2.c Stories (15M, local)', provider: this.id, kind: this.kind, local: true, contextWindow: 2048 },
        { id: 'Xenova/gpt-2', name: 'GPT-2 (117M, local)', provider: this.id, kind: this.kind, local: true, contextWindow: 1024 },
      ]
    }
    return [
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B (HF API)', provider: this.id, kind: this.kind, contextWindow: 131072 },
      { id: 'google/gemma-2-9b-it', name: 'Gemma 2 9B (HF API)', provider: this.id, kind: this.kind, contextWindow: 8192 },
    ]
  }

  async *chat(opts: ChatOptions & { config: ProviderConfig }): AsyncGenerator<ChatChunk> {
    const { model, messages, temperature = 0.7, maxTokens = 4096, signal, config } = opts

    if (this.local) {
      const dsh = (globalThis as any).__DSH__
      if (!dsh || !dsh.hf) {
        yield { type: 'error', error: 'Local HF bridge not available in main process' }
        return
      }
      const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:'
      const streamId = crypto.randomUUID()
      yield* dsh.hf.chatLocal({
        model,
        prompt,
        temperature,
        maxTokens,
        signal,
        streamId,
      } as any)
      return
    }

    const apiKey = (config as any).apiKey
    if (!apiKey) {
      yield { type: 'error', error: 'Hugging Face token not configured' }
      return
    }

    const url = `https://api-inference.huggingface.co/models/${model}`
    const prompt = messages.map((m) => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\nAssistant:'

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { max_new_tokens: maxTokens, temperature, return_full_text: false, stream: true },
        }),
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
            const token = data.token?.text ?? data.generated_text ?? ''
            if (token) yield { type: 'text', content: token }
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
