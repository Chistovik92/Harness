import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Maximize, Minimize, X, MessageCircle, Code, Settings as SettingsIcon, Search, Upload, Clock } from 'lucide-react'
import { useDsh } from '@/context/DshContext'
import { useChat } from '@/context/ChatContext'
import type { ChatMessage } from '../electron/preload'
import { MODELS } from '@/lib/constants'
import { renderMarkdown } from '@/lib/markdown'
import SettingsPage from './SettingsPage'

export default function App() {
  const { apiKey, baseUrl, model, setModel, isConnected, setIsConnected, saveSettings } = useDsh()
  const { messages, addMessage, appendStream, isLoading, setIsLoading, currentSessionId, createSession, sessions, switchSession, deleteSession, setMessages } = useChat()

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text || !apiKey) return

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: Date.now() }
    addMessage(userMsg)
    setInput('')
    setIsLoading(true)

    const assistantId = crypto.randomUUID()
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() }
    addMessage(assistantMsg)
    setStreamingId(assistantId)

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Ты полезный ассистент DeepSeek Harness.' },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
          ],
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      setIsConnected(true)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const data = JSON.parse(payload)
            const delta = data.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              appendStream(assistantId, delta)
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      setIsConnected(false)
      setStreamingId(null)
      setIsLoading(false)
    } catch (err) {
      console.error(err)
      appendStream(assistantId, `\n\nОшибка: ${err instanceof Error ? err.message : String(err)}`)
      setIsConnected(false)
      setStreamingId(null)
      setIsLoading(false)
    }
  }

  const newSession = () => {
    setInput('')
    setMessages([])
    setStreamingId(null)
    createSession()
  }

  if (view === 'settings') {
    return (
      <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
          <button onClick={() => setView('chat')} className="w-8 h-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium tracking-tight ml-2">Настройки</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <SettingsPage onSave={() => setView('chat')} />
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
      <div className="flex items-center justify-between h-10 px-4 bg-slate-900/80 border-b border-slate-800 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-xs font-bold">D</div>
          <span className="text-sm font-medium tracking-tight">DeepSeek Harness</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => window.__DSH__.window.minimize()} className="w-7 h-7 rounded hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white">
            <Minimize className="w-3 h-3" />
          </button>
          {process.platform !== 'darwin' && (
            <button className="w-7 h-7 rounded hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white">
              <Maximize className="w-3 h-3" />
            </button>
          )}
          <button onClick={() => window.__DSH__.window.quit()} className="w-7 h-7 rounded hover:bg-red-900/50 flex items-center justify-center text-slate-400 hover:text-white">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-64 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-800">
            <button onClick={newSession} className="w-full flex items-center gap-2 px-3 py-2 bg-slate-800/50 hover:bg-slate-800 rounded-lg text-sm text-slate-200">
              <MessageCircle className="w-4 h-4" />
              Новый чат
            </button>
          </div>
          <div className="p-2">
            <label className="block px-3 py-1 text-xs font-semibold text-slate-500 uppercase">Сессии</label>
            <div className="space-y-1">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => switchSession(s.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                    currentSessionId === s.id ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-500/30' : 'hover:bg-slate-800 text-slate-300'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5 opacity-50" />
                  <span className="truncate">{s.title}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                    className="ml-auto opacity-0 hover:opacity-100 p-1 text-slate-500 hover:text-red-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </button>
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-500">Сессий пока нет</div>
              )}
            </div>
          </div>
          <div className="mt-auto p-3 border-t border-slate-800">
            <button onClick={() => setView('settings')} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-300">
              <SettingsIcon className="w-4 h-4" />
              Настройки
            </button>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin" id="chat-scroll">
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((m: ChatMessage) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-3 rounded-2xl ${
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-tr-none'
                      : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-800'
                  } ${m.role === 'assistant' && streamingId === m.id ? 'animate-pulse' : ''}`}>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className={m.role === 'user' ? 'text-indigo-200 text-xs font-medium' : 'text-slate-400 text-xs font-medium'}>{m.role === 'user' ? 'Вы' : 'DeepSeek'}</span>
                      {m.role === 'assistant' && streamingId === m.id && <span className="text-xs text-slate-500 animate-pulse">пишет…</span>}
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
                  placeholder={!apiKey ? 'Укажите API-ключ в настройках' : 'Сообщение…'}
                  disabled={!apiKey || isLoading}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || !apiKey || isLoading}
                  className="w-10 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
                  {isConnected ? 'Подключено' : apiKey ? 'Готово' : 'Нужен API-ключ'}
                </span>
                <div className="flex gap-1">
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="bg-slate-950 border border-slate-800 text-slate-100 text-xs px-2 py-1 rounded"
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function appQuit() {
  if (window.__DSH__.window.quit) window.__DSH__.window.quit()
}
