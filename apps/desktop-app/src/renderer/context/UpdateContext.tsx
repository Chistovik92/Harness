import { createContext, useContext, useEffect, useState } from 'react'

type UpdateContext = {
  available: boolean
  downloaded: boolean
  install: () => void
}

const UpdateContext = createContext<UpdateContext | null>(null)

export function useUpdate() {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useUpdate must be used within UpdateProvider')
  return ctx
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [available, setAvailable] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  useEffect(() => {
    const offAvailable = window.__DSH__.update.onAvailable(() => setAvailable(true))
    const offDownloaded = window.__DSH__.update.onDownloaded(() => setDownloaded(true))
    return () => { offAvailable(); offDownloaded() }
  }, [])

  const install = () => { void window.__DSH__.update.install() }

  return (
    <UpdateContext.Provider value={{ available, downloaded, install }}>
      {children}
    </UpdateContext.Provider>
  )
}
