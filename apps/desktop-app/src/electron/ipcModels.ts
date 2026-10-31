/**
 * IPC for local models: search, download (ONNX and GGUF), listing with
 * profiles, removal, and Hugging Face sign-in.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog, type IpcMainInvokeEvent } from 'electron'
import { runLocalModel, isValidModelId, type DownloadProgress } from './localHf'
import { searchModels, listGgufFiles, downloadHubFile, fetchProfile, REPO_ID, isGgufPath, type GgufFile } from './hfHub'
import type { HfAuth } from './hfAuth'
import { buildProfile, type ModelProfile } from '../renderer/lib/modelProfile'
import { estimateFit, q4WeightsBytes, FIT_RANK, type Fit, type SystemInfo } from '../renderer/lib/modelFit'
import { loadExtensions, saveExtensions as writeExtensions } from './extensions'

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
  getSystem: () => Promise<SystemInfo>
  ggufDir: string
  onnxCache: string
  workerPath: string
  auth: HfAuth
  /** Current custom download folder (extensions.json); undefined = default ggufDir. */
  downloadDir?: () => string | undefined
}

/** A user-registered GGUF file that lives anywhere on disk. */
export type ExternalModelEntry = {
  id: string
  name: string
  path: string
  sizeBytes: number
  addedAt: number
}

const EXTERNAL_FILE = 'external-models.json'

export function externalFilePath(userDataDir: string): string {
  return path.join(userDataDir, EXTERNAL_FILE)
}

export function readExternalModels(userDataDir: string): ExternalModelEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, EXTERNAL_FILE), 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((e: any) => typeof e?.path === 'string' && e.path.length > 0)
      .map((e: any, i: number) => ({
        id: typeof e.id === 'string' && e.id ? e.id : `ext-${i}`,
        name: typeof e.name === 'string' && e.name ? e.name : path.basename(String(e.path)),
        path: String(e.path),
        sizeBytes: typeof e.sizeBytes === 'number' ? e.sizeBytes : 0,
        addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
      }))
      .slice(0, 100)
  } catch {
    return []
  }
}

export function writeExternalModels(userDataDir: string, list: ExternalModelEntry[]): void {
  const file = path.join(userDataDir, EXTERNAL_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
  fs.renameSync(tmp, file)
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

export type Recommendation = {
  repo: string
  file: string
  parts: string[]
  size: number
  quant: string
  downloads: number
  profile: ModelProfile
  fit: Fit
}

const GB = 1024 ** 3
const RECOMMEND_QUERIES = ['Qwen3 Instruct', 'Qwen2.5 Instruct', 'gemma-3 it', 'Llama-3.1 Instruct', 'Mistral Nemo Instruct', 'Qwen2.5 Coder Instruct']
/** Best quality-per-size first: Q4_K_M is the usual sweet spot. */
const QUANT_PREFERENCE = ['Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q5_K_M', 'Q4_0', 'Q3_K_M', 'IQ3_M', 'Q5_K_S', 'Q6_K', 'Q8_0', 'Q3_K_S', 'Q2_K', 'IQ2_M']
/** Below Q3 quality drops sharply; such builds are not recommended. */
const MIN_QUALITY_QUANTS = new Set(['Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q5_K_M', 'Q4_0', 'Q3_K_M', 'IQ3_M', 'Q5_K_S', 'Q6_K', 'Q8_0'])
/** Community fine-tunes are not recommended by default; they stay reachable through search. */
const FINE_TUNE_MARKER = /abliterat|uncensor|heretic|hivemind|erotic|nsfw|roleplay|[-_]rp[-_]|distill|merge|neo-imatrix|narrator/i
/** Publishers of the original models or well-known quantisers, preferred over unknown uploaders. */
const TRUSTED_PUBLISHER = /^(qwen|bartowski|unsloth|lmstudio-community|google|mistralai|meta-llama|microsoft|ggml-org|maziyarpanahi)\//i
const RECOMMEND_CACHE_MS = 10 * 60 * 1000
const MAX_CANDIDATES = 26
const MAX_FAST = 5
/** Below this lower-bound speed a model is too slow to chat with comfortably. */
const USABLE_TPS = 4
const MAX_STRONGER = 3

export function registerModelIpc(deps: Deps & { userDataDir: string; extensionsFile: string; getWindow?: () => Electron.BrowserWindow | null }) {
  const { ggufDir, onnxCache, workerPath, auth, getSystem, extensionsFile } = deps
  let recommendCache: { at: number; key: string; value: Recommendation[] } | null = null

  /** The file of a repository that runs best here; among equals the preferred quantisation. */
  function pickFile(files: GgufFile[], system: SystemInfo, parameters: number): { file: GgufFile; fit: Fit } | null {
    // Drop helper files (imatrix etc.): a real build of N parameters is at least ~0.2 bytes per parameter.
    const main = files.filter((f) => f.role === 'main' && f.size >= parameters * 0.2 && MIN_QUALITY_QUANTS.has(f.quant))
    const plain = main.filter((f) => /nomtp/i.test(f.file))
    const pool = plain.length > 0 ? plain : main
    const scored = pool.map((file) => ({ file, fit: estimateFit(file.size, system) })).filter((x) => x.fit.level !== 'no')
    if (scored.length === 0) return null
    const best = Math.max(...scored.map((x) => FIT_RANK[x.fit.level]))
    const top = scored.filter((x) => FIT_RANK[x.fit.level] === best)
    const order = (q: string) => { const i = QUANT_PREFERENCE.indexOf(q); return i < 0 ? QUANT_PREFERENCE.length : i }
    return top.sort((a, b) => order(a.file.quant) - order(b.file.quant) || b.file.size - a.file.size)[0]
  }

  async function recommend(system: SystemInfo): Promise<Recommendation[]> {
    const key = `${Math.round(system.vramFree / GB)}-${Math.round(system.freeRam / GB)}`
    if (recommendCache && recommendCache.key === key && Date.now() - recommendCache.at < RECOMMEND_CACHE_MS) return recommendCache.value

    const token = await auth.getToken()
    const lists = await Promise.all(RECOMMEND_QUERIES.map((q) => searchModels('gguf', q, token).catch(() => [])))
    // What the machine could hold at all: free video memory plus usable RAM.
    const ceiling = (system.vramFree * 0.92) + (system.freeRam * 0.85)
    const seenFamilies = new Set<string>()
    const candidates = lists.flat()
      .filter((m) => !FINE_TUNE_MARKER.test(m.id))
      .filter((m) => m.profile.parameters && m.profile.parameters >= 1.5e9 && (m.profile.russian === 'good' || m.profile.russian === 'native'))
      .filter((m) => q4WeightsBytes(m.profile.parameters!) * 1.08 + 0.7 * GB <= ceiling)
      .sort((a, b) => b.downloads - a.downloads)
      .filter((m) => {
        // The same model is uploaded by many people: keep the most downloaded repository per family.
        const family = (m.id.split('/')[1] ?? m.id).toLowerCase().replace(/-?gguf$/, '').replace(/^qwen_/, '').replace(/\.1-/, '-')
        if (seenFamilies.has(family)) return false
        seenFamilies.add(family)
        return true
      })
      .slice(0, MAX_CANDIDATES)

    const resolved = await Promise.all(candidates.map(async (m): Promise<Recommendation | null> => {
      const files = await listGgufFiles(m.id, token).catch(() => [] as GgufFile[])
      const pick = pickFile(files, system, m.profile.parameters ?? 0)
      if (!pick) return null
      return { repo: m.id, file: pick.file.file, parts: pick.file.parts, size: pick.file.size, quant: pick.file.quant, downloads: m.downloads, profile: m.profile, fit: pick.fit }
    }))
    // Fast options first (entirely on the GPU), then a few stronger ones that run slower.
    const trusted = (r: Recommendation) => (TRUSTED_PUBLISHER.test(r.repo) ? 1 : 0)
    const bySize = (a: Recommendation, b: Recommendation) => trusted(b) - trusted(a) || (b.profile.parameters ?? 0) - (a.profile.parameters ?? 0)
    const ready = resolved.filter((r): r is Recommendation => r !== null)
    const fast = ready.filter((r) => r.fit.level === 'gpu').sort(bySize).slice(0, MAX_FAST)
    const slower = ready.filter((r) => r.fit.level !== 'gpu')
    // Stronger models that still chat at a tolerable speed come first; very slow giants only fill the gap.
    const usable = slower.filter((r) => (r.fit.tokensPerSecond?.[0] ?? 0) >= USABLE_TPS).sort(bySize)
    const crawling = slower.filter((r) => (r.fit.tokensPerSecond?.[0] ?? 0) < USABLE_TPS).sort((a, b) => FIT_RANK[b.fit.level] - FIT_RANK[a.fit.level] || bySize(b, a))
    const stronger = [...usable, ...crawling].slice(0, MAX_STRONGER)
    const value = [...fast, ...stronger]
    recommendCache = { at: Date.now(), key, value }
    return value
  }

  const downloading = new Map<string, AbortController>()

  /** Path of a GGUF model's entry file on disk, or null for an invalid id. */
  const ggufPath = (modelId: string): string | null => {
    // User-registered external model file.
    if (modelId.startsWith('ext:')) {
      const entry = readExternalModels(deps.userDataDir).find((e) => `ext:${e.id}` === modelId)
      return entry && fs.existsSync(entry.path) ? path.resolve(entry.path) : null
    }
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
    // The custom download folder is scanned in addition to the default one.
    const custom = deps.downloadDir?.()
    const roots = [...new Set([path.resolve(ggufDir), ...(custom ? [path.resolve(custom)] : [])])]
    const found: LocalModelEntry[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      for await (const file of walkFiles(root)) {
        if (!file.toLowerCase().endsWith('.gguf')) continue
        const rel = path.relative(root, file).split(path.sep).join('/')
        const shard = SHARD.exec(rel)
        if (shard && shard[1] !== '00001') continue
        const [org, repo, ...rest] = rel.split('/')
        const id = `${GGUF_PREFIX}${org}/${repo}/${rest.join('/')}`
        if (!parseGgufId(id) || seen.has(id)) continue
        seen.add(id)
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
    }
    return found
  }

  async function listLocalModels(): Promise<LocalModelEntry[]> {
    const [onnx, gguf] = await Promise.all([listOnnx().catch(() => []), listGguf().catch(() => [])])
    // User-registered GGUF files from anywhere on disk.
    const external: LocalModelEntry[] = readExternalModels(deps.userDataDir)
      .filter((e) => fs.existsSync(e.path))
      .map((e) => ({
        id: `ext:${e.id}`,
        name: `${e.name} (внешняя)`,
        format: 'gguf' as const,
        downloaded: true as const,
        sizeBytes: e.sizeBytes || (fs.statSync(e.path).size ?? 0),
        profile: buildProfile({ id: e.name.replace(/\.gguf$/i, ''), runtime: 'gguf' }),
      }))
    return [...gguf, ...external, ...onnx]
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
      // The custom download folder keeps its own org/repo structure.
      const targetRoot = path.resolve(deps.downloadDir?.() ?? ggufDir)
      await fs.promises.mkdir(targetRoot, { recursive: true })
      for (const part of entries) {
        const destination = path.resolve(targetRoot, repoId, part)
        if (!destination.startsWith(targetRoot + path.sep)) throw new Error('Некорректный путь файла')
        await downloadHubFile({ repoId, file: part, destination, token, signal, onProgress: progress })
      }
      const profile = await fetchProfile(repoId, 'gguf', token).catch(() => buildProfile({ id: repoId, runtime: 'gguf' }))
      await fs.promises.writeFile(path.join(targetRoot, ...repoId.split('/'), PROFILE_FILE), JSON.stringify(profile)).catch(() => {})
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

  ipcMain.handle('system:info', () => getSystem())
  ipcMain.handle('hf:recommend', async () => recommend(await getSystem()))

  ipcMain.handle('hf:authStatus', () => auth.status())
  ipcMain.handle('hf:login', () => auth.login())
  ipcMain.handle('hf:logout', () => auth.logout())

  // ---- external GGUF files & download folder --------------------------------

  ipcMain.handle('hf:addExternal', async (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Не указан файл модели')
    const full = path.resolve(filePath.trim())
    if (!full.toLowerCase().endsWith('.gguf')) throw new Error('Поддерживаются только .gguf файлы')
    const stat = await fs.promises.stat(full).catch(() => { throw new Error('Файл не найден') })
    if (!stat.isFile()) throw new Error('Это не файл')
    const list = readExternalModels(deps.userDataDir)
    if (list.some((e) => path.resolve(e.path) === full)) return list
    const entry: ExternalModelEntry = {
      id: `m${Date.now().toString(36)}`,
      name: path.basename(full, path.extname(full)),
      path: full, sizeBytes: stat.size, addedAt: Date.now(),
    }
    writeExternalModels(deps.userDataDir, [...list, entry].slice(-100))
    return list
  })

  ipcMain.handle('hf:removeExternal', (_e, id: string) => {
    writeExternalModels(deps.userDataDir, readExternalModels(deps.userDataDir).filter((e) => e.id !== id))
  })

  ipcMain.handle('hf:pickModelFile', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'GGUF модель', extensions: ['gguf'] }] }
    const win = deps.getWindow?.() ?? null
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('hf:getDownloadDir', () => deps.downloadDir?.() ?? null)

  /** Folder picker for the custom download dir; returns the new value or null. */
  ipcMain.handle('hf:pickDownloadDir', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const win = deps.getWindow?.() ?? null
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const dir = result.filePaths[0]
    if (!dir) return deps.downloadDir?.() ?? null
    const value = path.resolve(dir)
    const cfg = loadExtensions(extensionsFile)
    writeExtensions(extensionsFile, { ...cfg, ggufDownloadDir: value })
    return value
  })

  ipcMain.handle('hf:setDownloadDir', async (_e, dir: string | null) => {
    if (dir !== null && (typeof dir !== 'string' || !dir.trim())) throw new Error('Некорректная папка')
    const value = dir === null ? undefined : path.resolve(dir.trim())
    if (value) {
      const stat = await fs.promises.stat(value).catch(() => null)
      if (!stat?.isDirectory()) throw new Error('Папка не найдена')
    }
    const cfg = loadExtensions(extensionsFile)
    writeExtensions(extensionsFile, { ...cfg, ...(value ? { ggufDownloadDir: value } : { ggufDownloadDir: undefined }) })
    return value ?? null
  })

  return { listLocalModels, ggufPath }
}
