/**
 * Model profiles: how well a model handles Russian and what it is good at.
 *
 * Hugging Face cards are unreliable for this (multilingual models often list
 * only `en`), so the estimate combines a curated table of model families with
 * the model size and the tags/metadata the hub provides. It is an estimate,
 * not a benchmark result, and the UI says so.
 */

export type RussianLevel = 'native' | 'good' | 'fair' | 'weak' | 'none' | 'unknown'
export type Strength = 'chat' | 'writing' | 'coding' | 'reasoning' | 'math' | 'tools' | 'vision' | 'audio' | 'multilingual' | 'embedding'
export type Tier = 'demo' | 'light' | 'capable' | 'strong' | 'large'
export type Runtime = 'cloud' | 'onnx' | 'gguf'

export type ModelProfile = {
  runtime: Runtime
  russian: RussianLevel
  russianNote: string
  strengths: Strength[]
  tier?: Tier
  tierNote?: string
  parameters?: number
  contextLength?: number
  license?: string
  /** Languages declared in the model card (often incomplete). */
  languages?: string[]
  vendor?: string
  /** Approximate memory needed to run a 4-bit build, in GB. */
  memoryGb?: number
  /** Where the estimate comes from. */
  basis: 'family' | 'metadata'
}

export type ProfileInput = {
  id: string
  runtime: Runtime
  baseModel?: string
  tags?: string[]
  languages?: string[]
  license?: string
  pipelineTag?: string
  parameters?: number
  contextLength?: number
}

type Family = {
  pattern: RegExp
  vendor: string
  russian: RussianLevel
  note: string
  strengths?: Strength[]
}

// Order matters: the first matching family wins, so specific entries come first.
const FAMILIES: Family[] = [
  { pattern: /saiga|vikhr|ruadapt|t-lite|t-pro|gigachat|yandexgpt|rugpt|sbert_large_nlu_ru|ru-?bert|\bru[-_]/i, vendor: 'Русскоязычные команды', russian: 'native', note: 'Дообучена на русскоязычных данных', strengths: ['chat', 'writing'] },
  { pattern: /\baya[-_]?(expanse|23|vision)?/i, vendor: 'Cohere For AI', russian: 'good', note: 'Aya обучена на 23 языках, включая русский', strengths: ['multilingual', 'chat', 'writing'] },
  { pattern: /qwen3|qwq|qwen2\.5|qwen2|qwen1\.5|qwen-?vl|qwen/i, vendor: 'Alibaba Qwen', russian: 'good', note: 'Заявлена поддержка 29+ языков, включая русский', strengths: ['multilingual', 'coding', 'math', 'tools', 'chat'] },
  { pattern: /gemma[-_ ]?3|gemma[-_ ]?2|gemma|paligemma|codegemma/i, vendor: 'Google Gemma', russian: 'good', note: 'Gemma 3 заявляет 140+ языков; Gemma 2 хорошо справляется с русским', strengths: ['multilingual', 'chat', 'writing'] },
  { pattern: /deepseek[-_]?coder/i, vendor: 'DeepSeek', russian: 'fair', note: 'Модель для кода: русский понимает, но пишет хуже', strengths: ['coding'] },
  { pattern: /deepseek[-_]?(r1|v3|v2\.5|v2|chat|reasoner)/i, vendor: 'DeepSeek', russian: 'good', note: 'Уверенно понимает и пишет по-русски', strengths: ['coding', 'reasoning', 'math', 'chat', 'tools'] },
  { pattern: /gpt-?oss/i, vendor: 'OpenAI', russian: 'good', note: 'Мультиязычная модель, русский на хорошем уровне', strengths: ['reasoning', 'tools', 'coding', 'chat'] },
  { pattern: /gpt-?4|gpt-?5|\bo[134]\b|chatgpt/i, vendor: 'OpenAI', russian: 'native', note: 'Очень хороший русский, близкий к родному', strengths: ['chat', 'writing', 'coding', 'reasoning', 'tools', 'vision', 'multilingual'] },
  { pattern: /claude/i, vendor: 'Anthropic', russian: 'native', note: 'Очень хороший русский, близкий к родному', strengths: ['writing', 'coding', 'reasoning', 'tools', 'vision', 'chat', 'multilingual'] },
  { pattern: /gemini/i, vendor: 'Google', russian: 'native', note: 'Очень хороший русский, близкий к родному', strengths: ['chat', 'multilingual', 'vision', 'coding', 'tools', 'audio'] },
  { pattern: /mistral[-_]?(nemo|small|large)|ministral|pixtral|magistral|devstral|codestral/i, vendor: 'Mistral AI', russian: 'good', note: 'Более новые модели Mistral поддерживают русский', strengths: ['chat', 'coding', 'tools'] },
  { pattern: /mistral|mixtral/i, vendor: 'Mistral AI', russian: 'fair', note: 'Старые модели Mistral в основном европейские языки; русский с ошибками', strengths: ['chat', 'coding'] },
  { pattern: /llama[-_ ]?4/i, vendor: 'Meta Llama', russian: 'good', note: 'Llama 4 мультиязычна, русский поддерживается', strengths: ['chat', 'multilingual', 'vision', 'tools'] },
  { pattern: /codellama|code-?llama/i, vendor: 'Meta Llama', russian: 'weak', note: 'Модель для кода, русский слабый', strengths: ['coding'] },
  { pattern: /llama[-_ ]?3\.[123]|llama[-_ ]?3|llama3|meta-llama/i, vendor: 'Meta Llama', russian: 'fair', note: 'Русский не входит в официальные языки Llama 3.x: понимает, но делает ошибки', strengths: ['chat', 'tools', 'coding'] },
  { pattern: /llama2\.c|stories\d+m|tinystories/i, vendor: 'Демо-модели', russian: 'none', note: 'Русский не поддерживается, только английский', strengths: ['writing'] },
  { pattern: /llama[-_ ]?2/i, vendor: 'Meta Llama', russian: 'weak', note: 'Llama 2 плохо работает с русским', strengths: ['chat'] },
  { pattern: /phi[-_ ]?4|phi[-_ ]?3|phi[-_ ]?2|\bphi/i, vendor: 'Microsoft Phi', russian: 'weak', note: 'Обучена в основном на английском; русский слабый', strengths: ['reasoning', 'math', 'chat'] },
  { pattern: /smollm3/i, vendor: 'Hugging Face', russian: 'weak', note: 'Официально 6 европейских языков без русского', strengths: ['chat', 'reasoning', 'tools'] },
  { pattern: /smollm/i, vendor: 'Hugging Face', russian: 'none', note: 'Английская модель: по-русски отвечает почти бессвязно', strengths: ['chat'] },
  { pattern: /internlm|glm|chatglm|yi[-_]|baichuan|minicpm/i, vendor: 'Китайские команды', russian: 'fair', note: 'Сильны в китайском и английском; русский средний', strengths: ['chat', 'coding'] },
  { pattern: /command[-_]?r/i, vendor: 'Cohere', russian: 'good', note: 'Command R заявляет русский среди 10 основных языков', strengths: ['tools', 'chat', 'multilingual'] },
  { pattern: /granite/i, vendor: 'IBM Granite', russian: 'fair', note: 'Мультиязычная, но русский не приоритет', strengths: ['coding', 'tools', 'chat'] },
  { pattern: /whisper/i, vendor: 'OpenAI', russian: 'good', note: 'Распознаёт русскую речь', strengths: ['audio', 'multilingual'] },
  { pattern: /llava|smolvlm|moondream|idefics|florence/i, vendor: 'Vision', russian: 'weak', note: 'Описывает изображения в основном по-английски', strengths: ['vision'] },
  { pattern: /bloom|opt-|pythia|gpt-?j|gpt-?neo|falcon|olmo|stablelm|tinyllama/i, vendor: 'Старые открытые модели', russian: 'weak', note: 'Устаревшая модель: русский слабый', strengths: ['chat'] },
  { pattern: /gpt-?2|distilgpt|lamini/i, vendor: 'Демо-модели', russian: 'none', note: 'Русский не поддерживается, только английский', strengths: [] },
]

const RANK: RussianLevel[] = ['none', 'weak', 'fair', 'good', 'native']
const RUSSIAN_TAG = /(^|[^a-z])ru([^a-z]|$)/i

function shift(level: RussianLevel, by: number): RussianLevel {
  const i = RANK.indexOf(level)
  return i < 0 ? level : RANK[Math.max(0, Math.min(RANK.length - 1, i + by))]
}

/** Parameter count from a name such as "Qwen2.5-1.5B-Instruct" or "SmolLM2-135M". */
export function parametersFromName(name: string): number | undefined {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*([bm])(?![a-z])/i.exec(name)
  if (!match) return undefined
  const value = Number(match[1]) * (match[2].toLowerCase() === 'b' ? 1e9 : 1e6)
  return value >= 1e7 ? value : undefined
}

function tierOf(params?: number): { tier?: Tier; note?: string } {
  if (!params) return {}
  if (params < 1e9) return { tier: 'demo', note: 'Менее 1 млрд параметров: подходит для проверки, много ошибок' }
  if (params < 4e9) return { tier: 'light', note: '1–4 млрд: простые вопросы и короткие тексты, для агента ненадёжна' }
  if (params < 14e9) return { tier: 'capable', note: '4–14 млрд: рабочий уровень для чата и несложного кода' }
  if (params < 40e9) return { tier: 'strong', note: '14–40 млрд: сильная модель, нужна мощная видеокарта или много ОЗУ' }
  return { tier: 'large', note: 'Более 40 млрд: уровень лучших открытых моделей, нужны серьёзные ресурсы' }
}

export function buildProfile(input: ProfileInput): ModelProfile {
  const haystack = `${input.id} ${input.baseModel ?? ''}`
  const tags = (input.tags ?? []).map((t) => t.toLowerCase())
  const params = input.parameters ?? parametersFromName(`${input.baseModel ?? ''} ${input.id}`)
  const family = FAMILIES.find((f) => f.pattern.test(haystack))

  let russian: RussianLevel = family?.russian ?? 'unknown'
  let note = family?.note ?? 'Нет данных о качестве русского языка'
  // Small models of a multilingual family still struggle with Russian.
  if (family && params && input.runtime !== 'cloud' && family.russian !== 'none') {
    if (params < 4e8) { russian = shift(russian, -2); note += ' (но модель слишком мала)' }
    else if (params < 1.9e9) { russian = shift(russian, -1); note += ' (у моделей этого размера русский заметно хуже)' }
  }
  const declaredRu = (input.languages ?? []).some((l) => RUSSIAN_TAG.test(l)) || tags.some((t) => t === 'ru' || t === 'russian')
  if (declaredRu && russian !== 'unknown' && RANK.indexOf(russian) < RANK.indexOf('good')) {
    russian = shift(russian, 1)
    note += '; русский указан в карточке модели'
  } else if (declaredRu && russian === 'unknown') {
    russian = 'fair'
    note = 'Русский указан в карточке модели'
  }

  const strengths = new Set<Strength>(family?.strengths ?? [])
  const name = haystack.toLowerCase()
  if (/code|coder|starcoder|codestral|devstral|opencoder|codegemma/.test(name)) strengths.add('coding')
  if (/math/.test(name)) strengths.add('math')
  if (/\br1\b|qwq|reason|think|magistral|[-_/]o[134]\b/.test(name) || tags.includes('reasoning')) strengths.add('reasoning')
  if (input.pipelineTag === 'image-text-to-text' || tags.includes('image-text-to-text') || /[-_]vl\b|vision|llava|pixtral|paligemma|smolvlm|minicpm-v|multimodal/.test(name)) strengths.add('vision')
  if (/automatic-speech-recognition|text-to-speech|audio/.test(`${input.pipelineTag} ${tags.join(' ')}`) || /whisper|tts|speech/.test(name)) strengths.add('audio')
  if (input.pipelineTag === 'feature-extraction' || /embed|bge-|e5-/.test(name)) strengths.add('embedding')
  if (tags.includes('conversational') || /instruct|chat|[-_]it\b|assistant/.test(name)) strengths.add('chat')
  if (tags.includes('multilingual') || (input.languages?.length ?? 0) >= 10) strengths.add('multilingual')
  if (/story|roleplay|creative|writer|novel|lyra|[-_]rp\b/.test(name)) strengths.add('writing')
  // Writing quality and tool use depend on size: tiny models are not credited with them.
  if (params && params >= 3e9 && strengths.has('chat') && russian !== 'none') strengths.add('writing')
  if (input.runtime !== 'cloud' && (!params || params < 3e9)) strengths.delete('tools')
  if (params && params < 1e9 && input.runtime !== 'cloud') { strengths.delete('writing'); strengths.delete('reasoning') }

  const { tier, note: tierNote } = tierOf(input.runtime === 'cloud' ? undefined : params)
  return {
    runtime: input.runtime,
    russian,
    russianNote: note,
    strengths: [...strengths],
    tier,
    tierNote,
    parameters: params,
    contextLength: input.contextLength,
    license: input.license,
    languages: input.languages,
    vendor: family?.vendor,
    memoryGb: params && input.runtime !== 'cloud' ? Math.round((params * 0.6e-9 + 1) * 10) / 10 : undefined,
    basis: family ? 'family' : 'metadata',
  }
}

export const RUSSIAN_LABELS: Record<RussianLevel, string> = {
  native: 'Отлично',
  good: 'Хорошо',
  fair: 'Средне',
  weak: 'Слабо',
  none: 'Не поддерживается',
  unknown: 'Нет данных',
}

export const STRENGTH_LABELS: Record<Strength, string> = {
  chat: 'Диалог',
  writing: 'Тексты',
  coding: 'Код',
  reasoning: 'Рассуждения',
  math: 'Математика',
  tools: 'Агент / инструменты',
  vision: 'Изображения',
  audio: 'Аудио',
  multilingual: 'Многоязычность',
  embedding: 'Эмбеддинги',
}

export const TIER_LABELS: Record<Tier, string> = {
  demo: 'Демо',
  light: 'Лёгкая',
  capable: 'Рабочая',
  strong: 'Сильная',
  large: 'Крупная',
}
