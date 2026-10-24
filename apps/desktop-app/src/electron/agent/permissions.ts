/**
 * Permission model for the agent environment.
 *
 * Modes:
 *  - ask-all        every tool call needs approval
 *  - workspace-auto reads/writes/commands inside the workspace run automatically;
 *                   anything that reaches outside it, risky commands and remote
 *                   hosts need approval (default)
 *  - full-auto      everything runs without asking
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import dns from 'node:dns'

export type PermissionMode = 'ask-all' | 'workspace-auto' | 'full-auto'
export const PERMISSION_MODES: PermissionMode[] = ['ask-all', 'workspace-auto', 'full-auto']

export type Assessment = { level: 'safe' } | { level: 'ask'; reason: string; sessionKey: string }

export type PermissionRequest = { tool: string; summary: string; reason: string; details?: string }
export type PermissionAnswer = 'once' | 'session' | 'deny'
export type Asker = (request: PermissionRequest) => Promise<PermissionAnswer>

const IS_WINDOWS = process.platform === 'win32'

// ---- paths -----------------------------------------------------------------

/** Resolves symlinks of the nearest existing ancestor so `..`/link escapes cannot pass as "inside". */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target)
  const rest: string[] = []
  let current = absolute
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return absolute
    rest.unshift(path.basename(current))
    current = parent
  }
  let real: string
  try { real = fs.realpathSync.native(current) } catch { real = current }
  return path.join(real, ...rest)
}

const isUnc = (p: string) => p.startsWith('\\\\') || p.startsWith('//')

export function isInside(root: string, target: string): boolean {
  // A network path outside a local workspace is "outside" by definition; probing it would stall on SMB timeouts.
  if (isUnc(target) && !isUnc(root)) return false
  const normalize = (p: string) => (IS_WINDOWS ? p.toLowerCase() : p)
  const r = normalize(canonicalPath(root))
  const t = normalize(canonicalPath(target))
  const rel = path.relative(r, t)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function resolvePath(workspace: string | null, p: string): string {
  const expanded = p.startsWith('~') ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', p.slice(1)) : p
  return path.resolve(workspace ?? process.cwd(), expanded)
}

// ---- shell commands --------------------------------------------------------

const RISKY_COMMANDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b|\brunas\b/i, reason: 'повышение привилегий' },
  { pattern: /\brm\s+(-\w+\s+)*(\/|~|\*|\.)(\s|$)/i, reason: 'массовое удаление' },
  { pattern: /\b(mkfs|fdisk|diskpart|dd\s+if=|shutdown|reboot|halt|poweroff|format\s+[a-z]:)\b/i, reason: 'системная/дисковая операция' },
  { pattern: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;&\n]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|python\d?)\b/i, reason: 'выполнение скачанного кода' },
  { pattern: /\bInvoke-Expression\b|\biex\b/i, reason: 'выполнение строки как кода' },
  { pattern: /\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bgh\s+(release|pr)\s+(create|merge)\b/i, reason: 'публикация во внешний сервис' },
  { pattern: /\b(reg\s+(add|delete)|schtasks|setx|crontab|chmod\s+-R|chown\s+-R|netsh|systemctl|launchctl)\b/i, reason: 'изменение настроек системы' },
  { pattern: /:\(\)\s*\{/, reason: 'fork-бомба' },
]

const ABSOLUTE_PATH_PATTERNS: RegExp[] = [
  /[A-Za-z]:[\\/][^\s"'|&;<>]*/g, // C:\dir
  /\\\\[^\s"'|&;<>]+/g, // \\server\share
  /(?:^|[\s"'=(])(\/[^\s"'|&;<>]+\/[^\s"'|&;<>]*)/g, // /usr/bin (2+ segments, so `cmd /s` is not a path)
]
const HOME_REFERENCE = /(^|[\s"'=])(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)([\\/\s"']|$)/i
const PARENT_REFERENCE = /(^|[\s"'=\\/])\.\.([\\/]|\s|$|["'])/

/** Returns a reason when the command should not run unattended, or null when it looks contained. */
export function riskyCommandReason(command: string, workspace: string | null): string | null {
  for (const { pattern, reason } of RISKY_COMMANDS) if (pattern.test(command)) return reason
  if (!workspace) return 'рабочая папка не выбрана'
  if (HOME_REFERENCE.test(command)) return 'обращение к домашней папке'
  if (PARENT_REFERENCE.test(command)) return 'выход за пределы рабочей папки (..)'
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    for (const match of command.matchAll(pattern)) {
      const candidate = (match[1] ?? match[0]).replace(/[),.;]+$/, '')
      if (candidate === '/dev/null') continue
      if (!isInside(workspace, candidate)) return `путь вне рабочей папки: ${candidate}`
    }
  }
  return null
}

// ---- network ---------------------------------------------------------------

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
}

/** True for loopback/LAN/link-local hosts: reaching them can expose local services. */
export async function isPrivateHost(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (net.isIP(bare)) return isPrivateAddress(bare)
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) return true
  try {
    const records = await dns.promises.lookup(bare, { all: true })
    return records.some((r) => isPrivateAddress(r.address))
  } catch {
    return false
  }
}

// ---- gate ------------------------------------------------------------------

export class PermissionDenied extends Error {}

export class PermissionGate {
  constructor(
    public mode: PermissionMode,
    private readonly asker: Asker,
    /** Session approvals; shared across runs by the caller so "allow for session" persists. */
    private readonly approved: Set<string> = new Set(),
  ) {}

  /** Throws when the user declines, so the tool result tells the model why. */
  async authorize(tool: string, summary: string, assessment: Assessment, details?: string): Promise<void> {
    if (this.mode === 'full-auto') return
    const needsAsk = this.mode === 'ask-all' || assessment.level === 'ask'
    if (!needsAsk) return

    const key = assessment.level === 'ask' ? assessment.sessionKey : `${tool}:*`
    if (this.approved.has(key)) return

    const reason = assessment.level === 'ask' ? assessment.reason : 'режим «всё с подтверждением»'
    const answer = await this.asker({ tool, summary, reason, details })
    if (answer === 'deny') throw new PermissionDenied(`Пользователь отклонил действие: ${summary}`)
    if (answer === 'session') this.approved.add(key)
  }
}
