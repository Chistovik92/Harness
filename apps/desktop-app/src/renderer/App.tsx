import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Download, Minimize, Folder, ShieldCheck, Server as ServerIcon, X, MessageCircle, Settings as SettingsIcon, Search, Upload, Clock, Key, Bot, Server, Cpu, Activity } from 'lucide-react'
import { useDsh } from '@/context/DshContext'
import { useChat } from '@/context/ChatContext'
import type { ModelInfo, ToolStep } from '../electron/preload'
import { renderMarkdown } from '@/lib/markdown'
import SettingsPage from './SettingsPage'
import ProvidersPage, { mergeProviders } from './ProvidersPage'
import ModelsPage from './ModelsPage'
import ConnectionsPage from './ConnectionsPage'
import { PermissionDialog, ToolSteps } from '@/components/AgentUi'
import { ModelProfileCard } from '@/components/ModelBadges'
import { useUpdate } from '@/context/UpdateContext'

type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number; steps?: ToolStep[] }

export default function App() {
  const { settings, saveSettings, isConnected, setIsConnected } = useDsh()
  const { messages, addMessage, persistMessage, addStep, finishStep, appendStream, isLoading, setIsLoading, currentSessionId, createSession, sessions, switchSession, deleteSession, setMessages } = useChat()

  const [providers, setProviders] = useState<any[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [view, setView] = useState<'chat' | 'settings' | 'providers' | 'models' | 'connections'>(window.location.hash === '#/settings' ? 'settings' : 'chat')
  const { downloaded: updateDownloaded, install: installUpdate } = useUpdate()

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamIdRef = useRef<string | null>(null)
  const [agentMode, setAgentMode] = useState<boolean>(() => {
    try { return localStorage.getItem('dsh-agent-mode') === '1' } catch { return false }
  })
  const toggleAgent = (on: boolean) => {
    setAgentMode(on)
    try { localStorage.setItem('dsh-agent-mode', on ? '1' : '0') } catch { /* storage unavailable */ }
  }
  const pickWorkspace = async () => {
    const folder = await window.__DSH__.agent.pickWorkspace()
    if (folder) await saveSettings({ workspace: folder })
  }
  const [input, setInput] = useState('')
  const [streamId, setStreamId] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load providers on mount
  useEffect(() => {
    ;(async () => {
      const list = mergeProviders(await window.__DSH__.providers.list())
      setProviders(list)
      if (!selectedProvider) {
        const ready = list.find((p) => p.enabled && p.apiKey) ?? list[0]
        setSelectedProvider(ready.id)
      }
    })().catch((err) => console.error('Failed to load providers:', err))
  }, [selectedProvider, view])

  useEffect(() => {
    if (selectedProvider) {
      ;(async () => {
        const ms = await window.__DSH__.providers.listModels(selectedProvider)
        setModels(ms)
        // Keep the current choice when it is still available (e.g. after visiting the models page).
        setSelectedModel((prev) => (ms.some((m) => m.id === prev) ? prev : ms.length > 0 ? ms[0].id : ''))
      })().catch((err) => console.error('Failed to load models:', err))
    }
  }, [selectedProvider, view])

  function finishStream(id: string) {
    persistMessage(id)
    streamIdRef.current = null
    setIsLoading(false)
    setStreamId(null)
    abortRef.current = null
    setIsConnected(false)
  }

  // Listen for chat chunks (streamIdRef avoids stale closures between renders)
  useEffect(() => {
    const unsub = window.__DSH__.chat.onChunk((chunk) => {
      const id = streamIdRef.current
      if (!id || chunk.streamId !== id) return
      if (chunk.type === 'text' && chunk.content) appendStream(id, chunk.content)
      else if (chunk.type === 'tool_start' && chunk.toolCall) {
        addStep(id, { id: chunk.toolCall.id, name: chunk.toolCall.name, summary: chunk.summary ?? chunk.toolCall.name, arguments: chunk.toolCall.arguments, status: 'running' })
      } else if (chunk.type === 'tool_result' && chunk.toolCallId) {
        finishStep(id, chunk.toolCallId, chunk.output ?? '', chunk.isError === true)
      } else if (chunk.type === 'error') {
        appendStream(id, `\n\nОшибка: ${chunk.error}`)
        finishStream(id)
      } else if (chunk.type === 'done') finishStream(id)
    })
    return () => unsub()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() }
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text || !selectedProvider || !selectedModel || isLoading) return

    const sessionId = currentSessionId ?? await createSession()
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: Date.now() }
    const assistantId = crypto.randomUUID()
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }))

    addMessage(userMsg, sessionId)
    addMessage({ id: assistantId, role: 'assistant', content: '', createdAt: Date.now() }, sessionId)
    setInput('')
    setIsLoading(true)
    setIsConnected(true)
    // The assistant message id doubles as the stream id so chunks route to it.
    streamIdRef.current = assistantId
    setStreamId(assistantId)

    try {
      const stream = window.__DSH__.chat.stream(selectedProvider, {
        model: selectedModel,
        messages: history,
        temperature: settings.temperature ?? 0.7,
        maxTokens: settings.maxTokens ?? 4096,
        signalId: assistantId,
        agent: agentMode,
      })
      abortRef.current = stream.cancel
      await stream.done
    } catch (err) {
      if (streamIdRef.current === assistantId) {
        appendStream(assistantId, `\n\nОшибка: ${err instanceof Error ? err.message : String(err)}`)
        finishStream(assistantId)
      }
    }
  }

  const cancelMessage = () => {
    abortRef.current?.()
  }

  const newSession = () => {
    setInput('')
    createSession().catch((err) => console.error('Failed to create session:', err))
  }

  if (view === 'settings') {
    return (
      <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
          <button onClick={() => setView('chat')} className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300 hover:text-white"><X className="w-4 h-4" /></button>
          <span className="text-sm font-medium tracking-tight ml-2">Настройки</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6"><SettingsPage onSave={() => setView('chat')} /></div>
      </div>
    )
  }

  if (view === 'connections') {
    return (
      <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
          <button onClick={() => setView('chat')} className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300 hover:text-white"><X className="w-4 h-4" /></button>
          <span className="text-sm font-medium tracking-tight ml-2">SSH-подключения</span>
        </div>
        <div className="flex-1 overflow-y-auto"><ConnectionsPage onBack={() => setView('chat')} /></div>
        <PermissionDialog />
      </div>
    )
  }

  if (view === 'models') {
    return (
      <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
          <button onClick={() => setView('chat')} className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300 hover:text-white"><X className="w-4 h-4" /></button>
          <span className="text-sm font-medium tracking-tight ml-2">Локальные модели</span>
        </div>
        <div className="flex-1 overflow-y-auto"><ModelsPage onBack={() => { setView('chat') }} /></div>
        <PermissionDialog />
      </div>
    )
  }

  if (view === 'providers') {
    return (
      <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
          <button onClick={() => setView('chat')} className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300 hover:text-white"><X className="w-4 h-4" /></button>
          <span className="text-sm font-medium tracking-tight ml-2">Провайдеры и ключи API</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6"><ProvidersPage onBack={() => setView('chat')} /></div>
      </div>
    )
  }

  const currentProvider = providers.find((p) => p.id === selectedProvider)
  const isLocalProvider = currentProvider?.local === true || currentProvider?.kind === 'huggingface-local'
  const providerNeedsKey = !isLocalProvider && currentProvider?.requiresKey !== false && !(currentProvider?.apiKey)

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
      <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-xs font-bold">D</div>
          <span className="text-sm font-medium tracking-tight">DeepSeek Harness</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => window.__DSH__.window.minimize()} className="w-7 h-7 rounded hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white"><Minimize className="w-3 h-3" /></button>
          <button onClick={() => window.__DSH__.window.quit()} className="w-7 h-7 rounded hover:bg-red-900/50 flex items-center justify-center text-slate-400 hover:text-white"><X className="w-3 h-3" /></button>
        </div>
      </div>

      {updateDownloaded && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-indigo-900/40 border-b border-indigo-700/50 text-xs text-indigo-100 shrink-0">
          <span>Доступна новая версия — перезапустите приложение для обновления.</span>
          <button onClick={installUpdate} className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white">Перезапустить</button>
        </div>
      )}

      <PermissionDialog />

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0 overflow-y-auto">
          <div className="p-4 border-b border-slate-800">
            <div className="flex items-center gap-2 mb-2">
              <Bot className="w-4 h-4 text-indigo-400" />
              <span className="text-sm font-medium">Провайдер</span>
            </div>
            <select
              value={selectedProvider ?? ''}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {providerNeedsKey && (
              <div className="mt-2 p-2 rounded bg-amber-900/20 border border-amber-700/50 text-amber-200 text-xs">
                Нужно добавить API-ключ в разделе "Провайдеры"
              </div>
            )}
          </div>

          <div className="p-2 border-b border-slate-800">
            <label className="block px-3 py-1 text-xs font-semibold text-slate-500 uppercase">Модель</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.local ? ' (локально)' : ''}
                </option>
              ))}
            </select>
            {isLocalProvider && models.length === 0 && (
              <div className="mt-2 px-1 text-xs text-amber-200">Нет скачанных моделей. Скачайте их в разделе «Локальные модели».</div>
            )}
            <ModelProfileCard profile={models.find((m) => m.id === selectedModel)?.profile} />
          </div>

          <div className="p-3 border-b border-slate-800 space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input type="checkbox" checked={agentMode} onChange={(e) => toggleAgent(e.target.checked)} className="w-4 h-4 rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-indigo-500" />
              <ShieldCheck className="w-4 h-4 text-indigo-300" /> Режим агента
            </label>
            <div className="text-xs text-slate-500">Файлы, поиск, команды, веб и SSH. Работает с моделями API и GGUF.</div>
            {agentMode && (
              <>
                <button onClick={pickWorkspace} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-xs text-slate-300 text-left" title={settings.workspace ?? ''}>
                  <Folder className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{settings.workspace ?? 'Выбрать рабочую папку'}</span>
                </button>
                <select
                  value={settings.permissionMode ?? 'workspace-auto'}
                  onChange={(e) => saveSettings({ permissionMode: e.target.value as 'ask-all' | 'workspace-auto' | 'full-auto' })}
                  aria-label="Режим разрешений"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="workspace-auto">Авто в рабочей папке, остальное спрашивать</option>
                  <option value="ask-all">Спрашивать всё</option>
                  <option value="full-auto">Всё автоматически (рискованно)</option>
                </select>
                {!settings.workspace && <div className="text-xs text-amber-200">Без рабочей папки команды и правки файлов будут запрашивать разрешение.</div>}
              </>
            )}
          </div>

          <div className="p-2">
            <label className="block px-3 py-1 text-xs font-semibold text-slate-500 uppercase">Сессии</label>
            <div className="space-y-1">
              {sessions.map((s: any) => (
                <div key={s.id} role="button" tabIndex={0} onClick={() => switchSession(s.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') switchSession(s.id) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${currentSessionId === s.id ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-500/30' : 'hover:bg-slate-800 text-slate-300'}`}>
                  <Clock className="w-3.5 h-3.5 opacity-50" />
                  <span className="truncate">{s.title}</span>
                  <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }} aria-label="Удалить сессию" className="ml-auto opacity-50 hover:opacity-100 p-1 text-slate-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                </div>
              ))}
              {sessions.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">Сессий пока нет</div>}
            </div>
          </div>

          <div className="mt-auto p-3 border-t border-slate-800 space-y-2">
            <button onClick={() => setView('settings')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300"><SettingsIcon className="w-4 h-4" /> Настройки</button>
            <button onClick={() => setView('connections')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300"><ServerIcon className="w-4 h-4" /> SSH-подключения</button>
            <button onClick={() => setView('models')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300"><Download className="w-4 h-4" /> Локальные модели</button>
            <button onClick={() => setView('providers')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300"><Key className="w-4 h-4" /> Провайдеры API</button>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin" id="chat-scroll">
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((m: ChatMessage) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-3 rounded-2xl ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-800'} ${m.role === 'assistant' && streamId === m.id ? 'animate-pulse' : ''}`}>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className={m.role === 'user' ? 'text-indigo-200 text-xs font-medium' : 'text-slate-400 text-xs font-medium'}>{m.role === 'user' ? 'Вы' : currentProvider?.name || 'Ассистент'}</span>
                      {m.role === 'assistant' && streamId && streamId === m.id && <span className="text-xs text-slate-500 animate-pulse">пишет…</span>}
                    </div>
                    <ToolSteps steps={m.steps} />
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} className="prose prose-sm prose-invert max-w-none" />
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="p-4 border-t border-slate-800 bg-slate-900/80 backdrop-blur shrink-0">
            <div className="max-w-3xl mx-auto">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={!selectedProvider ? 'Выберите провайдера' : providerNeedsKey ? 'Нужен API-ключ' : 'Сообщение…'}
                  disabled={!selectedProvider || providerNeedsKey || isLoading}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || !selectedProvider || providerNeedsKey || isLoading}
                  className="w-10 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white"
                >
                  <Send className="w-4 h-4" />
                </button>
                {isLoading && streamId && (
                  <button onClick={cancelMessage} className="w-10 h-10 rounded-lg bg-red-600 hover:bg-red-500 flex items-center justify-center text-white"><X className="w-4 h-4" /></button>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
                  {isConnected ? 'Подключено' : selectedProvider ? 'Готово' : 'Нужен провайдер'}
                </span>
                <div className="flex gap-1">
                  <span className="flex items-center gap-1">
                    <Cpu className="w-3 h-3 opacity-50" />
                    <span className="text-xs">{selectedProvider ? (currentProvider?.kind || 'unknown') : '-'}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
