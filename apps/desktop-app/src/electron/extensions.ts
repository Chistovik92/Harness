/**
 * Extensions for the agent: web search, MCP (Model Context Protocol) servers
 * and Claude-Code-compatible skills (SKILL.md).
 *
 * Everything is stored in a plain JSON file in userData; secrets never live here —
 * MCP env vars that contain keys stay in the plain file by explicit user choice.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

// ---- config -----------------------------------------------------------------

export type McpServerConfig = {
  /** Unique id. */
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export type SkillConfig = {
  /** Directory containing the skill (…/skills/<name>/SKILL.md). */
  dir: string
  name: string
  description: string
  /** Set for single-file skills (<name>.md); the SKILL.md of the dir otherwise. */
  file?: string
  /** True when the skill came from a scanned folder rather than an explicit add. */
  scanned?: boolean
  disabled?: boolean
}

export type ExtensionsConfig = {
  mcpServers: McpServerConfig[]
  skillDirs: string[]
  disabledSkills: string[]
  /** Custom download folder for GGUF models; empty = default userData/gguf. */
  ggufDownloadDir?: string
}

const DEFAULTS: ExtensionsConfig = { mcpServers: [], skillDirs: [], disabledSkills: [] }

export function loadExtensions(file: string): ExtensionsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ExtensionsConfig>
    return {
      mcpServers: sanitizeServers(raw.mcpServers),
      skillDirs: Array.isArray(raw.skillDirs) ? raw.skillDirs.filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, 20) : [],
      disabledSkills: Array.isArray(raw.disabledSkills) ? raw.disabledSkills.slice(0, 500) : [],
      ...(typeof raw.ggufDownloadDir === 'string' && raw.ggufDownloadDir ? { ggufDownloadDir: raw.ggufDownloadDir } : {}),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveExtensions(file: string, cfg: ExtensionsConfig): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, file)
}

function sanitizeServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s: any, i: number): McpServerConfig | null => {
      // opencode style: command as one array; Claude/Codex style: command + args.
      const commandList = Array.isArray(s?.command) ? s.command.filter((c: unknown): c is string => typeof c === 'string') : null
      const command = typeof s?.command === 'string' ? s.command.trim() : commandList?.[0] ?? ''
      if (!command) return null
      const args = commandList ? commandList.slice(1) : Array.isArray(s?.args) ? s.args.filter((a: unknown): a is string => typeof a === 'string') : []
      const env = s?.env ?? s?.environment
      return {
        id: typeof s?.id === 'string' && s.id ? s.id.slice(0, 80) : `mcp-${i}`,
        name: typeof s?.name === 'string' && s.name ? s.name.slice(0, 120) : command,
        command: command.slice(0, 500),
        args: args.slice(0, 50),
        env: env && typeof env === 'object'
          ? Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof k === 'string' && typeof v === 'string').slice(0, 30) as [string, string][])
          : undefined,
        // `disabled` is how opencode marks a server off; `enabled` is ours.
        enabled: s?.enabled !== false && s?.disabled !== true,
      }
    })
    .filter((s): s is McpServerConfig => s !== null)
    .slice(0, 30)
}

/** Parses a Claude Code `.mcp.json` ({"mcpServers": {...}}) into server configs. */
export function parseMcpJson(text: string): McpServerConfig[] {
  const parsed = JSON.parse(text) as any
  const servers = parsed?.mcpServers ?? parsed?.mcp_servers
  if (!servers || typeof servers !== 'object') throw new Error('Не найден ключ "mcpServers"')
  return sanitizeServers(Object.entries(servers).map(([name, cfg]: [string, any]) => ({ ...cfg, name })))
}

/** Parses an opencode config (`mcp.servers` with local/remote entries; only local ones apply). */
export function parseOpenCodeConfig(text: string): McpServerConfig[] {
  const parsed = JSON.parse(text) as any
  const servers = parsed?.mcp?.servers
  if (!servers || typeof servers !== 'object') throw new Error('Не найден ключ "mcp.servers"')
  return sanitizeServers(Object.entries(servers)
    .filter(([, cfg]: [string, any]) => !cfg?.type || cfg.type === 'local')
    .map(([name, cfg]: [string, any]) => ({ ...cfg, name })))
}

/**
 * Parses Codex `config.toml` MCP sections: [mcp_servers.name] with command/args/env.
 * A small purpose-built reader — full TOML is not needed for this shape.
 */
export function parseCodexConfig(text: string): McpServerConfig[] {
  const sections = new Map<string, Record<string, string | string[]>>()
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[(mcp_servers\.[\w-]+)\]$/.exec(line)
    if (header) { current = header[1]; sections.set(current, {}); continue }
    if (!current) continue
    const kv = /^([\w-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value.startsWith('[')) {
      const inner = value.slice(1, value.indexOf(']') > 0 ? value.indexOf(']') : undefined)
      sections.get(current)![key] = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      sections.get(current)![key] = value.replace(/^["']|["']$/g, '')
    }
  }
  const out: McpServerConfig[] = []
  for (const [section, kv] of sections) {
    const name = section.split('.')[1]
    const command = typeof kv.command === 'string' ? kv.command : undefined
    if (!command) continue
    out.push({
      id: name, name,
      command,
      args: Array.isArray(kv.args) ? kv.args : [],
      env: undefined,
      enabled: true,
    })
  }
  return out
}

// ---- skills (SKILL.md / <name>.md, Claude Code & opencode compatible) -------

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 512 * 1024
/** Refuse to read beyond the skill's directory (no ../, no absolute escapes). */
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024

export function readSkill(dir: string): SkillConfig | null {
  try {
    const file = path.join(dir, SKILL_FILE)
    if (!fs.existsSync(file)) return null
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null
    const text = fs.readFileSync(file, 'utf-8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) return null
    const frontmatter = m[1]
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? path.basename(dir)
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? ''
    if (!description) return null
    return { dir, name: name.slice(0, 120), description: description.slice(0, 500) }
  } catch {
    return null
  }
}

/** A single-file skill: <name>.md with the same frontmatter (opencode/AGENTS style). */
export function readSingleFileSkill(file: string): SkillConfig | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null
    const text = fs.readFileSync(file, 'utf-8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) return null
    const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? path.basename(file, '.md')
    const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
    if (!description) return null
    return { dir: path.dirname(file), name: name.slice(0, 120), description: description.slice(0, 500), file: path.basename(file) }
  } catch {
    return null
  }
}

export function scanSkillDir(root: string): SkillConfig[] {
  try {
    const out: SkillConfig[] = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const s = readSkill(path.join(root, entry.name))
        if (s) out.push(s)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toUpperCase() !== 'SKILL.MD') {
        const s = readSingleFileSkill(path.join(root, entry.name))
        if (s) out.push(s)
      }
    }
    return out
  } catch {
    return []
  }
}

/** All skills from configured dirs (each dir is a skill, a folder of skills, or holds single-file skills). */
export function collectSkills(cfg: ExtensionsConfig): SkillConfig[] {
  const out: SkillConfig[] = []
  const seen = new Set<string>()
  const push = (s: SkillConfig | null) => { if (s && !seen.has(s.dir + '/' + s.name)) { seen.add(s.dir + '/' + s.name); out.push(s) } }
  for (const dir of cfg.skillDirs) {
    push(readSkill(dir))
    for (const s of scanSkillDir(dir)) push(s)
  }
  return out
}

/** Files of a skill's directory, shown to the model like opencode's <skill_files>. */
export function skillFiles(dir: string, file?: string, limit = 10): string[] {
  try {
    if (file) return [path.basename(file)]
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toUpperCase() !== 'SKILL.MD')
      .map((e) => e.name)
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

function readSkillFile(dir: string, name: string, limit = MAX_SKILL_FILE_BYTES): string | null {
  const target = path.resolve(dir, name)
  if (!target.startsWith(path.resolve(dir) + path.sep)) return null
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile() || stat.size > limit) return null
    return fs.readFileSync(target, 'utf-8')
  } catch {
    return null
  }
}

/** Full skill output for the model, in the <skill_content> shape opencode uses. */
export function skillModelOutput(skill: SkillConfig, maxChars = 40_000): string {
  const dir = skill.dir
  const body = readSkillFile(dir, skill.file ?? SKILL_FILE)
  if (body === null) return `Не удалось прочитать скилл: ${dir}`
  const files = skillFiles(dir, skill.file)
  const content = body.length > maxChars ? `${body.slice(0, maxChars)}\n\n… [обрезано]` : body
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    '',
    content.trim(),
    '',
    `Base directory for this skill: ${dir}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
    '',
    '<skill_files>',
    ...files.map((f) => `<file>${f}</file>`),
    '</skill_files>',
    '</skill_content>',
  ].join('\n')
}

export function skillPrompt(skills: SkillConfig[]): string {
  if (skills.length === 0) return ''
  const entries = skills.flatMap((s) => [
    '  <skill>',
    `    <name>${s.name}</name>`,
    `    <description>${s.description}</description>`,
    `    <dir>${s.dir}</dir>`,
    '  </skill>',
  ])
  return [
    '',
    '## Skills',
    '',
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the read_skill tool to load a skill when a task matches its description.',
    'The user may also invoke a skill directly by name; a skill already shown in the conversation does not need to be loaded again.',
    '<available_skills>',
    ...entries,
    '</available_skills>',
  ].join('\n')
}

// ---- MCP client (stdio) ------------------------------------------------------

type JsonRpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
type JsonRpcResponse = { jsonrpc: '2.0'; id: number; result?: any; error?: { code: number; message: string } }

const MCP_TIMEOUT_MS = 30_000
/** A server writing more than this without a newline is misbehaving; drop the connection. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Keep this much of stderr to explain an unexpected exit (opencode-style). */
const STDERR_TAIL = 2000

/** One running MCP server process; tools are listed once after init. */
export class McpConnection {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private stderrTail = ''
  private serverTools: McpTool[] = []

  constructor(public readonly config: McpServerConfig) {}

  get tools(): McpTool[] { return this.serverTools }

  get running(): boolean { return this.proc !== null && this.proc.exitCode === null }

  async start(): Promise<void> {
    if (this.running) return
    try {
      this.proc = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams
      this.proc.stdout.setEncoding('utf-8')
      this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
      this.proc.stderr.setEncoding('utf-8')
      this.proc.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL)
        const line = String(chunk).trim()
        if (line) console.error(`[mcp:${this.config.name}] ${line.slice(0, 500)}`)
      })
      // The tail names the cause when a server dies mid-session.
      this.proc.on('exit', (code) => {
        this.proc = null
        const tail = this.stderrTail.trim()
        const base = code === null ? 'Сервер MCP остановился' : `Сервер MCP остановился (код ${code})`
        this.rejectAll(new Error(tail ? `${base}: ${tail.slice(0, 500)}` : base))
      })
      this.proc.on('error', (err) => { this.proc = null; this.rejectAll(new Error(`Сервер MCP не запускается: ${err.message}`)) })

      const init = await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'DeepSeek Harness', version: '1.0.17' },
      })
      void this.notify('notifications/initialized', {})
      const caps = init?.capabilities ?? {}
      if (caps?.tools) {
        const list = await this.request('tools/list', {})
        this.serverTools = (Array.isArray(list?.tools) ? list.tools : []).map(toMcpTool)
      }
    } catch (err) {
      this.stop()
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME_BYTES) {
      // A server writing megabytes without a newline is misbehaving: drop the connection.
      console.error(`[mcp:${this.config.name}] stdout exceeds ${MAX_FRAME_BYTES} bytes without a newline`)
      this.stop()
      return
    }
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (typeof msg.id !== 'number') continue
        const entry = this.pending.get(msg.id)
        if (!entry) continue
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.error) entry.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`))
        else entry.resolve(msg.result)
      } catch { /* not JSON — ignore */ }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(err) }
    this.pending.clear()
    this.serverTools = []
  }

  private request(method: string, params: unknown): Promise<any> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return Promise.reject(new Error(`Сервер MCP «${this.config.name}» не запущен`))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Таймаут MCP-запроса ${method}`)) }, MCP_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try { proc.stdin.write(payload) } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err as Error) }
    })
  }

  private notify(method: string, params: unknown): void {
    try { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') } catch { /* best effort */ }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    const content = Array.isArray(res?.content) ? res.content : []
    const text = content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
    if (res?.isError) throw new Error(text || 'Инструмент MCP вернул ошибку')
    return text || '(пустой результат)'
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    this.rejectAll(new Error('Соединение MCP закрыто'))
    if (proc) { try { proc.kill() } catch { /* already gone */ } }
  }
}

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function toMcpTool(t: any): McpTool {
  return {
    name: String(t?.name ?? '').slice(0, 120),
    description: String(t?.description ?? '').slice(0, 1000),
    inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  }
}

/** Manager owning all configured connections; tools are addressed as `mcp__<server>__<tool>`. */
export class McpManager {
  private connections = new Map<string, McpConnection>()

  constructor(private file: string, private load: (file: string) => ExtensionsConfig) {}

  config(): ExtensionsConfig { return this.load(this.file) }

  private async conn(serverId: string): Promise<McpConnection> {
    let c = this.connections.get(serverId)
    if (!c || !c.running) {
      const cfg = this.config().mcpServers.find((s) => s.id === serverId)
      if (!cfg) throw new Error(`MCP-сервер «${serverId}» не найден`)
      if (!c) { c = new McpConnection(cfg); this.connections.set(serverId, c) }
      await c.start()
    }
    return c
  }

  /** Tools of all enabled servers, lazily starting each one. */
  async tools(): Promise<Array<McpTool & { serverId: string; qualifiedName: string }>> {
    const cfg = this.config()
    const out: Array<McpTool & { serverId: string; qualifiedName: string }> = []
    for (const server of cfg.mcpServers.filter((s) => s.enabled)) {
      try {
        const c = await this.conn(server.id)
        for (const t of c.tools) out.push({ ...t, serverId: server.id, qualifiedName: `mcp__${server.id}__${t.name}` })
      } catch (err) {
        console.error(`MCP «${server.name}»: ${err instanceof Error ? err.message : err}`)
      }
    }
    return out
  }

  async call(serverId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const c = await this.conn(serverId)
    return c.callTool(tool, args)
  }

  stopAll(): void {
    for (const [, c] of this.connections) c.stop()
    this.connections.clear()
  }
}

export const MCP_NAME_RE = /^mcp__([\w.-]+)__(.+)$/

export function parseMcpToolName(qualified: string): { serverId: string; tool: string } | null {
  const m = MCP_NAME_RE.exec(qualified)
  return m ? { serverId: m[1], tool: m[2] } : null
}
