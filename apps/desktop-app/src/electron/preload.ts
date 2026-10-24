/**
 * Preload script — exposes a narrow, typed bridge to the renderer.
 * Keys are stored encrypted in userData and never leave the machine.
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

export type ProviderConfig = {
  id: string
  name: string
  kind: 'openai-compatible' | 'anthropic' | 'google' | 'huggingface-api' | 'huggingface-local'
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  enabled: boolean
  local?: boolean
  requiresKey?: boolean
}

export type ModelInfo = {
  id: string
  name: string
  provider: string
  kind: string
  contextWindow?: number
  local?: boolean
  downloaded?: boolean
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export type ChatChunk = {
  type: 'text' | 'done' | 'error'
  content?: string
  error?: string
  streamId?: string
}

export type LocalModel = { id: string; name: string; downloaded: boolean; sizeBytes: number }
export type HubModel = { id: string; downloads: number; likes: number }
export type DownloadProgress = { modelId: string; file?: string; loaded?: number; total?: number; status?: string }

export type StreamOptions = {
  model: string
  messages: { role: string; content: string }[]
  temperature?: number
  maxTokens?: number
  signalId: string
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
  providers: {
    list: () => Promise<ProviderConfig[]>
    get: (id: string) => Promise<ProviderConfig | null>
    set: (config: ProviderConfig) => Promise<void>
    remove: (id: string) => Promise<void>
    listModels: (id: string) => Promise<ModelInfo[]>
  }
  chat: {
    /** Starts a stream; chunks arrive through onChunk. `done` rejects on validation errors. */
    stream: (providerId: string, opts: StreamOptions) => { cancel: () => void; done: Promise<void> }
    onChunk: (cb: (chunk: ChatChunk & { streamId: string }) => void) => () => void
  }
  hf: {
    listLocal: () => Promise<LocalModel[]>
    search: (query: string) => Promise<HubModel[]>
    download: (modelId: string) => Promise<void>
    cancelDownload: (modelId: string) => Promise<void>
    remove: (modelId: string) => Promise<void>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  window: {
    openSettings: () => Promise<void>
    quit: () => Promise<void>
    minimize: () => Promise<void>
  }
  update: {
    onAvailable: (cb: () => void) => () => void
    onDownloaded: (cb: () => void) => () => void
    install: () => Promise<void>
  }
}

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_event: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

const api: DshApi = {
  app: {
    getPath: (name) => ipcRenderer.invoke('app:getPath', name),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    get: (id) => ipcRenderer.invoke('providers:get', id),
    set: (config) => ipcRenderer.invoke('providers:set', config),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
    listModels: (id) => ipcRenderer.invoke('providers:listModels', id),
  },
  chat: {
    stream: (providerId, opts) => ({
      cancel: () => { void ipcRenderer.invoke('chat:cancel', opts.signalId) },
      done: ipcRenderer.invoke('chat:stream', { providerId, ...opts }),
    }),
    onChunk: (cb) => subscribe('chat:chunk', cb),
  },
  hf: {
    listLocal: () => ipcRenderer.invoke('hf:listLocal'),
    search: (query) => ipcRenderer.invoke('hf:search', query),
    download: (modelId) => ipcRenderer.invoke('hf:download', modelId),
    cancelDownload: (modelId) => ipcRenderer.invoke('hf:cancelDownload', modelId),
    remove: (modelId) => ipcRenderer.invoke('hf:remove', modelId),
    onProgress: (cb) => subscribe('hf:progress', cb),
  },
  window: {
    openSettings: () => ipcRenderer.invoke('window:openSettings'),
    quit: () => ipcRenderer.invoke('window:quit'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
  },
  update: {
    onAvailable: (cb) => subscribe('update:available', cb),
    onDownloaded: (cb) => subscribe('update:downloaded', cb),
    install: () => ipcRenderer.invoke('update:install'),
  },
}

contextBridge.exposeInMainWorld('__DSH__', api)

declare global {
  interface Window {
    __DSH__: DshApi
  }
}
