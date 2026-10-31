/**
 * Curated fallback model lists for cloud providers, current as of October 2026.
 * Used when a provider's live /models endpoint is unavailable (no key yet,
 * offline, non-standard gateway). Live lists from the API always win.
 */

export type FallbackModel = { id: string; name: string; contextWindow?: number }

/** DeepSeek: V4 family (deepseek-chat / deepseek-reasoner were retired 2026-07-24). */
export const DEEPSEEK_MODELS: FallbackModel[] = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (флагман)', contextWindow: 163840 },
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 163840 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 163840 },
]

export const OPENAI_MODELS: FallbackModel[] = [
  { id: 'gpt-6.1', name: 'GPT-6.1 (актуальный флагман)', contextWindow: 400000 },
  { id: 'gpt-6', name: 'GPT-6', contextWindow: 400000 },
  { id: 'gpt-5.1', name: 'GPT-5.1 (предыдущее поколение)', contextWindow: 400000 },
  { id: 'gpt-5-mini', name: 'GPT-5 mini (дешёвая)', contextWindow: 400000 },
]

export const ANTHROPIC_MODELS: FallbackModel[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (флагман)', contextWindow: 200000 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 200000 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (быстрая)', contextWindow: 200000 },
]

export const GOOGLE_MODELS: FallbackModel[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)', contextWindow: 1048576 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)', contextWindow: 1048576 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1048576 },
]

export const GROQ_MODELS: FallbackModel[] = [
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', contextWindow: 131072 },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', contextWindow: 131072 },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', contextWindow: 131072 },
]

export const TOGETHER_MODELS: FallbackModel[] = [
  { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct', contextWindow: 131072 },
  { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 131072 },
  { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B A22B', contextWindow: 131072 },
]

export const OPENROUTER_MODELS: FallbackModel[] = [
  { id: 'openrouter/auto', name: 'Auto (лучший доступный)', contextWindow: 2000000 },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5 (OR)', contextWindow: 200000 },
  { id: 'openai/gpt-6.1', name: 'GPT-6.1 (OR)', contextWindow: 400000 },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro (OR)', contextWindow: 1048576 },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (OR)', contextWindow: 163840 },
]

export const HUGGINGFACE_API_MODELS: FallbackModel[] = [
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B (HF API)', contextWindow: 131072 },
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B (HF API)', contextWindow: 131072 },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B (HF API)', contextWindow: 32768 },
]

export const DEFAULT_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-pro',
  openai: 'gpt-6.1',
  anthropic: 'claude-opus-5-5',
  google: 'gemini-3-pro-preview',
  groq: 'meta-llama/llama-4-maverick-17b-128e-instruct',
  together: 'moonshotai/Kimi-K2-Instruct',
  openrouter: 'openrouter/auto',
  'huggingface-api': 'meta-llama/Llama-3.3-70B-Instruct',
}

/** Model ids that no longer exist and must never be suggested again. */
export const RETIRED_MODEL_IDS = new Set(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'claude-2.1', 'claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022', 'gpt-3.5-turbo', 'gpt-4o-mini'])
