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
import fs from 'node:fs'
import path from 'node:path'

import { OpenAICompatibleProvider } from '../renderer/lib/openaiProvider'
import { AnthropicProvider } from '../renderer/lib/anthropicProvider'
import { GoogleProvider } from '../renderer/lib/googleProvider'
import { HuggingFaceProvider } from '../renderer/lib/huggingfaceProvider'
import { providerRegistry } from '../renderer/lib/registry'
import type { LLMProvider, ProviderKind, Message, ChatChunk } from '../renderer/lib/providers'
import { encrypt, decrypt, generateKey, isValidKey } from './secureStore'
import { runLocalModel } from './localHf'
import { GgufEngine } from './gguf'
import { DEFAULT_MODELS } from '../renderer/lib/cloudModels'
import { registerModelIpc, isGgufModelId } from './ipcModels'
import { registerAgentIpc, isPermissionMode, validWorkspace } from './ipcAgent'
import { HfAuth, type StoredAuth } from './hfAuth'
import { EncryptedStore } from './store'
import type { SshConnection } from './agent/remote'
import type { PermissionMode } from './agent/permissions'
import { runAgent, executeTool, toolDefs, summarizeCall, buildSystemPrompt, loadExtensionsHandle, allToolSpecs, type AgentEvent, type ExtensionsHandle } from './agent/loop'
import { webSearch, htmlToText } from './agent/tools'
import { McpManager, loadExtensions, saveExtensions, collectSkills, parseMcpJson, parseOpenCodeConfig, parseCodexConfig, type ExtensionsConfig, type McpServerConfig } from './extensions'
import { buildProfile } from '../renderer/lib/modelProfile'

// ---- providers -------------------------------------------------------------
type StoredProvider = {
  id: string; name: string; kind: ProviderKind
  apiKey?: string; baseUrl?: string; defaultModel?: string
  customModels?: string[]
  enabled: boolean; local?: boolean
}

const PROVIDER_KINDS: ProviderKind[] = ['openai-compatible', 'anthropic', 'google', 'huggingface-api', 'huggingface-local']

function oai(id: string, name: string, baseUrl: string, defaultModel: string) {
  providerRegistry.register(id, new OpenAICompatibleProvider({ id, name, kind: 'openai-compatible', baseUrl, defaultModel, enabled: true }))
}
oai('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', DEFAULT_MODELS.deepseek)
oai('openai', 'OpenAI', 'https://api.openai.com/v1', DEFAULT_MODELS.openai)
oai('groq', 'Groq', 'https://api.groq.com/openai/v1', DEFAULT_MODELS.groq)
oai('together', 'Together AI', 'https://api.together.xyz/v1', DEFAULT_MODELS.together)
oai('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', DEFAULT_MODELS.openrouter)
providerRegistry.register('anthropic', new AnthropicProvider({ id: 'anthropic', name: 'Anthropic', kind: 'anthropic', defaultModel: DEFAULT_MODELS.anthropic, enabled: true }))
providerRegistry.register('google', new GoogleProvider({ id: 'google', name: 'Google', kind: 'google', defaultModel: DEFAULT_MODELS.google, enabled: true }))
providerRegistry.register('huggingface-api', new HuggingFaceProvider({ id: 'huggingface-api', name: 'Hugging Face (API)', kind: 'huggingface-api', defaultModel: DEFAULT_MODELS['huggingface-api'], enabled: true }))
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

// ---- extensions: MCP servers, skills, model folders -------------------------
const EXTENSIONS_PATH = path.join(USER_DATA, 'extensions.json')
const mcpManager = new McpManager(EXTENSIONS_PATH, (file) => loadExtensions(file))
app.on('before-quit', () => mcpManager.stopAll())

function readExtensions(): ExtensionsConfig {
  return loadExtensions(EXTENSIONS_PATH)
}

function writeExtensions(next: ExtensionsConfig): void {
  saveExtensions(EXTENSIONS_PATH, next)
}

/** Everything the agent loop needs beyond the built-in tools. */
async function extensionsHandle(): Promise<ExtensionsHandle> {
  return loadExtensionsHandle(mcpManager, readExtensions())
}

const modelIpc = registerModelIpc({ getSystem: () => ggufEngine.probeSystem(), ggufDir: GGUF_DIR, onnxCache: HF_CACHE, workerPath: path.join(__dirname, 'hf-worker.js'), auth: hfAuth, userDataDir: USER_DATA, extensionsFile: EXTENSIONS_PATH, downloadDir: () => readExtensions().ggufDownloadDir, getWindow: () => mainWindow })
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
    customModels: Array.isArray(raw.customModels)
      ? raw.customModels.filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0).map((m: string) => m.trim().slice(0, 200)).slice(0, 100)
      : undefined,
    enabled: raw.enabled !== false,
    ...(raw.local === true || raw.kind === 'huggingface-local' ? { local: true } : {}),
  }
}

// ---- settings persistence --------------------------------------------------
type Settings = { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; maxTokens?: number; theme?: 'light' | 'dark'; fontSize?: number; workspace?: string; permissionMode?: PermissionMode; gguf?: { contextTokens?: number; gpuLayers?: number | 'auto' } }
const DEFAULT_SETTINGS: Settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', temperature: 0.7, maxTokens: 4096, theme: 'dark', fontSize: 14, permissionMode: 'workspace-auto' }
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
    const base: StoredProvider = idx >= 0 ? list[idx] : { id: DEEPSEEK_ID, name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-v4-pro', enabled: true }
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
    ...(raw?.gguf && typeof raw.gguf === 'object' ? {
      gguf: {
        ...(raw.gguf.contextTokens !== undefined ? { contextTokens: Math.round(clamp(raw.gguf.contextTokens, 512, 262144, 8192)) } : {}),
        ...(raw.gguf.gpuLayers !== undefined ? { gpuLayers: raw.gguf.gpuLayers === 'auto' ? 'auto' as const : Math.round(clamp(raw.gguf.gpuLayers, 0, 999, 0)) } : {}),
      },
    } : {}),
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
  // Models the user added by hand: always shown, even if the API does not list them.
  const known = new Set(models.map((m) => m.id))
  const custom = (cfg?.customModels ?? [])
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, provider: provider.id, kind: provider.kind, contextWindow: undefined as number | undefined, profile: undefined }))
  const merged: Array<{ id: string; name: string; provider: string; kind: ProviderKind; contextWindow?: number; profile?: unknown }> = [...models, ...custom]
  if (provider.kind !== 'huggingface-local') {
    return merged.map((m) => ({ ...m, profile: m.profile ?? buildProfile({ id: m.id, runtime: 'cloud', contextLength: m.contextWindow }) }))
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

type ChatRequest = { providerId: string; model: string; messages: Message[]; temperature: number; maxTokens: number; signalId: string; agent: boolean; thinking: boolean; web: boolean }

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
    providerId, model, messages, signalId, agent: raw.agent === true, thinking: raw.thinking === true, web: raw.web === true,
    temperature: clamp(raw.temperature, 0, 2, 0.7),
    maxTokens: Math.round(clamp(raw.maxTokens, 1, 131072, 4096)),
  }
}

/**
 * Plain-chat web access: URLs in the user's message are fetched, and search-like
 * questions get a DuckDuckGo lookup. The snippets are injected as context, so
 * every model (including local GGUF ones) can answer with current facts.
 */
const WEB_CONTEXT_URLS = 3
const WEB_CONTEXT_CHARS = 6000
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g

async function buildWebContext(messages: Message[], signal: AbortSignal): Promise<string | null> {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (!last) return null
  const parts: string[] = []

  const urls = [...new Set((last.content.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?)]+$/, '')))].slice(0, WEB_CONTEXT_URLS)
  for (const url of urls) {
    try {
      const res = await fetchUrl(url, signal)
      parts.push(`Содержимое ${url}:\n${res.slice(0, WEB_CONTEXT_CHARS)}`)
    } catch (err) {
      parts.push(`Содержимое ${url}: недоступно (${err instanceof Error ? err.message : err})`)
    }
    if (signal.aborted) return null
  }

  // A search-shaped question: current/news/price/score/«что такое … сегодня».
  if (/\b(сегодня|сейчас|последн|новост|актуальн|курс|цена|погода|who is|latest|news|price|today|current)\b/i.test(last.content) && urls.length === 0) {
    try {
      const hits = await webSearch(last.content.slice(0, 300), signal, 5)
      if (hits.length > 0) {
        parts.push(`Результаты поиска по запросу «${last.content.slice(0, 120)}»:\n${hits.map((h) => `- ${h.title}: ${h.url}${h.snippet ? ` — ${h.snippet.slice(0, 250)}` : ''}`).join('\n')}`)
      }
    } catch { /* search is best-effort */ }
  }

  if (parts.length === 0) return null
  return [
    'Web context (fetched automatically; may be incomplete or outdated):',
    ...parts,
    'Answer using this context when it is relevant; say so when the context is not enough.',
  ].join('\n\n')
}

/** GET a text page, stripped to plain text, size- and time-limited. */
async function fetchUrl(url: string, signal: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { 'User-Agent': 'DeepSeekHarness/1.0', Accept: 'text/html,application/json,text/plain,*/*' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!/text|json|xml|javascript|yaml/i.test(type)) throw new Error(`не текстовый ответ (${type})`)
  const text = await res.text()
  if (text.length > maxBytes) throw new Error('слишком большой ответ')
  return /html/i.test(type) ? htmlToText(text).slice(0, WEB_CONTEXT_CHARS * 2) : text
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
  const providerConfig = { id: cfg.id, name: cfg.name, kind: cfg.kind, enabled: true, apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel, customModels: cfg.customModels }

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
      const extensions = await extensionsHandle().catch(() => null)
      try {
        if (ggufPath) {
          const specs = await allToolSpecs(extensions)
          const messages = [{ role: 'system' as const, content: buildSystemPrompt(workspace, { skills: extensions?.skills ?? [], mcpTools: specs.filter((t) => t.def.name.startsWith('mcp__')).map((t) => t.def.name) }) }, ...req.messages]
          for await (const e of ggufEngine.chat({
            modelPath: ggufPath, messages, tools: specs.map((t) => t.def), thinking: req.thinking, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal,
            contextTokens: settings.gguf?.contextTokens, gpuLayers: settings.gguf?.gpuLayers,
            runTool: (call) => executeTool(call.name, call.arguments, ctx, specs), summarize: (call) => summarizeCall(call, specs),
          })) { sendEvent(e); if (e.type === 'error') break }
        } else {
          await runAgent({ provider, config: providerConfig, model: req.model, history: req.messages, ctx, temperature: req.temperature, maxTokens: req.maxTokens, extensions, onEvent: sendEvent })
        }
      } finally {
        ctx.remote.closeAll()
      }
    } else {
      // Web context gives every model — local ones included — fresh facts in plain chat.
      let messages = req.messages
      if (req.web) {
        const webContext = await buildWebContext(req.messages, controller.signal).catch(() => null)
        if (webContext) {
          send({ type: 'thought', content: 'Подключаю интернет-контекст…\n' })
          messages = [{ role: 'system', content: webContext }, ...req.messages]
        }
      }
      if (ggufPath) {
        for await (const e of ggufEngine.chat({ modelPath: ggufPath, messages: withLanguagePrompt(messages), thinking: req.thinking, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal, contextTokens: settings.gguf?.contextTokens, gpuLayers: settings.gguf?.gpuLayers })) {
          sendEvent(e)
          if (e.type === 'error') break
        }
      } else {
        const stream: AsyncGenerator<ChatChunk> = isLocalHf(cfg)
          ? runLocalModel({
              workerPath: path.join(__dirname, 'hf-worker.js'), cacheDir: HF_CACHE, model: req.model,
              messages: withLanguagePrompt(messages), temperature: req.temperature, maxTokens: Math.min(req.maxTokens, 2048),
              signal: controller.signal,
            })
          : provider.chat({ model: req.model, messages, temperature: req.temperature, maxTokens: req.maxTokens, signal: controller.signal, config: providerConfig })

        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.content) send(chunk)
          else if (chunk.type === 'error') { send(chunk); break }
        }
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

// ---- IPC: extensions (MCP servers, skills, connectors) -----------------------
const SKILLS_DIR = path.join(USER_DATA, 'skills')

ipcMain.handle('ext:get', async () => {
  const cfg = readExtensions()
  return {
    mcpServers: cfg.mcpServers,
    skillDirs: cfg.skillDirs,
    ggufDownloadDir: cfg.ggufDownloadDir ?? null,
    skills: collectSkills({ ...cfg, skillDirs: [...new Set([SKILLS_DIR, ...cfg.skillDirs])] }),
  }
})

ipcMain.handle('ext:setMcpServer', (_e, raw) => {
  const id = str(raw?.id, 80) ?? `mcp-${Date.now().toString(36)}`
  const command = str(raw?.command, 500)
  if (!command) throw new Error('command обязателен')
  const server: McpServerConfig = {
    id,
    name: str(raw?.name, 120) ?? id,
    command,
    args: Array.isArray(raw?.args) ? raw.args.filter((a: unknown): a is string => typeof a === 'string').slice(0, 50) : [],
    env: raw?.env && typeof raw.env === 'object'
      ? Object.fromEntries(Object.entries(raw.env).filter(([k, v]) => typeof k === 'string' && typeof v === 'string').slice(0, 30) as [string, string][])
      : undefined,
    enabled: raw?.enabled !== false,
  }
  const cfg = readExtensions()
  const idx = cfg.mcpServers.findIndex((s) => s.id === server.id)
  writeExtensions({ ...cfg, mcpServers: idx >= 0 ? cfg.mcpServers.map((s, i) => (i === idx ? server : s)) : [...cfg.mcpServers, server] })
  mcpManager.stopAll()
  return server
})

ipcMain.handle('ext:removeMcpServer', (_e, id: string) => {
  const cfg = readExtensions()
  writeExtensions({ ...cfg, mcpServers: cfg.mcpServers.filter((s) => s.id !== id) })
  mcpManager.stopAll()
})

/** Starts every enabled server and reports tool counts; failures come back per server. */
ipcMain.handle('ext:testMcp', async () => {
  const tools = await mcpManager.tools()
  const byServer = new Map<string, number>()
  for (const t of tools) byServer.set(t.serverId, (byServer.get(t.serverId) ?? 0) + 1)
  return readExtensions().mcpServers.map((s) => ({ id: s.id, name: s.name, toolCount: byServer.get(s.id) ?? 0, ok: byServer.has(s.id) }))
})

/** Imports MCP servers from a config file: Claude Code .mcp.json, opencode.json or Codex config.toml. */
ipcMain.handle('ext:importMcp', async () => {
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Конфиг MCP', extensions: ['json', 'toml'] }, { name: 'Все файлы', extensions: ['*'] }],
  }
  const win = mainWindow
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const file = result.filePaths[0]
  if (!file) return { imported: 0 }
  const text = await fs.promises.readFile(file, 'utf-8')
  const parsed = file.toLowerCase().endsWith('.toml')
    ? parseCodexConfig(text)
    : text.includes('"mcp.servers"') || text.includes('"mcp":')
      ? parseOpenCodeConfig(text)
      : parseMcpJson(text)
  if (parsed.length === 0) throw new Error('В файле не найдено MCP-серверов (ожидались mcpServers / mcp.servers / [mcp_servers.*])')
  const cfg = readExtensions()
  const existing = new Set(cfg.mcpServers.map((s) => s.id))
  const fresh = parsed.filter((s) => !existing.has(s.id)).map((s) => ({ ...s, id: existing.has(s.name) ? `${s.id}-${Date.now().toString(36)}` : s.name }))
  writeExtensions({ ...cfg, mcpServers: [...cfg.mcpServers, ...fresh].slice(0, 30) })
  return { imported: fresh.length }
})

ipcMain.handle('ext:addSkillDir', async () => {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
  const win = mainWindow
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const dir = result.filePaths[0]
  if (!dir) return null
  const cfg = readExtensions()
  if (!cfg.skillDirs.includes(dir)) writeExtensions({ ...cfg, skillDirs: [...cfg.skillDirs, dir].slice(0, 20) })
  return dir
})

ipcMain.handle('ext:removeSkillDir', (_e, dir: string) => {
  const cfg = readExtensions()
  writeExtensions({ ...cfg, skillDirs: cfg.skillDirs.filter((d) => d !== dir) })
})

ipcMain.handle('ext:openSkillsFolder', () => { void shell.openPath(SKILLS_DIR) })
ipcMain.handle('ext:openMcpConfig', () => { void shell.openPath(EXTENSIONS_PATH) })

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
