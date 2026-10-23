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
    stream: (providerId: string, opts: {
      model: string
      messages: { role: string; content: string }[]
      temperature?: number
      maxTokens?: number
      signalId: string
    }) => Promise<{ cancel: () => void }>
    onChunk: (cb: (chunk: ChatChunk & { streamId: string }) => void) => () => void
  }
  hf: {
    listLocal: () => Promise<{ id: string; name: string; downloaded: boolean }[]>
    download: (modelId: string) => Promise<void>
    onChunk: (cb: (chunk: ChatChunk & { streamId: string }) => void) => () => void
    startLocal: (opts: { model: string; prompt: string; temperature?: number; maxTokens?: number; signalId: string }) => Promise<void>
    stopLocal: (signalId: string) => Promise<void>
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

const activeStreams = new Map<string, () => void>()

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
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    get: (id: string) => ipcRenderer.invoke('providers:get', id),
    set: (config: ProviderConfig) => ipcRenderer.invoke('providers:set', config),
    remove: (id: string) => ipcRenderer.invoke('providers:remove', id),
    listModels: (id: string) => ipcRenderer.invoke('providers:listModels', id),
  },
  chat: {
    stream: async (providerId: string, opts: any) => {
      const streamId = opts.signalId
      const controller = new AbortController()
      activeStreams.set(streamId, () => controller.abort())
      const cancel = () => { activeStreams.delete(streamId); controller.abort() }
      return { cancel }
    },
    onChunk: (cb: (chunk: ChatChunk & { streamId: string }) => void) => {
      const handler = (_: any, chunk: ChatChunk & { streamId: string }) => cb(chunk)
      ipcRenderer.on('chat:chunk', handler)
      return () => ipcRenderer.removeListener('chat:chunk', handler)
    },
  },
  hf: {
    listLocal: () => ipcRenderer.invoke('hf:listLocal'),
    download: (modelId: string) => ipcRenderer.invoke('hf:download', modelId),
    onChunk: (cb: (chunk: ChatChunk & { streamId: string }) => void) => {
      const handler = (_: any, chunk: ChatChunk & { streamId: string }) => cb(chunk)
      ipcRenderer.on('hf:chunk', handler)
      return () => ipcRenderer.removeListener('hf:chunk', handler)
    },
    startLocal: (opts: any) => ipcRenderer.invoke('hf:chatLocal', opts),
    stopLocal: (signalId: string) => ipcRenderer.invoke('hf:stopLocal', signalId),
  },
  window: {
    openSettings: () => ipcRenderer.invoke('window:openSettings'),
    quit: () => ipcRenderer.invoke('window:quit'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
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
