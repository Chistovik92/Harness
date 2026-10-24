/**
 * Preload script — exposes a narrow, typed bridge to the renderer.
 * Keys are stored encrypted in userData and never leave the machine.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ModelProfile } from '../renderer/lib/modelProfile'

export type { ModelProfile }

export type Settings = {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  theme?: 'light' | 'dark'
  fontSize?: number
  workspace?: string
  permissionMode?: 'ask-all' | 'workspace-auto' | 'full-auto'
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
  profile?: ModelProfile
}

export type ToolStep = {
  id: string
  name: string
  summary: string
  arguments: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  output?: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  steps?: ToolStep[]
  /** The model's reasoning, shown in a collapsible block. */
  thinking?: string
}

export type ToolCallInfo = { id: string; name: string; arguments: Record<string, unknown> }

export type ChatChunk = {
  type: 'text' | 'thought' | 'done' | 'error' | 'tool_start' | 'tool_result'
  content?: string
  error?: string
  streamId?: string
  toolCall?: ToolCallInfo
  summary?: string
  toolCallId?: string
  name?: string
  output?: string
  isError?: boolean
}

export type PermissionRequest = { id: string; tool: string; summary: string; reason: string; details?: string }
export type PermissionAnswer = 'once' | 'session' | 'deny'

export type SshConnectionInfo = {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  privateKeyPath?: string
  hostKey?: string
  hasPassword: boolean
  hasPassphrase: boolean
}
export type SshConnectionInput = Omit<SshConnectionInfo, 'hasPassword' | 'hasPassphrase' | 'hostKey'> & { password?: string; passphrase?: string }

export type HfUser = { name: string; fullName?: string; avatar?: string }
export type AuthStatus = { loggedIn: boolean; user?: HfUser }
export type GgufFile = { file: string; size: number; quant: string; parts: string[] }

export type LocalModel = { id: string; name: string; format: 'onnx' | 'gguf'; downloaded: boolean; sizeBytes: number; profile: ModelProfile }
export type HubModel = { id: string; downloads: number; likes: number; gated: boolean; profile: ModelProfile }
export type DownloadProgress = { modelId: string; file?: string; loaded?: number; total?: number; status?: string }

export type StreamOptions = {
  model: string
  messages: { role: string; content: string }[]
  temperature?: number
  maxTokens?: number
  signalId: string
  agent?: boolean
  thinking?: boolean
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
    search: (format: 'onnx' | 'gguf', query: string) => Promise<HubModel[]>
    ggufFiles: (repoId: string) => Promise<GgufFile[]>
    download: (modelId: string) => Promise<void>
    downloadGguf: (repoId: string, file: string, parts: string[]) => Promise<void>
    authStatus: () => Promise<AuthStatus>
    login: () => Promise<AuthStatus>
    logout: () => Promise<void>
    cancelDownload: (modelId: string) => Promise<void>
    remove: (modelId: string) => Promise<void>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  agent: {
    pickWorkspace: () => Promise<string | null>
    onPermission: (cb: (request: PermissionRequest) => void) => () => void
    replyPermission: (id: string, answer: PermissionAnswer) => Promise<void>
  }
  ssh: {
    list: () => Promise<SshConnectionInfo[]>
    set: (connection: SshConnectionInput) => Promise<void>
    remove: (name: string) => Promise<void>
    test: (name: string) => Promise<{ ok: boolean; message: string }>
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
    search: (format, query) => ipcRenderer.invoke('hf:search', format, query),
    ggufFiles: (repoId) => ipcRenderer.invoke('hf:ggufFiles', repoId),
    download: (modelId) => ipcRenderer.invoke('hf:download', modelId),
    downloadGguf: (repoId, file, parts) => ipcRenderer.invoke('hf:downloadGguf', repoId, file, parts),
    authStatus: () => ipcRenderer.invoke('hf:authStatus'),
    login: () => ipcRenderer.invoke('hf:login'),
    logout: () => ipcRenderer.invoke('hf:logout'),
    cancelDownload: (modelId) => ipcRenderer.invoke('hf:cancelDownload', modelId),
    remove: (modelId) => ipcRenderer.invoke('hf:remove', modelId),
    onProgress: (cb) => subscribe('hf:progress', cb),
  },
  agent: {
    pickWorkspace: () => ipcRenderer.invoke('agent:pickWorkspace'),
    onPermission: (cb) => subscribe('agent:permission', cb),
    replyPermission: (id, answer) => ipcRenderer.invoke('agent:permissionReply', { id, answer }),
  },
  ssh: {
    list: () => ipcRenderer.invoke('ssh:list'),
    set: (connection) => ipcRenderer.invoke('ssh:set', connection),
    remove: (name) => ipcRenderer.invoke('ssh:remove', name),
    test: (name) => ipcRenderer.invoke('ssh:test', name),
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
