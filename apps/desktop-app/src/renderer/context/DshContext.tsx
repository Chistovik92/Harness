import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { Settings } from '../../electron/preload'

type DshContext = {
  settings: Settings
  saveSettings: (s: Partial<Settings>) => Promise<void>
  apiKey: string
  setApiKey: (v: string) => void
  baseUrl: string
  setBaseUrl: (v: string) => void
  model: string
  setModel: (v: string) => void
  isConnected: boolean
  setIsConnected: (v: boolean) => void
}

const DshContext = createContext<DshContext | null>(null)

export function useDsh() {
  const ctx = useContext(DshContext)
  if (!ctx) throw new Error('useDsh must be used within DshProvider')
  return ctx
}

export function DshProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>({})
  const [apiKey, setApiKeyState] = useState('')
  const [baseUrl, setBaseUrlState] = useState('https://api.deepseek.com')
  const [model, setModelState] = useState('deepseek-chat')
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    ;(async () => {
      const s = await window.__DSH__.settings.get()
      setSettingsState(s)
      setApiKeyState(s.apiKey ?? '')
      setBaseUrlState(s.baseUrl ?? 'https://api.deepseek.com')
      setModelState(s.model ?? 'deepseek-chat')
    })()
  }, [])

  const saveSettings = useCallback(async (s: Partial<Settings>) => {
    const next = await window.__DSH__.settings.set(s)
    setSettingsState(next)
    if (s.apiKey !== undefined) setApiKeyState(String(s.apiKey))
    if (s.baseUrl !== undefined) setBaseUrlState(String(s.baseUrl))
    if (s.model !== undefined) setModelState(String(s.model))
  }, [])

  return (
    <DshContext.Provider value={{ settings, saveSettings, apiKey, setApiKey: setApiKeyState, baseUrl, setBaseUrl: setBaseUrlState, model, setModel: setModelState, isConnected, setIsConnected }}>
      {children}
    </DshContext.Provider>
  )
}
