import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Maximize, Minimize, X, MessageCircle, Settings as SettingsIcon, Search, Upload, Clock, Key, Bot, Server, Cpu, Activity } from 'lucide-react'
import { useDsh } from '@/context/DshContext'
import { useChat } from '@/context/ChatContext'
import type { ModelInfo } from '../electron/preload'
import { renderMarkdown } from '@/lib/markdown'
import SettingsPage from './SettingsPage'
import ProvidersPage from './ProvidersPage'

type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number }

export default function App() {
  const { apiKey, baseUrl, model, setModel, isConnected, setIsConnected, saveSettings } = useDsh()
  const { messages, addMessage, appendStream, isLoading, setIsLoading, currentSessionId, createSession, sessions, switchSession, deleteSession, setMessages } = useChat()

  const [providers, setProviders] = useState<any[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [view, setView] = useState<'chat' | 'settings' | 'providers'>('chat')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [streamId, setStreamId] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load providers on mount
  useEffect(() => {
    ;(async () => {
      const list = await window.__DSH__.providers.list()
      setProviders(list)
      if (list.length > 0 && !selectedProvider) {
        const firstEnabled = list.find((p) => p.enabled) ?? list[0]
        setSelectedProvider(firstEnabled.id)
      }
    })()
  }, [selectedProvider])

  useEffect(() => {
    if (selectedProvider) {
      ;(async () => {
        const ms = await window.__DSH__.providers.listModels(selectedProvider)
        setModels(ms)
        if (ms.length > 0) setSelectedModel(ms[0].id)
      })()
    }
  }, [selectedProvider])

  // Listen for chat chunks
  useEffect(() => {
    const unsub = window.__DSH__.chat.onChunk((chunk: any) => {
      if (chunk.streamId !== streamId) return
      if (chunk.type === 'text' && chunk.content && streamId) appendStream(streamId, chunk.content)
      if (chunk.type === 'error' && streamId) {
        appendStream(streamId, `\n\nОшибка: ${chunk.error}`)
        setIsLoading(false)
        setStreamId(null)
        abortRef.current = null
        setIsConnected(false)
      }
      if (chunk.type === 'done' && streamId) {
        setIsLoading(false)
        setStreamId(null)
        abortRef.current = null
        setIsConnected(false)
      }
    })
    return () => unsub()
  }, [streamId])

  // Listen for HF local chunks
  useEffect(() => {
    const unsub = window.__DSH__.hf.onChunk((chunk: any) => {
      if (chunk.streamId !== streamId) return
      if (chunk.type === 'text' && chunk.content && streamId) appendStream(streamId, chunk.content)
      if (chunk.type === 'error' && streamId) {
        appendStream(streamId, `\n\nОшибка: ${chunk.error}`)
        setIsLoading(false)
        setStreamId(null)
        abortRef.current = null
        setIsConnected(false)
      }
      if (chunk.type === 'done' && streamId) {
        setIsLoading(false)
        setStreamId(null)
        abortRef.current = null
        setIsConnected(false)
      }
    })
    return () => unsub()
  }, [streamId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text) return
    if (!selectedProvider) return

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: Date.now() }
    addMessage(userMsg)
    setInput('')
    setIsLoading(true)

    const assistantId = crypto.randomUUID()
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() }
    addMessage(assistantMsg)
    setStreamId(assistantId)
    setIsConnected(true)

    const newId = crypto.randomUUID()
    let streamResult: { cancel: () => void } | null = null
    abortRef.current = () => { streamResult?.cancel() }

    try {
      streamResult = await window.__DSH__.chat.stream(selectedProvider, {
        model: selectedModel,
        messages: [...messages, userMsg],
        temperature: 0.7,
        maxTokens: 4096,
        signalId: newId,
      })
    } catch (err) {
      appendStream(assistantId, `\n\nОшибка: ${err instanceof Error ? err.message : String(err)}`)
      setIsLoading(false)
      setStreamId(null)
      abortRef.current = null
      setIsConnected(false)
    }
  }

  const cancelMessage = () => {
    abortRef.current?.()
    setIsLoading(false)
    setStreamId(null)
    abortRef.current = null
    setIsConnected(false)
  }

  const newSession = () => {
    setInput('')
    setMessages([])
    setStreamId(null)
    createSession()
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
  const providerNeedsKey = currentProvider?.requiresKey !== false && !(currentProvider?.apiKey)

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
      <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-xs font-bold">D</div>
          <span className="text-sm font-medium tracking-tight">DeepSeek Harness</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => window.__DSH__.window.minimize()} className="w-7 h-7 rounded hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white"><Minimize className="w-3 h-3" /></button>
          {process.platform !== 'darwin' && (
            <button className="w-7 h-7 rounded hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white"><Maximize className="w-3 h-3" /></button>
          )}
          <button onClick={() => window.__DSH__.window.quit()} className="w-7 h-7 rounded hover:bg-red-900/50 flex items-center justify-center text-slate-400 hover:text-white"><X className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-64 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0">
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
          </div>

          <div className="p-2">
            <label className="block px-3 py-1 text-xs font-semibold text-slate-500 uppercase">Сессии</label>
            <div className="space-y-1">
              {sessions.map((s: any) => (
                <button key={s.id} onClick={() => switchSession(s.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${currentSessionId === s.id ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-500/30' : 'hover:bg-slate-800 text-slate-300'}`}>
                  <Clock className="w-3.5 h-3.5 opacity-50" />
                  <span className="truncate">{s.title}</span>
                  <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }} className="ml-auto opacity-0 hover:opacity-100 p-1 text-slate-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                </button>
              ))}
              {sessions.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">Сессий пока нет</div>}
            </div>
          </div>

          <div className="mt-auto p-3 border-t border-slate-800 space-y-2">
            <button onClick={() => setView('settings')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300"><SettingsIcon className="w-4 h-4" /> Настройки</button>
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
                  ref={messagesEndRef as unknown as React.RefObject<HTMLInputElement>}
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
