/**
 * DeepSeek Harness Desktop - Electron main process.
 *
 * Runs the Harness workspace in a native Electron application shell.
 * Loads the packaged Web entry at `dsh-app://app/`, manages the Host lifecycle,
 * tray icon (Windows), auto-updates, and the dsh command registration.
 */

import { app, BrowserWindow, ipcMain, nativeImage, Tray, screen, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

let mainWindow = null
let tray = null
let isQuitting = false

const APP_NAME = 'DeepSeek Harness'
const IS_DEV = process.env.NODE_ENV === 'development' || !process.env.APP_IS_PACKAGED
const USER_DATA_DIR = app.getPath('userData')

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    title: APP_NAME,
    width: Math.min(1280, width),
    height: Math.min(800, height),
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '..', 'resources', 'icon-windows.png'),
  })

  // Load bundled Web entry or dev server
  if (IS_DEV) {
    win.loadURL('http://127.0.0.1:3080').catch(() => {
      // fall back to packaged loading page
      win.loadFile(path.join(__dirname, 'loading.html'))
    })
  } else {
    win.loadFile(path.join(__dirname, 'loading.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('close', (event) => {
    if (!isQuitting && process.platform === 'win32') {
      event.preventDefault()
      win.hide()
      return
    }
    destroyWindow()
  })

  mainWindow = win
  return win
}

function destroyWindow() {
  mainWindow = null
  if (isQuitting && process.platform !== 'darwin') {
    app.quit()
  }
}

function createTray() {
  if (tray) return
  const iconPath = path.join(__dirname, '..', 'resources', 'tray-windows.ico')
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)

  const contextMenu = null // populated by renderer via IPC if desired
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createMainWindow()
    }
  })

  app.on('before-quit', () => {
    if (tray) {
      tray.destroy()
      tray = null
    }
  })
}

app.whenReady().then(() => {
  createMainWindow()

  if (process.platform === 'win32') {
    createTray()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
})

// Expose app paths for installer / dsh command registration
ipcMain.handle('app:getPath', (_, name) => {
  try {
    return app.getPath(name)
  } catch (err) {
    return null
  }
})

ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

ipcMain.handle('app:isPackaged', () => {
  return process.env.APP_IS_PACKAGED === 'true' || !IS_DEV
})

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  })
  return result
})
