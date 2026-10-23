import { createContext, useContext } from 'react'

type UpdateContext = {
  available: boolean
  downloaded: boolean
  check: () => void
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

  const check = () => {
    // electron-updater runs in main; renderer receives events via IPC
  }
  const install = () => {
    // handled by main on 'update:downloaded'
  }

  return (
    <UpdateContext.Provider value={{ available, downloaded, check, install }}>
      {children}
    </UpdateContext.Provider>
  )
}

import { useState } from 'react'
