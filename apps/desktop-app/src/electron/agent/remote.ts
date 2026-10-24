/**
 * Remote work over SSH/SFTP. Connections are configured by the user (host,
 * credentials) and referenced by name from the model; credentials never reach
 * the model. Every remote action asks for approval unless the mode is full-auto.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Client, type SFTPWrapper } from 'ssh2'
import { resolvePath, isInside } from './permissions'
import { ToolError, stringArg, optionalString, numberArg, type ToolSpec, type ToolContext } from './types'
import { truncateOutput } from './tools'

export type SshConnection = {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  /** SHA-256 fingerprint (base64) pinned on first use; later changes are refused. */
  hostKey?: string
}

export interface ConnectionStore {
  list(): Promise<SshConnection[]>
  pinHostKey(name: string, fingerprint: string): Promise<void>
}

const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_REMOTE_READ_BYTES = 2 * 1024 * 1024

export function parseConnection(raw: any): SshConnection {
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const name = text(raw?.name, 60)
  const host = text(raw?.host, 255)
  const username = text(raw?.username, 100)
  if (!name || !/^[\w.-]+$/.test(name)) throw new Error('Имя подключения: латиница, цифры, ._-')
  if (!host || !/^[\w.:-]+$/.test(host)) throw new Error('Некорректный адрес хоста')
  if (!username) throw new Error('Укажите имя пользователя')
  const authType = raw.authType === 'key' || raw.authType === 'agent' ? raw.authType : 'password'
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : 22
  return {
    name, host, port, username, authType,
    ...(authType === 'password' ? { password: typeof raw.password === 'string' ? raw.password : undefined } : {}),
    ...(authType === 'key' ? { privateKeyPath: text(raw.privateKeyPath, 500), passphrase: typeof raw.passphrase === 'string' && raw.passphrase ? raw.passphrase : undefined } : {}),
    ...(text(raw.hostKey, 100) ? { hostKey: text(raw.hostKey, 100) } : {}),
  }
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
}

const promisify = <T>(run: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => run((err, value) => (err ? reject(err) : resolve(value))))

/** Owns open SSH clients for the duration of one agent run. */
export class RemoteManager {
  private readonly clients = new Map<string, Promise<Client>>()

  constructor(private readonly store: ConnectionStore) {}

  async list(): Promise<SshConnection[]> {
    return this.store.list()
  }

  async describe(name: string): Promise<string> {
    const conn = (await this.store.list()).find((c) => c.name === name)
    return conn ? `${conn.username}@${conn.host}:${conn.port}` : name
  }

  client(name: string): Promise<Client> {
    let existing = this.clients.get(name)
    if (!existing) {
      existing = this.open(name)
      this.clients.set(name, existing)
      existing.catch(() => this.clients.delete(name))
    }
    return existing
  }

  private async open(name: string): Promise<Client> {
    const conn = (await this.store.list()).find((c) => c.name === name)
    if (!conn) throw new ToolError(`Подключение «${name}» не найдено. Список: list_connections`)

    let privateKey: Buffer | undefined
    if (conn.authType === 'key') {
      if (!conn.privateKeyPath) throw new ToolError(`Для «${name}» не указан файл ключа`)
      privateKey = await fs.promises.readFile(conn.privateKeyPath).catch(() => { throw new ToolError(`Не удалось прочитать ключ ${conn.privateKeyPath}`) })
    }

    return new Promise<Client>((resolve, reject) => {
      const client = new Client()
      let pinned: string | null = null
      client
        .on('ready', () => {
          if (pinned && !conn.hostKey) void this.store.pinHostKey(conn.name, pinned)
          resolve(client)
        })
        .on('error', (err) => reject(new ToolError(`SSH ${conn.host}: ${err.message}`)))
        .connect({
          host: conn.host,
          port: conn.port,
          username: conn.username,
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 15_000,
          password: conn.authType === 'password' ? conn.password : undefined,
          privateKey,
          passphrase: conn.passphrase,
          agent: conn.authType === 'agent' ? (process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK) : undefined,
          // Trust on first use: pin the fingerprint, refuse when it later changes.
          hostVerifier: (key: Buffer) => {
            const fingerprint = crypto.createHash('sha256').update(key).digest('base64')
            if (conn.hostKey && conn.hostKey !== fingerprint) {
              reject(new ToolError(`Ключ хоста ${conn.host} изменился (возможна подмена). Удалите и создайте подключение заново, если это ожидаемо.`))
              return false
            }
            pinned = fingerprint
            return true
          },
        })
    })
  }

  closeAll(): void {
    for (const pending of this.clients.values()) pending.then((c) => c.end()).catch(() => {})
    this.clients.clear()
  }
}

// ---- tools -----------------------------------------------------------------

function remoteOf(ctx: ToolContext): RemoteManager {
  return ctx.remote
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required })
const conn = { type: 'string', description: 'Имя подключения из list_connections' }

function askRemote(kind: 'read' | 'write' | 'exec', args: Record<string, unknown>, target: string) {
  const name = String(args.connection ?? '')
  const what = kind === 'exec' ? 'выполнение команды' : kind === 'write' ? 'запись' : 'чтение'
  return { level: 'ask', reason: `${what} на удалённом сервере «${name}» (${target})`, sessionKey: `ssh:${name}:${kind}` } as const
}

function execRemote(client: Client, command: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new ToolError(err.message))
      let output = ''
      let done = false
      const finish = (suffix: string) => { if (!done) { done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(truncateOutput(output.trim()) + suffix) } }
      const onAbort = () => { stream.close(); finish('\n[команда прервана]') }
      const timer = setTimeout(() => { stream.close(); finish(`\n[превышен таймаут ${Math.round(timeoutMs / 1000)} с]`) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      stream.on('data', (d: Buffer) => { if (output.length < 120_000) output += d.toString('utf8') })
      stream.stderr.on('data', (d: Buffer) => { if (output.length < 120_000) output += d.toString('utf8') })
      stream.on('close', (code: number | null) => finish(`\n[код выхода: ${code}]`))
    })
  })
}

export const REMOTE_TOOLS: ToolSpec[] = [
  {
    def: { name: 'list_connections', description: 'Список настроенных SSH/SFTP-подключений (имена и адреса, без паролей).', parameters: { type: 'object', properties: {} } },
    summarize: () => 'Список SSH-подключений',
    assess: () => ({ level: 'safe' }),
    async run(_a, ctx) {
      const list = await remoteOf(ctx).list()
      return list.length ? list.map((c) => `${c.name}: ${c.username}@${c.host}:${c.port} (${c.authType})`).join('\n') : 'Подключений нет. Добавьте их в разделе «Подключения».'
    },
  },
  {
    def: {
      name: 'ssh_exec',
      description: 'Выполняет команду на удалённом сервере по SSH и возвращает вывод и код выхода.',
      parameters: obj({ connection: conn, command: { type: 'string' }, timeout_ms: { type: 'number' } }, ['connection', 'command']),
    },
    summarize: (a) => `SSH ${String(a.connection)}: ${String(a.command).slice(0, 160)}`,
    assess: (a) => askRemote('exec', a, String(a.command ?? '').slice(0, 80)),
    async run(a, ctx) {
      const client = await remoteOf(ctx).client(stringArg(a, 'connection'))
      return execRemote(client, stringArg(a, 'command'), numberArg(a, 'timeout_ms', DEFAULT_EXEC_TIMEOUT_MS, 1000, 600_000), ctx.signal)
    },
  },
  {
    def: { name: 'sftp_list', description: 'Список файлов в каталоге на удалённом сервере (SFTP).', parameters: obj({ connection: conn, path: { type: 'string' } }, ['connection']) },
    summarize: (a) => `SFTP ${String(a.connection)}: список ${String(a.path ?? '.')}`,
    assess: (a) => askRemote('read', a, String(a.path ?? '.')),
    async run(a, ctx) {
      const sftp = await sftpOf(await remoteOf(ctx).client(stringArg(a, 'connection')))
      const dir = optionalString(a, 'path') ?? '.'
      const entries = await promisify<{ filename: string; longname: string }[]>((cb) => sftp.readdir(dir, cb as never))
      return entries.length ? entries.map((e) => e.longname).join('\n') : '(пусто)'
    },
  },
  {
    def: {
      name: 'sftp_read',
      description: 'Читает текстовый файл на удалённом сервере (SFTP).',
      parameters: obj({ connection: conn, path: { type: 'string' } }, ['connection', 'path']),
    },
    summarize: (a) => `SFTP ${String(a.connection)}: чтение ${String(a.path)}`,
    assess: (a) => askRemote('read', a, String(a.path ?? '')),
    async run(a, ctx) {
      const sftp = await sftpOf(await remoteOf(ctx).client(stringArg(a, 'connection')))
      const remotePath = stringArg(a, 'path')
      const chunks: Buffer[] = []
      let size = 0
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createReadStream(remotePath)
        stream.on('data', (c: Buffer) => { size += c.length; if (size > MAX_REMOTE_READ_BYTES) { stream.destroy(); reject(new ToolError('Файл больше 2 МБ: скачайте его через sftp_download')) } else chunks.push(c) })
        stream.on('end', resolve)
        stream.on('error', (e: Error) => reject(new ToolError(e.message)))
      })
      return truncateOutput(Buffer.concat(chunks).toString('utf8'))
    },
  },
  {
    def: {
      name: 'sftp_write',
      description: 'Записывает текстовый файл на удалённый сервер (SFTP), перезаписывая существующий.',
      parameters: obj({ connection: conn, path: { type: 'string' }, content: { type: 'string' } }, ['connection', 'path', 'content']),
    },
    summarize: (a) => `SFTP ${String(a.connection)}: запись ${String(a.path)}`,
    assess: (a) => askRemote('write', a, String(a.path ?? '')),
    async run(a, ctx) {
      const sftp = await sftpOf(await remoteOf(ctx).client(stringArg(a, 'connection')))
      const content = stringArg(a, 'content', false)
      await promisify<void>((cb) => sftp.writeFile(stringArg(a, 'path'), content, cb as never))
      return `Записано ${Buffer.byteLength(content)} байт`
    },
  },
  {
    def: {
      name: 'sftp_download',
      description: 'Скачивает файл с удалённого сервера на локальный диск.',
      parameters: obj({ connection: conn, remote_path: { type: 'string' }, local_path: { type: 'string' } }, ['connection', 'remote_path', 'local_path']),
    },
    summarize: (a) => `SFTP ${String(a.connection)}: скачать ${String(a.remote_path)} → ${String(a.local_path)}`,
    assess: (a, ctx) => {
      const local = resolvePath(ctx.workspace, String(a.local_path ?? ''))
      const outside = !ctx.workspace || !isInside(ctx.workspace, local)
      return { level: 'ask', reason: `чтение на сервере «${String(a.connection)}»${outside ? ` и запись вне рабочей папки (${local})` : ''}`, sessionKey: `ssh:${String(a.connection)}:${outside ? 'write' : 'read'}` }
    },
    async run(a, ctx) {
      const sftp = await sftpOf(await remoteOf(ctx).client(stringArg(a, 'connection')))
      const local = resolvePath(ctx.workspace, stringArg(a, 'local_path'))
      await fs.promises.mkdir(path.dirname(local), { recursive: true })
      await promisify<void>((cb) => sftp.fastGet(stringArg(a, 'remote_path'), local, cb as never))
      return `Скачано в ${local}`
    },
  },
  {
    def: {
      name: 'sftp_upload',
      description: 'Загружает локальный файл на удалённый сервер.',
      parameters: obj({ connection: conn, local_path: { type: 'string' }, remote_path: { type: 'string' } }, ['connection', 'local_path', 'remote_path']),
    },
    summarize: (a) => `SFTP ${String(a.connection)}: загрузить ${String(a.local_path)} → ${String(a.remote_path)}`,
    assess: (a) => askRemote('write', a, String(a.remote_path ?? '')),
    async run(a, ctx) {
      const sftp = await sftpOf(await remoteOf(ctx).client(stringArg(a, 'connection')))
      const local = resolvePath(ctx.workspace, stringArg(a, 'local_path'))
      await promisify<void>((cb) => sftp.fastPut(local, stringArg(a, 'remote_path'), cb as never))
      return `Загружено ${local}`
    },
  },
]
