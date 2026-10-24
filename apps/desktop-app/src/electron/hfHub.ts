/**
 * Hugging Face Hub client: model search, GGUF file listing and resumable
 * downloads. When the user is signed in, the OAuth token is sent so gated and
 * private repositories work.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { buildProfile, type ModelProfile, type Runtime } from '../renderer/lib/modelProfile'

const HUB = 'https://huggingface.co'
const EXPAND = ['cardData', 'tags', 'pipeline_tag', 'safetensors', 'gguf', 'downloads', 'likes', 'gated'] as const
const SEARCH_TIMEOUT_MS = 15_000
const PROGRESS_INTERVAL_MS = 150

export type HubModel = { id: string; downloads: number; likes: number; gated: boolean; profile: ModelProfile }
export type GgufFile = {
  file: string
  size: number
  quant: string
  parts: string[]
  /** `draft` files are auxiliary models for speculative decoding and cannot be chatted with. */
  role: 'main' | 'draft'
}

export const isDraftFile = (file: string): boolean => /(^|[-_.])draft([-_.]|$)/i.test(file.split('/').pop() ?? file)
export type Progress = { file: string; loaded: number; total: number }

// org/name, where neither part may be "." or ".." (path traversal).
export const REPO_ID = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/
const GGUF_FILE = /^[\w.\-/]+\.gguf$/i

export class HubError extends Error {}

const authHeaders = (token?: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

async function hubJson<T>(url: URL, token?: string | null): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
  if (res.status === 401 || res.status === 403) throw new HubError('Нет доступа: войдите в аккаунт Hugging Face и примите условия модели на её странице')
  if (!res.ok) throw new HubError(`Hugging Face: HTTP ${res.status}`)
  return (await res.json()) as T
}

type HubRecord = {
  id: string
  downloads?: number
  likes?: number
  gated?: boolean | string
  tags?: string[]
  pipeline_tag?: string
  cardData?: { language?: string | string[]; license?: string }
  safetensors?: { total?: number }
  gguf?: { total?: number; context_length?: number }
}

/** The un-quantised model a repository was derived from, when the hub knows it. */
function baseModelOf(tags: string[] = []): string | undefined {
  const plain = tags.find((t) => /^base_model:(?!quantized:|finetune:|adapter:|merge:)/.test(t))
  const any = plain ?? tags.find((t) => t.startsWith('base_model:'))
  return any?.replace(/^base_model:(?:[a-z]+:)?/, '')
}

export function profileFromRecord(record: HubRecord, runtime: Runtime): ModelProfile {
  const language = record.cardData?.language
  return buildProfile({
    id: record.id,
    runtime,
    baseModel: baseModelOf(record.tags),
    tags: record.tags,
    languages: Array.isArray(language) ? language : language ? [language] : undefined,
    license: record.cardData?.license ?? record.tags?.find((t) => t.startsWith('license:'))?.slice(8),
    pipelineTag: record.pipeline_tag,
    parameters: record.gguf?.total ?? record.safetensors?.total,
    contextLength: record.gguf?.context_length,
  })
}

/** Profile of a single repository, from live hub metadata. */
export async function fetchProfile(repoId: string, runtime: Runtime, token?: string | null): Promise<ModelProfile> {
  if (!REPO_ID.test(repoId)) throw new HubError('Некорректный id репозитория')
  const url = new URL(`${HUB}/api/models/${repoId}`)
  for (const field of EXPAND) url.searchParams.append('expand[]', field)
  return profileFromRecord(await hubJson<HubRecord>(url, token), runtime)
}

export async function searchModels(format: 'gguf' | 'onnx', query: string, token?: string | null): Promise<HubModel[]> {
  const url = new URL(`${HUB}/api/models`)
  url.searchParams.set('filter', format === 'gguf' ? 'gguf' : 'transformers.js')
  url.searchParams.set('pipeline_tag', 'text-generation')
  url.searchParams.set('sort', 'downloads')
  url.searchParams.set('direction', '-1')
  url.searchParams.set('limit', '30')
  const q = query.trim().slice(0, 100)
  if (q) url.searchParams.set('search', q)
  for (const field of EXPAND) url.searchParams.append('expand[]', field)
  const data = await hubJson<HubRecord[]>(url, token)
  return data
    .filter((m) => REPO_ID.test(m.id))
    .map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, gated: Boolean(m.gated), profile: profileFromRecord(m, format) }))
}

const QUANT = /(IQ\d_[A-Z0-9_]+|Q\d_[A-Z0-9_]+|Q\d|BF16|F16|F32|MXFP4)/i
const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

/** GGUF files of a repository, grouping split shards into one downloadable entry. */
export async function listGgufFiles(repoId: string, token?: string | null): Promise<GgufFile[]> {
  if (!REPO_ID.test(repoId)) throw new HubError('Некорректный id репозитория')
  const url = new URL(`${HUB}/api/models/${repoId}/tree/main`)
  url.searchParams.set('recursive', 'true')
  const tree = await hubJson<{ type: string; path: string; size?: number; lfs?: { size?: number } }[]>(url, token)

  const files = tree.filter((f) => f.type === 'file' && GGUF_FILE.test(f.path) && !/(^|\/)mmproj/i.test(f.path))
  const groups = new Map<string, GgufFile>()
  for (const f of files) {
    const size = f.lfs?.size ?? f.size ?? 0
    const split = SPLIT.exec(f.path)
    const key = split ? `${split[1]}.gguf` : f.path
    const existing = groups.get(key)
    if (existing) {
      existing.size += size
      existing.parts.push(f.path)
    } else {
      groups.set(key, { file: f.path, size, quant: QUANT.exec(path.basename(f.path))?.[1]?.toUpperCase() ?? 'GGUF', parts: [f.path], role: isDraftFile(f.path) ? 'draft' : 'main' })
    }
  }
  // The first shard is the entry point loaded by llama.cpp.
  for (const group of groups.values()) {
    group.parts.sort()
    group.file = group.parts[0]
  }
  return [...groups.values()].sort((a, b) => a.size - b.size)
}

export function isGgufPath(file: string): boolean {
  return GGUF_FILE.test(file) && !file.includes('..')
}

export type DownloadOptions = {
  repoId: string
  file: string
  destination: string
  token?: string | null
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
}

/** Downloads one file with resume support (`.part` + Range); the final rename makes it atomic. */
export async function downloadHubFile(opts: DownloadOptions): Promise<void> {
  const { repoId, file, destination, token, signal, onProgress } = opts
  if (!REPO_ID.test(repoId) || !isGgufPath(file)) throw new HubError('Некорректный репозиторий или файл')
  if (fs.existsSync(destination)) return

  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  const existing = fs.existsSync(partial) ? (await fs.promises.stat(partial)).size : 0

  const encoded = file.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${HUB}/${repoId}/resolve/main/${encoded}`, {
    headers: { ...authHeaders(token), ...(existing > 0 ? { Range: `bytes=${existing}-` } : {}) },
    signal,
  })
  if (res.status === 401 || res.status === 403) throw new HubError('Нет доступа к файлу: войдите в Hugging Face и примите условия модели на её странице')
  if (res.status === 416) { await fs.promises.rename(partial, destination); return }
  if (!res.ok || !res.body) throw new HubError(`Не удалось скачать ${file}: HTTP ${res.status}`)

  const resumed = res.status === 206
  const length = Number(res.headers.get('content-length') ?? 0)
  const total = resumed ? existing + length : length
  let loaded = resumed ? existing : 0
  let lastReport = 0

  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      loaded += chunk.length
      const now = Date.now()
      if (now - lastReport >= PROGRESS_INTERVAL_MS) { lastReport = now; onProgress?.({ file, loaded, total }) }
      yield chunk
    }
  }
  await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' }), { signal })
  if (total > 0 && loaded < total) throw new HubError('Загрузка оборвалась, повторите — она продолжится с места остановки')
  onProgress?.({ file, loaded, total: total || loaded })
  await fs.promises.rename(partial, destination)
}
