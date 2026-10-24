import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import type { ChatMessage, ToolStep } from '../../electron/preload'
export type { ChatMessage }
import {
  getSessions,
  saveSession,
  deleteSession as dbDeleteSession,
  getMessages,
  saveMessage as dbSaveMessage,
  deleteMessagesForSession,
  type StoredSession,
  type StoredMessage,
} from '@/lib/storage'

type ChatContext = {
  messages: ChatMessage[]
  currentSessionId: string | null
  sessions: StoredSession[]
  addMessage: (msg: ChatMessage, sessionId?: string) => void
  persistMessage: (id: string) => void
  addStep: (messageId: string, step: ToolStep) => void
  finishStep: (messageId: string, stepId: string, output: string, isError: boolean) => void
  setMessages: (msgs: ChatMessage[]) => void
  appendStream: (id: string, chunk: string) => void
  createSession: () => Promise<string>
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  isLoading: boolean
  setIsLoading: (v: boolean) => void
}

const ChatContext = createContext<ChatContext | null>(null)

export function useChat() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}

function toStored(m: ChatMessage, sessionId: string): StoredMessage {
  return { id: m.id, sessionId, role: m.role, content: m.content, createdAt: m.createdAt, ...(m.steps?.length ? { steps: m.steps } : {}) }
}

function toChat(m: StoredMessage): ChatMessage {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, ...(m.steps?.length ? { steps: m.steps } : {}) }
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      const ss = await getSessions()
      setSessions(ss)
      if (ss.length > 0) {
        const first = ss[0]
        setCurrentSessionId(first.id)
        const msgs = await getMessages(first.id)
        setMessages(msgs.map(toChat))
      }
    })().catch((err) => console.error('Failed to load chat history:', err))
  }, [])

  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = currentSessionId

  const addMessage = useCallback((msg: ChatMessage, sessionId?: string) => {
    setMessages((prev) => [...prev, msg])
    const target = sessionId ?? sessionIdRef.current
    if (target) {
      dbSaveMessage(toStored(msg, target)).catch(console.error)
    }
  }, [])

  /** Saves the final content of a streamed message once the stream has finished. */
  const persistMessage = useCallback((id: string) => {
    const msg = messagesRef.current.find((m) => m.id === id)
    const target = sessionIdRef.current
    if (msg && target) {
      dbSaveMessage(toStored(msg, target)).catch(console.error)
    }
  }, [])

  const appendStream = useCallback((id: string, chunk: string) => {
    setMessages((prev) =>
      prev.map((m: ChatMessage) => (m.id === id ? { ...m, content: m.content + chunk } : m))
    )
  }, [])

  const addStep = useCallback((messageId: string, step: ToolStep) => {
    setMessages((prev) => prev.map((m: ChatMessage) => (m.id === messageId ? { ...m, steps: [...(m.steps ?? []), step] } : m)))
  }, [])

  const finishStep = useCallback((messageId: string, stepId: string, output: string, isError: boolean) => {
    setMessages((prev) => prev.map((m: ChatMessage) => (m.id === messageId
      ? { ...m, steps: (m.steps ?? []).map((s) => (s.id === stepId ? { ...s, status: isError ? 'error' as const : 'done' as const, output } : s)) }
      : m)))
  }, [])

  const createSession = useCallback(async () => {
    const id = crypto.randomUUID()
    const session: StoredSession = { id, title: 'Новый чат', updatedAt: Date.now() }
    await saveSession(session)
    sessionIdRef.current = id
    setSessions((prev) => [session, ...prev])
    setCurrentSessionId(id)
    setMessages([])
    return id
  }, [])

  const switchSession = useCallback(async (id: string) => {
    setCurrentSessionId(id)
    const msgs = await getMessages(id)
    setMessages(msgs.map(toChat))
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    await dbDeleteSession(id)
    await deleteMessagesForSession(id)
    setSessions((prev) => prev.filter((x) => x.id !== id))
    if (currentSessionId === id) {
      const remaining = sessions.filter((x) => x.id !== id)
      setCurrentSessionId(remaining.length > 0 ? remaining[0].id : null)
      if (remaining.length > 0) {
        const msgs = await getMessages(remaining[0].id)
        setMessages(msgs.map(toChat))
      } else {
        setMessages([])
      }
    }
  }, [currentSessionId, sessions])

  return (
    <ChatContext.Provider value={{ messages, currentSessionId, sessions, addMessage, persistMessage, addStep, finishStep, setMessages, appendStream, createSession, switchSession, deleteSession, isLoading, setIsLoading }}>
      {children}
    </ChatContext.Provider>
  )
}
