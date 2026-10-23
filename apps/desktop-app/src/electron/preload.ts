/**
 * Preload script — exposes a narrow, typed bridge to the renderer.
 * No raw filesystem, no shell, no arbitrary args reach the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron'

export type Settings = {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  theme?: 'light' | 'dark'
  fontSize?: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

type DshApi = {
  app: {
    getPath: (name: string) => Promise<string | null>
    getVersion: () => Promise<string>
    isPackaged: () => Promise<boolean>
  }
  settings: {
    get: () => Promise<Settings>
    set: (settings: Partial<Settings>) => Promise<Settings>
  }
  dialog: {
    openFile: () => Promise<string[]>
    saveFile: (defaultName: string) => Promise<string | null>
  }
  window: {
    openSettings: () => Promise<void>
    quit: () => Promise<void>
    minimize: () => void
  }
  update: {
    onAvailable: (cb: () => void) => void
    onDownloaded: (cb: () => void) => void
  }
}

contextBridge.exposeInMainWorld('__DSH__', {
  app: {
    getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: Partial<Settings>) => ipcRenderer.invoke('settings:set', settings),
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (defaultName: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  },
  window: {
    openSettings: () => ipcRenderer.invoke('window:openSettings'),
    quit: () => ipcRenderer.invoke('window:quit'),
    minimize: () => {
      const { getCurrentWindow } = require('electron')
      // renderer can't require electron; expose via IPC instead
      void ipcRenderer.invoke('window:minimize')
    },
  },
  update: {
    onAvailable: (cb: () => void) => ipcRenderer.on('update:available', cb),
    onDownloaded: (cb: () => void) => ipcRenderer.on('update:downloaded', cb),
  },
})

declare global {
  interface Window {
    __DSH__: DshApi
  }
}
