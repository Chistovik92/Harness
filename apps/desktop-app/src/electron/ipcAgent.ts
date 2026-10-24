/**
 * IPC for the agent environment: workspace folder, SSH connections and the
 * approval dialog that gates risky tool calls.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { PermissionGate, PERMISSION_MODES, type Asker, type PermissionAnswer, type PermissionMode } from './agent/permissions'
import { RemoteManager, parseConnection, type SshConnection, type ConnectionStore } from './agent/remote'
import type { ToolContext } from './agent/types'
import type { EncryptedStore } from './store'

type PublicConnection = Omit<SshConnection, 'password' | 'passphrase'> & { hasPassword: boolean; hasPassphrase: boolean }

const toPublic = ({ password, passphrase, ...rest }: SshConnection): PublicConnection => ({ ...rest, hasPassword: Boolean(password), hasPassphrase: Boolean(passphrase) })
const ANSWERS: PermissionAnswer[] = ['once', 'session', 'deny']

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode)
}

export function validWorkspace(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return fs.statSync(value).isDirectory() ? value : null } catch { return null }
}

export function registerAgentIpc(connections: EncryptedStore<SshConnection[]>) {
  const pending = new Map<string, (answer: PermissionAnswer) => void>()
  /** "Allow for this session" approvals survive across messages of the same window. */
  const sessionApprovals = new Map<number, Set<string>>()

  const connectionStore: ConnectionStore = {
    list: () => connections.read(),
    pinHostKey: (name, fingerprint) => connections.update((list) => ({
      value: list.map((c) => (c.name === name && !c.hostKey ? { ...c, hostKey: fingerprint } : c)),
      result: undefined,
    })),
  }

  ipcMain.handle('agent:permissionReply', (_e, reply: { id?: string; answer?: string }) => {
    const resolve = typeof reply?.id === 'string' ? pending.get(reply.id) : undefined
    if (!resolve) return
    pending.delete(reply.id!)
    resolve(ANSWERS.includes(reply.answer as PermissionAnswer) ? (reply.answer as PermissionAnswer) : 'deny')
  })

  ipcMain.handle('agent:pickWorkspace', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, title: 'Рабочая папка агента' }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('ssh:list', async () => (await connections.read()).map(toPublic))

  ipcMain.handle('ssh:set', async (_e, raw) => {
    const incoming = parseConnection(raw)
    await connections.update((list) => {
      const existing = list.find((c) => c.name === incoming.name)
      // An empty secret field on edit means "keep the stored one".
      const merged: SshConnection = {
        ...incoming,
        password: incoming.authType === 'password' ? (incoming.password || existing?.password) : undefined,
        passphrase: incoming.authType === 'key' ? (incoming.passphrase || existing?.passphrase) : undefined,
        hostKey: existing && existing.host === incoming.host && existing.port === incoming.port ? existing.hostKey : undefined,
      }
      return { value: [...list.filter((c) => c.name !== incoming.name), merged], result: undefined }
    })
  })

  ipcMain.handle('ssh:remove', (_e, name: string) => connections.update((list) => ({ value: list.filter((c) => c.name !== name), result: undefined })))

  ipcMain.handle('ssh:test', async (_e, name: string) => {
    const remote = new RemoteManager(connectionStore)
    try {
      const client = await remote.client(name)
      await new Promise<void>((resolve, reject) => client.exec('echo ok', (err, stream) => {
        if (err) return reject(err)
        stream.on('close', () => resolve()).resume()
      }))
      return { ok: true, message: `Подключено: ${await remote.describe(name)}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      remote.closeAll()
    }
  })

  const askerFor = (sender: WebContents, signal: AbortSignal): Asker => (request) => new Promise((resolve) => {
    if (sender.isDestroyed() || signal.aborted) return resolve('deny')
    const id = crypto.randomUUID()
    pending.set(id, resolve)
    sender.send('agent:permission', { id, ...request })
    signal.addEventListener('abort', () => { if (pending.delete(id)) resolve('deny') }, { once: true })
  })

  /** Everything a tool may use during one agent run. */
  function createContext(sender: WebContents, workspace: string | null, mode: PermissionMode, signal: AbortSignal): ToolContext {
    let approved = sessionApprovals.get(sender.id)
    if (!approved) { approved = new Set(); sessionApprovals.set(sender.id, approved) }
    return {
      workspace,
      gate: new PermissionGate(mode, askerFor(sender, signal), approved),
      signal,
      remote: new RemoteManager(connectionStore),
    }
  }

  return { createContext }
}
