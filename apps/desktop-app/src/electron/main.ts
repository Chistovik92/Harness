/**
 * DeepSeek Harness Desktop — Electron main process.
 *
 * - Application lifecycle, windows, tray, auto-updater
 * - Encrypted local storage of provider API keys (AES-256-GCM; the key itself
 *   is protected by the OS keychain through Electron safeStorage when available)
 * - Provider registry + chat streaming (OpenAI-compatible, Anthropic, Google, HF API/local)
 * - Local HuggingFace models via a transformers.js worker thread
 */

import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, screen, safeStorage, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { OpenAICompatibleProvider } from '../renderer/lib/openaiProvider'
import { AnthropicProvider } from '../renderer/lib/anthropicProvider'
import { GoogleProvider } from '../renderer/lib/googleProvider'
import { HuggingFaceProvider } from '../renderer/lib/huggingfaceProvider'
import { providerRegistry } from '../renderer/lib/registry'
import type { LLMProvider, ProviderKind, Message, ChatChunk } from '../renderer/lib/providers'
import { encrypt, decrypt, generateKey, isValidKey } from './secureStore'
import { runLocalModel } from './localHf'
import { GgufEngine } from './gguf'
import { registerModelIpc, isGgufModelId } from './ipcModels'
import { registerAgentIpc, isPermissionMode, validWorkspace } from './ipcAgent'
import { HfAuth, type StoredAuth } from './hfAuth'
import { EncryptedStore } from './store'
import type { SshConnection } from './agent/remote'
import type { PermissionMode } from './agent/permissions'
import { runAgent, executeTool, toolDefs, summarizeCall, buildSystemPrompt, type AgentEvent } from './agent/loop'
import { buildProfile } from '../renderer/lib/modelProfile'

// ---- providers -------------------------------------------------------------
type StoredProvider = {
  id: string; name: string; kind: ProviderKind
  apiKey?: string; baseUrl?: string; defaultModel?: string
  enabled: boolean; local?: boolean
}

const PROVIDER_KINDS: ProviderKind[] = ['openai-compatible', 'anthropic', 'google', 'huggingface-api', 'huggingface-local']

function oai(id: string, name: string, baseUrl: string, defaultModel: string) {
  providerRegistry.register(id, new OpenAICompatibleProvider({ id, name, kind: 'openai-compatible', baseUrl, defaultModel, enabled: true }))
}
oai('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat')
oai('openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini')
oai('groq', 'Groq', 'https://api.groq.com/openai/v1', 'llama-3.1-70b-versatile')
oai('together', 'Together AI', 'https://api.together.xyz/v1', 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo')
oai('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-chat')
providerRegistry.register('anthropic', new AnthropicProvider({ id: 'anthropic', name: 'Anthropic', kind: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022', enabled: true }))
providerRegistry.register('google', new GoogleProvider({ id: 'google', name: 'Google', kind: 'google', defaultModel: 'gemini-1.5-flash', enabled: true }))
providerRegistry.register('huggingface-api', new HuggingFaceProvider({ id: 'huggingface-api', name: 'Hugging Face (API)', kind: 'huggingface-api', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct', enabled: true }))
providerRegistry.register('huggingface-local', new HuggingFaceProvider({ id: 'huggingface-local', name: 'Hugging Face (Local)', kind: 'huggingface-local', local: true, defaultModel: 'Xenova/llama2.c-stories15M', enabled: true }))

/** Built-in provider by id, or an instance created from a user-defined config. */
function resolveProvider(cfg: StoredProvider): LLMProvider | undefined {
  const known = providerRegistry.get(cfg.id)
  if (known) return known
  switch (cfg.kind) {
    case 'openai-compatible': return new OpenAICompatibleProvider(cfg)
    case 'anthropic': return new AnthropicProvider(cfg)
    case 'google': return new GoogleProvider(cfg)
    case 'huggingface-api': return new HuggingFaceProvider(cfg)
    case 'huggingface-local': return new HuggingFaceProvider({ ...cfg, local: true })
    default: return undefined
  }
}

const isLocalHf = (cfg: StoredProvider) => cfg.kind === 'huggingface-local' || cfg.local === true

/** Built-in providers that work without any saved configuration (local models need no key). */
function builtinConfig(id: string): StoredProvider | undefined {
  const p = providerRegistry.get(id)
  if (!p || p.requiresKey()) return undefined
  return { id: p.id, name: p.name, kind: p.kind, enabled: true, ...(p.kind === 'huggingface-local' ? { local: true } : {}) }
}

// ---- paths -----------------------------------------------------------------
const IS_DEV = !app.isPackaged
const USER_DATA = app.getPath('userData')
const STORAGE_KEY_PATH = path.join(USER_DATA, '.storage_key')
const PROVIDERS_PATH = path.join(USER_DATA, 'providers.enc.json')
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json')
const HF_CACHE = path.join(USER_DATA, 'hf-cache')
const DEV_URL = 'http://127.0.0.1:5173'
// __dirname is <app>/dist/electron/electron
const RENDERER_INDEX = path.join(__dirname, '..', '..', 'renderer', 'index.html')
const RESOURCES_DIR = path.join(app.getAppPath(), 'resources')
const ICON_PATH = path.join(RESOURCES_DIR, 'icon.png')

// ---- windows ---------------------------------------------------------------
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const activeStreams = new Map<string, AbortController>()

function isAppUrl(url: string): boolean {
  return IS_DEV ? url.startsWith(DEV_URL) : url.startsWith('file://')
}

function hardenWebContents(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
})

function loadRenderer(win: BrowserWindow, hash = '') {
  if (IS_DEV) void win.loadURL(`${DEV_URL}${hash ? `/#${hash}` : ''}`)
  else void win.loadFile(RENDERER_INDEX, hash ? { hash } : undefined)
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    title: 'DeepSeek Harness',
    width: Math.min(1200, width),
    height: Math.min(800, height),
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: !IS_DEV,
    icon: ICON_PATH,
    webPreferences: webPreferences(),
  })
  hardenWebContents(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  loadRenderer(mainWindow)
  if (IS_DEV) mainWindow.webContents.openDevTools()

  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform !== 'darwin') {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    title: 'Настройки — DeepSeek Harness',
    width: 700, height: 560, minWidth: 600, minHeight: 480,
    modal: Boolean(mainWindow), parent: mainWindow ?? undefined,
    icon: ICON_PATH,
    webPreferences: webPreferences(),
  })
  hardenWebContents(settingsWindow)
  loadRenderer(settingsWindow, '/settings')
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
}

function createTray() {
  try {
    const icon = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
    tray = new Tray(icon)
    tray.setToolTip('DeepSeek Harness')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть DeepSeek Harness', click: showMainWindow },
      { label: 'Настройки', click: createSettingsWindow },
      { type: 'separator' },
      { label: 'Выйти', click: () => app.quit() },
    ]))
    tray.on('click', showMainWindow)
  } catch (err) {
    console.error('Tray unavailable:', err)
  }
}

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'DeepSeek Harness', submenu: [
      { label: 'О программе', role: 'about' },
      { type: 'separator' },
      { label: 'Настройки', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow },
      { type: 'separator' },
      { label: 'Выйти', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]},
    { label: 'Редактировать', submenu: [
      { label: 'Отменить', role: 'undo' },
      { label: 'Повторить', role: 'redo' },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut' },
      { label: 'Копировать', role: 'copy' },
      { label: 'Вставить', role: 'paste' },
      { label: 'Выделить всё', role: 'selectAll' },
    ]},
    { label: 'Вид', submenu: [
      { label: 'Перезагрузить', role: 'reload' },
      ...(IS_DEV ? [{ label: 'Инструменты разработчика', role: 'toggleDevTools' } as Electron.MenuItemConstructorOptions] : []),
      { type: 'separator' },
      { label: 'Увеличить', role: 'zoomIn' },
      { label: 'Уменьшить', role: 'zoomOut' },
      { label: 'Сброс масштаба', role: 'resetZoom' },
    ]},
    { label: 'Окно', submenu: [
      { label: 'Минимизировать', role: 'minimize' },
      { label: 'Закрыть', role: 'close' },
      { label: 'Всегда поверх', type: 'checkbox', checked: false, click: (item) => mainWindow?.setAlwaysOnTop(item.checked) },
    ]},
    { label: 'Помощь', submenu: [
      { label: 'GitHub', click: () => { void shell.openExternal('https://github.com/Chistovik92/Harness') } },
    ]},
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- encrypted storage -----------------------------------------------------
const KEY_PREFIX_OS = 'os:'
const KEY_PREFIX_RAW = 'raw:'

async function getOrCreateStorageKey(): Promise<Buffer> {
  if (fs.existsSync(STORAGE_KEY_PATH)) {
    try {
      const stored = (await fs.promises.readFile(STORAGE_KEY_PATH, 'utf-8')).trim()
      const key = stored.startsWith(KEY_PREFIX_OS)
        ? Buffer.from(safeStorage.decryptString(Buffer.from(stored.slice(KEY_PREFIX_OS.length), 'base64')), 'base64')
        : Buffer.from(stored.replace(KEY_PREFIX_RAW, ''), 'base64')
      if (isValidKey(key)) return key
    } catch (err) {
      console.error('Storage key unreadable, regenerating:', err)
    }
    await fs.promises.rename(STORAGE_KEY_PATH, `${STORAGE_KEY_PATH}.invalid-${Date.now()}`).catch(() => {})
  }
  const key = generateKey()
  const b64 = key.toString('base64')
  const serialized = safeStorage.isEncryptionAvailable()
    ? KEY_PREFIX_OS + safeStorage.encryptString(b64).toString('base64')
    : KEY_PREFIX_RAW + b64
  await fs.promises.writeFile(STORAGE_KEY_PATH, serialized, { mode: 0o600 })
  return key
}

let storageKeyPromise: Promise<Buffer> | null = null
function storageKey(): Promise<Buffer> {
  storageKeyPromise ??= getOrCreateStorageKey().catch((err) => { storageKeyPromise = null; throw err })
  return storageKeyPromise
}

async function readProviders(): Promise<StoredProvider[]> {
  if (!fs.existsSync(PROVIDERS_PATH)) return []
  try {
    const raw = await fs.promises.readFile(PROVIDERS_PATH, 'utf-8')
    const parsed = JSON.parse(decrypt(raw, await storageKey()))
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    // Keep the unreadable file for manual recovery instead of silently overwriting it later.
    console.error('Provider store unreadable, moving aside:', err)
    await fs.promises.rename(PROVIDERS_PATH, `${PROVIDERS_PATH}.corrupt-${Date.now()}`).catch(() => {})
    return []
  }
}

async function writeProviders(providers: StoredProvider[]): Promise<void> {
  const encrypted = encrypt(JSON.stringify(providers), await storageKey())
  const tmp = `${PROVIDERS_PATH}.tmp`
  await fs.promises.writeFile(tmp, encrypted, { mode: 0o600 })
  await fs.promises.rename(tmp, PROVIDERS_PATH)
}

// Serialise read-modify-write cycles so concurrent IPC calls cannot lose updates.
let providerQueue: Promise<unknown> = Promise.resolve()
function mutateProviders<T>(fn: (list: StoredProvider[]) => { list: StoredProvider[]; result: T }): Promise<T> {
  const run = providerQueue.then(async () => {
    const { list, result } = fn(await readProviders())
    await writeProviders(list)
    return result
  })
  providerQueue = run.catch(() => {})
  return run
}

// ---- models, sign-in and agent environment ---------------------------------
const GGUF_DIR = path.join(USER_DATA, 'gguf')
const hfAuth = new HfAuth(
  new EncryptedStore<StoredAuth>(path.join(USER_DATA, 'hf-auth.enc.json'), storageKey, () => null),
  (url) => shell.openExternal(url),
)
const ggufEngine = new GgufEngine(path.join(__dirname, 'gguf-worker.js'), path.join(USER_DATA, 'gguf.log'))
const modelIpc = registerModelIpc({ getSystem: () => ggufEngine.probeSystem(), ggufDir: GGUF_DIR, onnxCache: HF_CACHE, workerPath: path.join(__dirname, 'hf-worker.js'), auth: hfAuth })
const agentIpc = registerAgentIpc(new EncryptedStore<SshConnection[]>(path.join(USER_DATA, 'connections.enc.json'), storageKey, () => []))

// ---- validation ------------------------------------------------------------
const isHttpUrl = (v: string) => { try { return /^https?:$/.test(new URL(v).protocol) } catch { return false } }
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined)
const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback)

function parseProvider(raw: any): StoredProvider {
  const id = str(raw?.id, 100)
  const name = str(raw?.name, 100)
  if (!id || !name) throw new Error('Provider id and name are required')
  if (!PROVIDER_KINDS.includes(raw.kind)) throw new Error(`Unsupported provider kind: ${String(raw.kind)}`)
  const baseUrl = str(raw.baseUrl, 500)
  if (baseUrl && !isHttpUrl(baseUrl)) throw new Error('Base URL must be an http(s) URL')
  return {
    id, name, kind: raw.kind,
    apiKey: str(raw.apiKey, 500), baseUrl, defaultModel: str(raw.defaultModel, 200),
    enabled: raw.enabled !== false,
    ...(raw.local === true || raw.kind === 'huggingface-local' ? { local: true } : {}),
  }
}

// ---- settings persistence --------------------------------------------------
type Settings = { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; maxTokens?: number; theme?: 'light' | 'dark'; fontSize?: number; workspace?: string; permissionMode?: PermissionMode }
const DEFAULT_SETTINGS: Settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, theme: 'dark', fontSize: 14, permissionMode: 'workspace-auto' }
const DEEPSEEK_ID = 'deepseek'

function readSettingsFile(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Settings
  } catch (err) {
    console.error('settings.json unreadable, using defaults:', err)
  }
  return {}
}

function writeSettingsFile(settings: Settings) {
  const tmp = `${SETTINGS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, SETTINGS_PATH)
}

/** The DeepSeek API key lives in the encrypted store, never in settings.json. */
async function setDeepseekKey(apiKey: string | undefined): Promise<void> {
  await mutateProviders((list) => {
    const idx = list.findIndex((p) => p.id === DEEPSEEK_ID)
    const base: StoredProvider = idx >= 0 ? list[idx] : { id: DEEPSEEK_ID, name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', enabled: true }
    const next = { ...base, apiKey }
    return { list: idx >= 0 ? list.map((p, i) => (i === idx ? next : p)) : [...list, next], result: undefined }
  })
}

async function loadSettings(): Promise<Settings> {
  const file = readSettingsFile()
  if (typeof file.apiKey === 'string' && file.apiKey) {
    // Migrate legacy plaintext key into the encrypted store.
    await setDeepseekKey(file.apiKey)
    const { apiKey: _legacy, ...rest } = file
    writeSettingsFile(rest)
    Object.assign(file, rest)
  }
  const providers = await readProviders()
  return { ...DEFAULT_SETTINGS, ...file, apiKey: providers.find((p) => p.id === DEEPSEEK_ID)?.apiKey }
}

async function saveSettings(raw: any): Promise<Settings> {
  const baseUrl = str(raw?.baseUrl, 500)
  if (baseUrl && !isHttpUrl(baseUrl)) throw new Error('Base URL must be an http(s) URL')
  const { apiKey: _ignored, ...current } = readSettingsFile()
  const next: Settings = {
    ...current,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(str(raw?.model, 200) ? { model: str(raw.model, 200) } : {}),
    ...(raw?.temperature !== undefined ? { temperature: clamp(raw.temperature, 0, 2, 0.7) } : {}),
    ...(raw?.maxTokens !== undefined ? { maxTokens: Math.round(clamp(raw.maxTokens, 1, 131072, 4096)) } : {}),
    ...(raw?.theme === 'light' || raw?.theme === 'dark' ? { theme: raw.theme } : {}),
    ...(raw?.fontSize !== undefined ? { fontSize: Math.round(clamp(raw.fontSize, 8, 32, 14)) } : {}),
    ...(raw && 'workspace' in raw ? { workspace: validWorkspace(raw.workspace) ?? undefined } : {}),
    ...(isPermissionMode(raw?.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
  }
  writeSettingsFile(next)
  if (raw && 'apiKey' in raw) await setDeepseekKey(str(raw.apiKey, 500))
  return loadSettings()
}

// ---- IPC: app / settings / providers ---------------------------------------
const PATH_NAMES = new Set(['userData', 'documents', 'downloads', 'desktop', 'home', 'temp'])

ipcMain.handle('app:getPath', (_e, name: string) => (PATH_NAMES.has(name) ? app.getPath(name as 'userData') : null))
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isPackaged', () => app.isPackaged)

ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:set', (_e, settings) => saveSettings(settings))

ipcMain.handle('providers:list', () => readProviders())
ipcMain.handle('providers:get', async (_e, id: string) => (await readProviders()).find((p) => p.id === id) ?? null)
ipcMain.handle('providers:set', async (_e, raw) => {
  const config = parseProvider(raw)
  await mutateProviders((list) => {
    const idx = list.findIndex((p) => p.id === config.id)
    return { list: idx >= 0 ? list.map((p, i) => (i === idx ? config : p)) : [...list, config], result: undefined }
  })
})
ipcMain.handle('providers:remove', (_e, id: string) =>
  mutateProviders((list) => ({ list: list.filter((p) => p.id !== id), result: undefined })))
ipcMain.handle('providers:listModels', async (_e, providerId: string) => {
  const cfg = (await readProviders()).find((x) => x.id === providerId)
  const provider = cfg ? resolveProvider(cfg) : providerRegistry.get(providerId)
  if (!provider) return []
  const models = await provider.listModels({
    id: provider.id, name: provider.name, kind: provider.kind,
    apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, defaultModel: cfg?.defaultModel, enabled: cfg?.enabled !== false,
  })
  if (provider.kind !== 'huggingface-local') {
    return models.map((m) => ({ ...m, profile: m.profile ?? buildProfile({ id: m.id, runtime: 'cloud', contextLength: m.contextWindow }) }))
  }
  // Only models that are on disk can be chatted with; others are fetched on the models page.
  return (await modelIpc.listLocalModels()).map((m) => ({ id: m.id, name: m.name, provider: provider.id, kind: provider.kind, local: true, downloaded: true, profile: m.profile }))
})

ipcMain.handle('dialog:openFile', async () => {
  const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Документы', extensions: ['txt', 'md', 'py', 'js', 'ts', 'json', 'csv', 'log'] }, { name: 'Все файлы', extensions: ['*'] }] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.filePaths
})
ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
  const options: Electron.SaveDialogOptions = { defaultPath: str(defaultName, 255), filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Текст', extensions: ['txt'] }] }
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  return result.filePath ?? null
})

ipcMain.handle('window:openSettings', () => createSettingsWindow())
ipcMain.handle('window:quit', () => app.quit())
ipcMain.handle('window:minimize', () => mainWindow?.minimize())

// ---- IPC: chat streaming ---------------------------------------------------
const MAX_MESSAGES = 500
const ROLES = new Set(['system', 'user', 'assistant'])

type ChatRequest = { providerId: string; model: string; messages: Message[]; temperature: number; maxTokens: number; signalId: string; agent: boolean; thinking: boolean }

function parseChatRequest(raw: any): ChatRequest {
  const providerId = str(raw?.providerId, 100)
  const model = str(raw?.model, 200)
  const signalId = str(raw?.signalId, 100)
  if (!providerId || !model || !signalId) throw new Error('providerId, model and signalId are required')
  if (!Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > MAX_MESSAGES) {
    throw new Error('messages must be a non-empty array')
  }
  const messages: Message[] = raw.messages
    .filter((m: any) => m && ROLES.has(m.role) && typeof m.content === 'string' && m.content.trim() !== '')
    .map((m: any) => ({ role: m.role, content: m.content }))
  if (messages.length === 0) throw new Error('No non-empty messages to send')
  return {
    providerId, model, messages, signalId, agent: raw.agent === true, thinking: raw.thinking === true,
    temperature: clamp(raw.temperature, 0, 2, 0.7),
    maxTokens: Math.round(clamp(raw.maxTokens, 1, 131072, 4096)),
  }
}

/** Small local models drift into other languages (often Chinese) unless told not to. */
const LOCAL_LANGUAGE_PROMPT = 'You are a helpful assistant. Always answer in the same language as the latest user message and do not mix languages.'
const withLanguagePrompt = (messages: Message[]): Message[] =>
  messages.some((m) => m.role === 'system') ? messages : [{ role: 'system', content: LOCAL_LANGUAGE_PROMPT }, ...messages]

ipcMain.handle('chat:stream', async (event, raw) => {
  const req = parseChatRequest(raw)
  if (activeStreams.has(req.signalId)) throw new Error('Stream id already in use')

  const saved = (await readProviders()).find((x) => x.id === req.providerId)
  let cfg = saved ?? builtinConfig(req.providerId)
  // Hugging Face's hosted API works with the signed-in account, no token needed.
  if (!cfg && req.providerId === 'huggingface-api') cfg = { id: 'huggingface-api', name: 'Hugging Face (API)', kind: 'huggingface-api', enabled: true }
  if (!cfg || cfg.enabled === false) throw new Error(`Provider ${req.providerId} is not configured or disabled`)
  const provider = resolveProvider(cfg)
  if (!provider) throw new Error(`Provider ${req.providerId} not found`)
  const apiKey = cfg.apiKey || (cfg.kind === 'huggingface-api' ? (await hfAuth.getToken()) ?? undefined : undefined)
  const providerConfig = { id: cfg.id, name: cfg.name, kind: cfg.kind, enabled: true, apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel }

  const controller = new AbortController()
  activeStreams.set(req.signalId, controller)
  const sender = event.sender
  const send = (chunk: Record<string, unknown>) => {
    if (!sender.isDestroyed()) sender.send('chat:chunk', { streamId: req.signalId, ...chunk })
  }
  const sendEvent = (e: AgentEvent) => {
    if (e.type === 'text' || e.type === 'thought') { if (e.content) send({ type: e.type, content: e.content }) } else send(e)
  }

  try {
    const settings = await loadSettings()
    const workspace = validWorkspace(settings.workspace)
    const ggufPath = isGgufModelId(req.model) ? modelIpc.ggufPath(req.model) : null
    if (isGgufModelId(req.model) && (!ggufPath || !fs.existsSync(ggufPath))) throw new Error('Модель GGUF не найдена на диске: скачайте её в разделе «Локальные модели»')

    if (req.agent) {
      if (isLocalHf(cfg) && !ggufPath) throw new Error('Агентный режим недоступен для ONNX-моделей: скачайте GGUF-модель или используйте провайдера с API')
      const ctx = agentIpc.createContext(sender, workspace, settings.permissionMode ?? 'workspace-auto', controller.signal)
      try {
        if (ggufPath) {
          const messages = [{ role: 'system' as const, content: buildSystemPrompt(workspace) }, ...req.messages]
          for await (const e of ggufEngine.chat({
            modelPath: ggufPath, messages, tools: toolDefs(), thinking: req.thinking, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal,
            runTool: (call) => executeTool(call.name, call.arguments, ctx), summarize: summarizeCall,
          })) { sendEvent(e); if (e.type === 'error') break }
        } else {
          await runAgent({ provider, config: providerConfig, model: req.model, history: req.messages, ctx, temperature: req.temperature, maxTokens: req.maxTokens, onEvent: sendEvent })
        }
      } finally {
        ctx.remote.closeAll()
      }
    } else if (ggufPath) {
      for await (const e of ggufEngine.chat({ modelPath: ggufPath, messages: withLanguagePrompt(req.messages), thinking: req.thinking, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal })) {
        sendEvent(e)
        if (e.type === 'error') break
      }
    } else {
      const stream: AsyncGenerator<ChatChunk> = isLocalHf(cfg)
        ? runLocalModel({
            workerPath: path.join(__dirname, 'hf-worker.js'), cacheDir: HF_CACHE, model: req.model,
            messages: withLanguagePrompt(req.messages), temperature: req.temperature, maxTokens: Math.min(req.maxTokens, 2048),
            signal: controller.signal,
          })
        : provider.chat({ model: req.model, messages: req.messages, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal, config: providerConfig })

      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) send(chunk)
        else if (chunk.type === 'error') { send(chunk); break }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    activeStreams.delete(req.signalId)
    send({ type: 'done' })
  }
})

ipcMain.handle('chat:cancel', (_e, signalId: string) => { activeStreams.get(signalId)?.abort() })

// ---- auto-updater ----------------------------------------------------------
type Updater = typeof import('electron-updater').autoUpdater
let updater: Updater | null = null

function setupUpdater() {
  if (IS_DEV) return
  try {
    updater = require('electron-updater').autoUpdater as Updater
    updater.on('update-available', () => mainWindow?.webContents.send('update:available'))
    updater.on('update-downloaded', () => mainWindow?.webContents.send('update:downloaded'))
    updater.on('error', (err) => console.error('Auto-update error:', err))
    updater.checkForUpdatesAndNotify().catch((err) => console.error('Update check failed:', err))
  } catch (err) {
    console.error('Auto-updater unavailable:', err)
  }
}

ipcMain.handle('update:install', () => { isQuitting = true; updater?.quitAndInstall() })

// ---- lifecycle -------------------------------------------------------------
// Crash trail: a bug report with app.log beats "it just closed".
const APP_LOG = path.join(USER_DATA, 'app.log')
function logLine(text: string) {
  try { fs.appendFileSync(APP_LOG, `[${new Date().toISOString()}] ${text}
`) } catch { /* logging must never break the app */ }
}
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); logLine(`uncaughtException: ${err?.stack ?? err}`) })
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); logLine(`unhandledRejection: ${(err as Error)?.stack ?? err}`) })
app.on('render-process-gone', (_event, contents, details) => {
  logLine(`render-process-gone: ${details.reason} (exit ${details.exitCode})`)
  if (details.reason !== 'clean-exit' && !isQuitting && !contents.isDestroyed()) contents.reload()
})
app.on('child-process-gone', (_event, details) => logLine(`child-process-gone: ${details.type} ${details.reason} (exit ${details.exitCode})`))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    createMenu()
    createWindow()
    createTray()
    setupUpdater()
    app.on('activate', showMainWindow)
  }).catch((err) => {
    console.error('Startup failed:', err)
    dialog.showErrorBox('DeepSeek Harness', `Не удалось запустить приложение: ${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  })
}

app.on('before-quit', () => {
  isQuitting = true
  activeStreams.forEach((c) => c.abort())
  ggufEngine.dispose()
  if (tray) { tray.destroy(); tray = null }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

export { }
