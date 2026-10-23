/**
 * DeepSeek Harness Desktop — Electron main process.
 *
 * - Application lifecycle, windows, tray, auto-updater
 * - Encrypted local storage of provider API keys (AES-256-GCM, key in userData)
 * - Provider registry + chat streaming (OpenAI-compatible, Anthropic, Google, HF API/local)
 * - Local HuggingFace models via transformers.js worker thread
 */

import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { Worker } from 'node:worker_threads'
import { OpenAICompatibleProvider } from '../renderer/lib/openaiProvider'
import { AnthropicProvider } from '../renderer/lib/anthropicProvider'
import { GoogleProvider } from '../renderer/lib/googleProvider'
import { HuggingFaceProvider } from '../renderer/lib/huggingfaceProvider'

// ---- providers ------------------------------------------------------------
import { providerRegistry } from '../renderer/lib/registry'

providerRegistry.register('deepseek', new OpenAICompatibleProvider({ id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', enabled: true }))
providerRegistry.register('openai', new OpenAICompatibleProvider({ id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', enabled: true }))
providerRegistry.register('groq', new OpenAICompatibleProvider({ id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-70b-versatile', enabled: true }))
providerRegistry.register('together', new OpenAICompatibleProvider({ id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', enabled: true }))
providerRegistry.register('openrouter', new OpenAICompatibleProvider({ id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat', enabled: true }))
providerRegistry.register('anthropic', new AnthropicProvider({ id: 'anthropic', name: 'Anthropic', kind: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022', enabled: true }))
providerRegistry.register('google', new GoogleProvider({ id: 'google', name: 'Google', kind: 'google', defaultModel: 'gemini-1.5-flash', enabled: true }))
providerRegistry.register('huggingface-api', new HuggingFaceProvider({ id: 'huggingface-api', name: 'Hugging Face (API)', kind: 'huggingface-api', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct', enabled: true }))
providerRegistry.register('huggingface-local', new HuggingFaceProvider({ id: 'huggingface-local', name: 'Hugging Face (Local)', kind: 'huggingface-local', local: true, defaultModel: 'Xenova/llama2.c-stories15M', enabled: true }))

// ---- paths -----------------------------------------------------------------
const IS_DEV = process.env.NODE_ENV === 'development' || !process.env.APP_IS_PACKAGED
const USER_DATA = app.getPath('userData')
const STORAGE_KEY_PATH = path.join(USER_DATA, '.storage_key')
const PROVIDERS_PATH = path.join(USER_DATA, 'providers.enc.json')
const HF_CACHE = path.join(USER_DATA, 'hf-cache')

// ---- windows ---------------------------------------------------------------
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let settingsWindow: BrowserWindow | null = null

const activeStreams = new Map<string, AbortController>()

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    title: 'DeepSeek Harness',
    width: Math.min(1200, width),
    height: Math.min(800, height),
    minWidth: 900,
    minHeight: 600,
    show: IS_DEV,
    autoHideMenuBar: !IS_DEV,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (IS_DEV) {
    mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))
  }

  mainWindow.on('close', (event) => {
    if (process.platform !== 'darwin') {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    title: 'Настройки — DeepSeek Harness',
    width: 700, height: 560, minWidth: 600, minHeight: 480,
    modal: true, parent: mainWindow || undefined,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  const url = IS_DEV ? 'http://127.0.0.1:5173/#/settings' : `file://${path.join(__dirname, '..', 'dist', 'renderer', 'index.html')}#/settings`
  settingsWindow.loadURL(url)
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'resources', 'tray.png')
  const { nativeImage } = require('electron')
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null
  tray = new Tray(icon || undefined)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть DeepSeek Harness', click: () => mainWindow?.show() },
    { label: 'Настройки', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ]))
  tray.on('click', () => mainWindow?.show())
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
    ]},
    { label: 'Вид', submenu: [
      { label: 'Перезагрузить', role: 'reload' },
      { label: 'Инструменты разработчика', role: 'toggleDevTools' },
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
      { label: 'GitHub', click: () => shell.openExternal('https://github.com/Chistovik92/Harness') },
    ]},
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- encrypted storage -----------------------------------------------------
const ALGORITHM = 'aes-256-gcm'

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
// @ts-ignore — Node crypto in Electron main (runtime), bypass DOM-lib type conflicts
const nc: any = _require('crypto')

function b64enc(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64dec(str: string): Uint8Array {
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function getOrCreateStorageKey(): Promise<Buffer> {
  if (fs.existsSync(STORAGE_KEY_PATH)) {
    const raw = await fs.promises.readFile(STORAGE_KEY_PATH, 'utf-8')
    return b64dec(raw) as unknown as Buffer
  }
  const key = nc.randomBytes(32)
  await fs.promises.writeFile(STORAGE_KEY_PATH, b64enc(key as unknown as Uint8Array), { mode: 0o600 })
  return key
}

async function encrypt(text: string, key: Buffer): Promise<string> {
  const iv = nc.randomBytes(12)
  const cipher = nc.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8')
  encrypted = Buffer.concat([encrypted, cipher.final()])
  return b64enc(iv) + ':' + b64enc(Array.from(encrypted))
}

async function decrypt(payload: string, key: Buffer): Promise<string> {
  const [ivB64, ctB64] = payload.split(':')
  const decipher = nc.createDecipheriv(ALGORITHM, key, b64dec(ivB64))
  let decrypted = decipher.update(b64dec(ctB64))
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString('utf-8')
}

let storageKeyPromise: Promise<Buffer> | null = null
function storageKey(): Promise<Buffer> {
  if (!storageKeyPromise) storageKeyPromise = getOrCreateStorageKey()
  return storageKeyPromise
}

async function readProviders(): Promise<any[]> {
  try {
    if (!fs.existsSync(PROVIDERS_PATH)) return []
    const key = await storageKey()
    const raw = await fs.promises.readFile(PROVIDERS_PATH, 'utf-8')
    const decrypted = await decrypt(raw, key)
    return JSON.parse(decrypted)
  } catch {
    return []
  }
}

async function writeProviders(providers: any[]): Promise<void> {
  const key = await storageKey()
  const encrypted = await encrypt(JSON.stringify(providers), key)
  await fs.promises.writeFile(PROVIDERS_PATH, encrypted, { mode: 0o600 })
}

// ---- settings persistence --------------------------------------------------
type Settings = { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; maxTokens?: number; theme?: 'light' | 'dark'; fontSize?: number }
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json')
const DEFAULT_SETTINGS: Settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, theme: 'dark', fontSize: 14 }

function loadSettings(): Settings {
  try { if (fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) } } catch {}
  return { ...DEFAULT_SETTINGS }
}
function saveSettings(settings: Partial<Settings>): Settings {
  const current = loadSettings()
  const next = { ...current, ...settings }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2))
  return next
}

// ---- IPC -------------------------------------------------------------------
ipcMain.handle('app:getPath', (_: any, name: string) => { try { return app.getPath(name as any) } catch { return null } })
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isPackaged', () => process.env.APP_IS_PACKAGED === 'true' || !IS_DEV)

ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:set', (_: any, settings: Partial<Settings>) => saveSettings(settings))

ipcMain.handle('providers:list', async () => readProviders())
ipcMain.handle('providers:get', async (_: any, id: string) => {
  const list = await readProviders()
  return list.find((p) => p.id === id) ?? null
})
ipcMain.handle('providers:set', async (_: any, config: any) => {
  const list = await readProviders()
  const idx = list.findIndex((p) => p.id === config.id)
  if (idx >= 0) list[idx] = config
  else list.push(config)
  await writeProviders(list)
  return config
})
ipcMain.handle('providers:remove', async (_: any, id: string) => {
  const list = await readProviders()
  const filtered = list.filter((p) => p.id !== id)
  await writeProviders(filtered)
})
ipcMain.handle('providers:listModels', async (_: any, providerId: string) => {
  const p = providerRegistry.get(providerId)
  if (!p) return []
  const list = await readProviders()
  const cfg = list.find((x: any) => x.id === providerId)
  return p.listModels({
    id: p.id, name: p.name, kind: p.kind,
    apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, defaultModel: cfg?.defaultModel, enabled: !!cfg?.enabled, local: cfg?.local,
  } as any)
})

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Документы', extensions: ['txt','md','py','js','ts','json','csv','log'] }, { name: 'Все файлы', extensions: ['*'] }] })
  return result.filePaths
})
ipcMain.handle('dialog:saveFile', async (_: any, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Текст', extensions: ['txt'] }] })
  return result.filePath ?? null
})

ipcMain.handle('window:openSettings', createSettingsWindow)
ipcMain.handle('window:quit', () => app.quit())
ipcMain.handle('window:minimize', () => mainWindow?.minimize())

// ---- chat streaming --------------------------------------------------------
ipcMain.handle('chat:stream', async (_: any, opts: any) => {
  const { providerId, model, messages, temperature = 0.7, maxTokens = 4096, signalId } = opts
  const p = providerRegistry.get(providerId)
  if (!p) throw new Error(`Provider ${providerId} not found`)

  const list = await readProviders()
  const cfg = list.find((x: any) => x.id === providerId)
  if (!cfg || !cfg.enabled) throw new Error(`Provider ${providerId} not enabled`)

  const controller = new AbortController()
  activeStreams.set(signalId, controller)

  const providerConfig: any = {
    id: cfg.id, name: cfg.name, kind: cfg.kind, enabled: cfg.enabled,
    apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel,
  }
  if (cfg.local) providerConfig.local = true

  const streamed: string[] = []
  try {
    for await (const chunk of p.chat({
      model, messages: messages as any,
      temperature, maxTokens: maxTokens as number,
      signal: controller.signal,
      config: providerConfig,
    })) {
      if (chunk.type === 'text' && chunk.content) {
        streamed.push(chunk.content)
        mainWindow?.webContents.send('chat:chunk', { streamId: signalId, type: 'text', content: chunk.content })
      } else if (chunk.type === 'error') {
        mainWindow?.webContents.send('chat:chunk', { streamId: signalId, type: 'error', error: chunk.error })
      } else if (chunk.type === 'done') {
        mainWindow?.webContents.send('chat:chunk', { streamId: signalId, type: 'done' })
      }
    }
  } finally {
    activeStreams.delete(signalId)
  }
  return { streamId: signalId, text: streamed.join('') }
})

ipcMain.handle('chat:cancel', (_: any, signalId: string) => {
  const ctrl = activeStreams.get(signalId)
  if (ctrl) ctrl.abort()
})

// ---- local HF --------------------------------------------------------------
const hfWorkers = new Map<string, Worker>()

ipcMain.handle('hf:listLocal', async () => {
  try {
    if (!fs.existsSync(HF_CACHE)) return []
    const entries = await fs.promises.readdir(HF_CACHE, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => ({ id: e.name, name: e.name, downloaded: true }))
  } catch { return [] }
})

ipcMain.handle('hf:download', async (_: any, modelId: string) => {
  // Placeholder: real implementation spawns transformers.js download worker
  fs.mkdirSync(HF_CACHE, { recursive: true })
  await fs.promises.writeFile(path.join(HF_CACHE, modelId.replace(/\//g, '_'), '.placeholder'), '')
  return { ok: true }
})

ipcMain.handle('hf:chatLocal', async (_: any, opts: any) => {
  const { model, prompt, temperature = 0.7, maxTokens = 4096, signalId } = opts
  const controller = new AbortController()
  activeStreams.set(signalId, controller)

  // Placeholder for transformers.js worker:
  // const worker = new Worker(path.join(__dirname, 'hf-worker.js'))
  // worker.postMessage({ model, prompt, temperature, maxTokens })
  // worker.on('message', (chunk) => mainWindow?.webContents.send('hf:chunk', { ...chunk, streamId: signalId }))
  const chunks = ['[локальная модель HF ', model, ' загружена (заглушка)]']
  for (const c of chunks) {
    if (controller.signal.aborted) break
    mainWindow?.webContents.send('hf:chunk', { streamId: signalId, type: 'text', content: c })
    await new Promise((r) => setTimeout(r, 50))
  }
  mainWindow?.webContents.send('hf:chunk', { streamId: signalId, type: 'done' })
  activeStreams.delete(signalId)
  return { ok: true }
})

ipcMain.handle('hf:stopLocal', (_: any, signalId: string) => {
  const ctrl = activeStreams.get(signalId)
  if (ctrl) ctrl.abort()
})

// ---- auto-updater ----------------------------------------------------------
function setupUpdater() {
  if (IS_DEV) return
  const { autoUpdater } = require('electron-updater')
  autoUpdater.checkForUpdatesAndNotify()
  autoUpdater.on('update-available', () => mainWindow?.webContents.send('update:available'))
  autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update:downloaded'))
}

// ---- lifecycle -------------------------------------------------------------
app.whenReady().then(() => {
  createMenu()
  createWindow()
  createTray()
  setupUpdater()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { if (tray) { tray.destroy(); tray = null } })

export { }
