/**
 * DeepSeek Harness Desktop — Electron main process.
 * Application lifecycle, windows, tray, IPC handlers, auto-updater.
 */

import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { autoUpdater } from 'electron-updater'

// ---- paths ---------------------------------------------------------------
const IS_DEV = process.env.NODE_ENV === 'development' || !process.env.APP_IS_PACKAGED
const USER_DATA = app.getPath('userData')
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json')

// ---- windows -------------------------------------------------------------
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let settingsWindow: BrowserWindow | null = null

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

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    title: 'Настройки — DeepSeek Harness',
    width: 700,
    height: 560,
    minWidth: 600,
    minHeight: 480,
    modal: true,
    parent: mainWindow || undefined,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const url = IS_DEV
    ? 'http://127.0.0.1:5173/#/settings'
    : `file://${path.join(__dirname, '..', 'dist', 'renderer', 'index.html')}#/settings`
  settingsWindow.loadURL(url)
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'resources', 'tray.png')
  const icon = fs.existsSync(iconPath) ? require('electron').nativeImage.createFromPath(iconPath) : null
  tray = new Tray(icon || undefined)
  tray.setToolTip('DeepSeek Harness')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть DeepSeek Harness', click: () => mainWindow?.show() },
    { label: 'Настройки', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => mainWindow?.show())
}

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: 'О программе', role: 'about' },
        { type: 'separator' },
        { label: 'Настройки', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow },
        { type: 'separator' },
        { label: 'Выйти', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Редактировать',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Перезагрузить', role: 'reload' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Увеличить', role: 'zoomIn' },
        { label: 'Уменьшить', role: 'zoomOut' },
        { label: 'Сброс масштаба', role: 'resetZoom' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { label: 'Минимизировать', role: 'minimize' },
        { label: 'Закрыть', role: 'close' },
        { label: 'Всегда поверх', type: 'checkbox', checked: false, click: (item) => {
          mainWindow?.setAlwaysOnTop(item.checked)
        } },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/Chistovik92/Harness') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- settings persistence -------------------------------------------------
type Settings = {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  theme?: 'light' | 'dark'
  fontSize?: number
}

const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 4096,
  theme: 'dark',
  fontSize: 14,
}

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: Partial<Settings>) {
  const current = loadSettings()
  const next = { ...current, ...settings }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2))
}

// ---- IPC handlers ---------------------------------------------------------
ipcMain.handle('app:getPath', (_: any, name: string) => {
  try {
    return app.getPath(name as any)
  } catch {
    return null
  }
})

ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isPackaged', () => process.env.APP_IS_PACKAGED === 'true' || !IS_DEV)

ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:set', (_: any, settings: Partial<Settings>) => {
  saveSettings(settings)
  return loadSettings()
})

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Документы', extensions: ['txt', 'md', 'py', 'js', 'ts', 'json', 'csv', 'log'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  })
  return result.filePaths
})

ipcMain.handle('dialog:saveFile', async (_: any, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Текст', extensions: ['txt'] }],
  })
  return result.filePath ?? null
})

ipcMain.handle('window:openSettings', createSettingsWindow)
ipcMain.handle('window:quit', () => app.quit())
ipcMain.handle('window:minimize', () => mainWindow?.minimize())

// ---- auto-updater ---------------------------------------------------------
function setupUpdater() {
  if (IS_DEV) return
  autoUpdater.logger = require('electron-log')
  autoUpdater.checkForUpdatesAndNotify()
  autoUpdater.on('update-available', () => {
    mainWindow?.webContents.send('update:available')
  })
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update:downloaded')
  })
}

// ---- lifecycle ------------------------------------------------------------
app.whenReady().then(() => {
  createMenu()
  createWindow()
  createTray()
  setupUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (tray) { tray.destroy(); tray = null }
})

export { }
