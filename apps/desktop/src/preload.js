/**
 * DeepSeek Harness Desktop - Preload script.
 *
 * Exposes a narrow, safe bridge from the renderer to the main process.
 * No filesystem access, no shell, no arbitrary pnpm arguments reach the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__DSH_DESKTOP__', {
  app: {
    getPath: (name) => ipcRenderer.invoke('app:getPath', name),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  },
})
