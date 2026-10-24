/**
 * IPC for local models: search, download (ONNX and GGUF), listing with
 * profiles, removal, and Hugging Face sign-in.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { runLocalModel, isValidModelId, type DownloadProgress } from './localHf'
import { searchModels, listGgufFiles, downloadHubFile, fetchProfile, REPO_ID, isGgufPath } from './hfHub'
import type { HfAuth } from './hfAuth'
import { buildProfile, type ModelProfile } from '../renderer/lib/modelProfile'

export type LocalModelEntry = {
  id: string
  name: string
  format: 'onnx' | 'gguf'
  downloaded: true
  sizeBytes: number
  profile: ModelProfile
}

const GGUF_PREFIX = 'gguf:'
const GGUF_ID = /^gguf:([\w.-]+)\/([\w.-]+)\/([\w.\-/]+\.gguf)$/i
const PROFILE_FILE = 'profile.json'
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i

export const isGgufModelId = (id: string): boolean => id.startsWith(GGUF_PREFIX)

export function parseGgufId(id: string): { repo: string; file: string } | null {
  const m = GGUF_ID.exec(id)
  if (!m || m[3].includes('..')) return null
  return { repo: `${m[1]}/${m[2]}`, file: m[3] }
}

type Deps = {
  ggufDir: string
  onnxCache: string
  workerPath: string
  auth: HfAuth
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? await dirSize(full) : (await fs.promises.stat(full)).size
  }
  return total
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else yield full
  }
}

async function readStoredProfile(dir: string): Promise<ModelProfile | null> {
  try { return JSON.parse(await fs.promises.readFile(path.join(dir, PROFILE_FILE), 'utf-8')) as ModelProfile } catch { return null }
}

export function registerModelIpc(deps: Deps) {
  const { ggufDir, onnxCache, workerPath, auth } = deps
  const downloading = new Map<string, AbortController>()

  /** Path of a GGUF model's entry file on disk, or null for an invalid id. */
  const ggufPath = (modelId: string): string | null => {
    const parsed = parseGgufId(modelId)
    if (!parsed) return null
    const root = path.resolve(ggufDir)
    const full = path.resolve(root, parsed.repo, parsed.file)
    return full.startsWith(root + path.sep) ? full : null
  }

  async function listOnnx(): Promise<LocalModelEntry[]> {
    if (!fs.existsSync(onnxCache)) return []
    const found: LocalModelEntry[] = []
    for (const org of await fs.promises.readdir(onnxCache, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const model of await fs.promises.readdir(path.join(onnxCache, org.name), { withFileTypes: true })) {
        if (!model.isDirectory()) continue
        const id = `${org.name}/${model.name}`
        const dir = path.join(onnxCache, org.name, model.name)
        found.push({
          id, name: id, format: 'onnx', downloaded: true,
          sizeBytes: await dirSize(dir).catch(() => 0),
          profile: (await readStoredProfile(dir)) ?? buildProfile({ id, runtime: 'onnx' }),
        })
      }
    }
    return found
  }

  async function listGguf(): Promise<LocalModelEntry[]> {
    if (!fs.existsSync(ggufDir)) return []
    const root = path.resolve(ggufDir)
    const found: LocalModelEntry[] = []
    for await (const file of walkFiles(root)) {
      if (!file.toLowerCase().endsWith('.gguf')) continue
      const rel = path.relative(root, file).split(path.sep).join('/')
      const shard = SHARD.exec(rel)
      if (shard && shard[1] !== '00001') continue
      const [org, repo, ...rest] = rel.split('/')
      const id = `${GGUF_PREFIX}${org}/${repo}/${rest.join('/')}`
      if (!parseGgufId(id)) continue
      let sizeBytes = (await fs.promises.stat(file)).size
      if (shard) {
        const prefix = file.slice(0, file.length - shard[0].length)
        for (const sibling of await fs.promises.readdir(path.dirname(file))) {
          const full = path.join(path.dirname(file), sibling)
          if (full !== file && full.startsWith(prefix) && SHARD.test(sibling)) sizeBytes += (await fs.promises.stat(full)).size
        }
      }
      const stored = await readStoredProfile(path.join(root, org, repo))
      found.push({
        id, name: `${org}/${repo} · ${path.basename(rest.join('/'))}`, format: 'gguf', downloaded: true, sizeBytes,
        profile: stored ?? buildProfile({ id: `${org}/${repo}`, runtime: 'gguf', parameters: undefined }),
      })
    }
    return found
  }

  async function listLocalModels(): Promise<LocalModelEntry[]> {
    const [onnx, gguf] = await Promise.all([listOnnx().catch(() => []), listGguf().catch(() => [])])
    return [...gguf, ...onnx]
  }

  const withProgress = (event: IpcMainInvokeEvent, modelId: string) => (p: { file?: string; loaded?: number; total?: number; status?: string }) => {
    if (!event.sender.isDestroyed()) event.sender.send('hf:progress', { modelId, status: 'progress', ...p })
  }

  async function startDownload(modelId: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (downloading.has(modelId)) throw new Error('Модель уже скачивается')
    const controller = new AbortController()
    downloading.set(modelId, controller)
    try {
      await run(controller.signal)
      if (controller.signal.aborted) throw new Error('Скачивание отменено')
    } finally {
      downloading.delete(modelId)
    }
  }

  const completed = (event: IpcMainInvokeEvent, modelId: string) => {
    if (!event.sender.isDestroyed()) event.sender.send('hf:progress', { modelId, status: 'complete' })
  }

  ipcMain.handle('hf:listLocal', async () => {
    try { return await listLocalModels() } catch (err) { console.error('hf:listLocal failed:', err); return [] }
  })

  ipcMain.handle('hf:search', async (_e, format: string, query: string) => {
    if (format !== 'gguf' && format !== 'onnx') throw new Error('Неизвестный формат моделей')
    return searchModels(format, typeof query === 'string' ? query : '', await auth.getToken())
  })

  ipcMain.handle('hf:ggufFiles', async (_e, repoId: string) => listGgufFiles(repoId, await auth.getToken()))

  ipcMain.handle('hf:download', async (event, modelId: string) => {
    if (!isValidModelId(modelId)) throw new Error('Некорректный id модели (ожидается org/name)')
    await startDownload(modelId, async (signal) => {
      await fs.promises.mkdir(onnxCache, { recursive: true })
      const progress = withProgress(event, modelId)
      for await (const chunk of runLocalModel({ workerPath, cacheDir: onnxCache, model: modelId, mode: 'download', onProgress: progress as (p: DownloadProgress) => void, signal })) {
        if (chunk.type === 'error') throw new Error(chunk.error ?? 'Не удалось скачать модель')
      }
      if (signal.aborted) return
      const profile = await fetchProfile(modelId, 'onnx', await auth.getToken()).catch(() => buildProfile({ id: modelId, runtime: 'onnx' }))
      await fs.promises.writeFile(path.join(onnxCache, ...modelId.split('/'), PROFILE_FILE), JSON.stringify(profile)).catch(() => {})
      completed(event, modelId)
    })
  })

  ipcMain.handle('hf:downloadGguf', async (event, repoId: string, file: string, parts?: string[]) => {
    if (!REPO_ID.test(repoId) || !isGgufPath(file)) throw new Error('Некорректный репозиторий или файл')
    const modelId = `${GGUF_PREFIX}${repoId}/${file}`
    const entries = (Array.isArray(parts) && parts.length > 0 ? parts : [file]).filter((p) => typeof p === 'string' && isGgufPath(p))
    await startDownload(modelId, async (signal) => {
      const token = await auth.getToken()
      const progress = withProgress(event, modelId)
      for (const part of entries) {
        const destination = path.resolve(ggufDir, repoId, part)
        if (!destination.startsWith(path.resolve(ggufDir) + path.sep)) throw new Error('Некорректный путь файла')
        await downloadHubFile({ repoId, file: part, destination, token, signal, onProgress: progress })
      }
      const profile = await fetchProfile(repoId, 'gguf', token).catch(() => buildProfile({ id: repoId, runtime: 'gguf' }))
      await fs.promises.writeFile(path.join(ggufDir, ...repoId.split('/'), PROFILE_FILE), JSON.stringify(profile)).catch(() => {})
      completed(event, modelId)
    })
  })

  ipcMain.handle('hf:cancelDownload', (_e, modelId: string) => { downloading.get(modelId)?.abort() })

  ipcMain.handle('hf:remove', async (_e, modelId: string) => {
    if (isGgufModelId(modelId)) {
      const full = ggufPath(modelId)
      if (!full) throw new Error('Некорректный id модели')
      const shard = SHARD.exec(full)
      const prefix = shard ? full.slice(0, full.length - shard[0].length) : null
      for (const name of await fs.promises.readdir(path.dirname(full)).catch(() => [] as string[])) {
        const candidate = path.join(path.dirname(full), name)
        if (candidate === full || candidate === `${full}.part` || (prefix && candidate.startsWith(prefix) && SHARD.test(name))) await fs.promises.rm(candidate, { force: true })
      }
      return
    }
    if (!isValidModelId(modelId)) throw new Error('Некорректный id модели')
    const root = path.resolve(onnxCache)
    const target = path.resolve(root, modelId)
    if (!target.startsWith(root + path.sep)) throw new Error('Некорректный путь')
    await fs.promises.rm(target, { recursive: true, force: true })
  })

  ipcMain.handle('hf:authStatus', () => auth.status())
  ipcMain.handle('hf:login', () => auth.login())
  ipcMain.handle('hf:logout', () => auth.logout())

  return { listLocalModels, ggufPath }
}
