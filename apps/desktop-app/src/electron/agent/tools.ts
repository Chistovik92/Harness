/**
 * Local tools for the agent: files, search, shell and web.
 * Remote (SSH/SFTP) tools live in remote.ts and are merged in registry.ts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isInside, resolvePath, riskyCommandReason, isPrivateHost } from './permissions'
import { ToolError, stringArg, optionalString, numberArg, type ToolSpec, type ToolContext, type ToolArgs } from './types'

export const MAX_OUTPUT_CHARS = 30_000
const MAX_READ_BYTES = 5 * 1024 * 1024
const DEFAULT_READ_LINES = 2000
const MAX_LIST_ENTRIES = 500
const MAX_GREP_MATCHES = 200
const MAX_WALK_ENTRIES = 50_000
const MAX_GREP_FILE_BYTES = 1024 * 1024
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
const FETCH_TIMEOUT_MS = 20_000
const MAX_FETCH_BYTES = 2 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
const MAX_REDIRECTS = 5

export function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return `${text.slice(0, head)}\n\n… [обрезано ${text.length - limit} символов] …\n\n${text.slice(-tail)}`
}

// ---- path helpers ----------------------------------------------------------

function outsideWorkspace(ctx: ToolContext, target: string): boolean {
  return !ctx.workspace || !isInside(ctx.workspace, target)
}

function pathAssessment(ctx: ToolContext, target: string, verb: string) {
  return outsideWorkspace(ctx, target)
    ? ({ level: 'ask', reason: `${verb} вне рабочей папки: ${target}`, sessionKey: `path:${path.dirname(target)}` } as const)
    : ({ level: 'safe' } as const)
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

// ---- walking & globbing ----------------------------------------------------

export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) { out += `(?:${pattern.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`; i = end } else out += '\\{'
    } else out += escapeRegExp(c)
  }
  return new RegExp(`^${out}$`, 'i')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function* walk(root: string, signal: AbortSignal): AsyncGenerator<{ full: string; rel: string }> {
  let seen = 0
  const stack = [root]
  while (stack.length > 0) {
    if (signal.aborted) return
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > MAX_WALK_ENTRIES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(full)
      } else if (entry.isFile()) {
        yield { full, rel: path.relative(root, full).split(path.sep).join('/') }
      }
    }
  }
}

// ---- shell -----------------------------------------------------------------

type ShellInfo = { name: string; file: string; args: (command: string) => string[] }
let cachedShell: ShellInfo | null = null

export function shellInfo(): ShellInfo {
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    const gitBash = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
      .filter((p): p is string => Boolean(p))
      .map((p) => path.join(p, 'Git', 'bin', 'bash.exe'))
      .find((p) => fs.existsSync(p))
    cachedShell = gitBash
      ? { name: 'bash (Git for Windows)', file: gitBash, args: (c) => ['-c', c] }
      : { name: 'Windows PowerShell', file: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c] }
  } else {
    cachedShell = { name: 'sh', file: '/bin/sh', args: (c) => ['-c', c] }
  }
  return cachedShell
}

function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
}

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const shell = shellInfo()
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args(command), { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let finished = false
    const append = (chunk: Buffer) => { if (output.length < MAX_OUTPUT_CHARS * 4) output += chunk.toString('utf8') }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const finish = (suffix: string, error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(truncateOutput(output.trim()) + suffix)
    }
    const onAbort = () => { killTree(child.pid); finish('\n[команда прервана]') }
    const timer = setTimeout(() => { killTree(child.pid); finish(`\n[превышен таймаут ${Math.round(timeoutMs / 1000)} с, команда остановлена]`) }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => finish('', new ToolError(`Не удалось запустить ${shell.name}: ${err.message}`)))
    child.on('close', (code) => finish(`\n[код выхода: ${code}]`))
  })
}

// ---- web -------------------------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function parseHttpUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new ToolError(`Некорректный URL: ${raw}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('Поддерживаются только http(s) URL')
  return url
}

/** GET with manual redirects; every hop is re-checked so a public URL cannot bounce into the LAN. */
async function safeGet(startUrl: URL, signal: AbortSignal): Promise<Response> {
  let url = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop > 0 && (await isPrivateHost(url.hostname))) throw new ToolError(`Редирект на внутренний адрес заблокирован: ${url.hostname}`)
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { 'User-Agent': 'DeepSeekHarness/1.0 (+https://github.com/Chistovik92/Harness)', Accept: 'text/html,application/json,text/plain,*/*' },
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = parseHttpUrl(new URL(res.headers.get('location')!, url).toString())
      continue
    }
    return res
  }
  throw new ToolError('Слишком много редиректов')
}

async function webAssessment(rawUrl: string) {
  const url = parseHttpUrl(rawUrl)
  return (await isPrivateHost(url.hostname))
    ? ({ level: 'ask', reason: `обращение к внутреннему адресу ${url.hostname}`, sessionKey: `host:${url.hostname}` } as const)
    : ({ level: 'safe' } as const)
}

// ---- the tools -------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) })

const readFile: ToolSpec = {
  def: {
    name: 'read_file',
    description: 'Читает текстовый файл и возвращает строки с номерами. Для больших файлов используйте offset и limit.',
    parameters: obj({
      path: { type: 'string', description: 'Путь к файлу (относительный — от рабочей папки)' },
      offset: { type: 'number', description: 'Номер первой строки (с 1)' },
      limit: { type: 'number', description: `Сколько строк вернуть (по умолчанию ${DEFAULT_READ_LINES})` },
    }, ['path']),
  },
  summarize: (a) => `Чтение файла ${String(a.path)}`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, String(a.path ?? '')), 'чтение'),
  async run(a, ctx) {
    const file = resolvePath(ctx.workspace, stringArg(a, 'path'))
    const stat = await fs.promises.stat(file).catch(() => { throw new ToolError(`Файл не найден: ${file}`) })
    if (!stat.isFile()) throw new ToolError(`Это не файл: ${file}`)
    if (stat.size > MAX_READ_BYTES) throw new ToolError(`Файл слишком большой (${stat.size} байт). Используйте grep или читайте частями командой.`)
    const buffer = await fs.promises.readFile(file)
    if (looksBinary(buffer)) throw new ToolError('Бинарный файл: чтение как текст невозможно')
    const lines = buffer.toString('utf8').split(/\r?\n/)
    const offset = numberArg(a, 'offset', 1, 1, Math.max(1, lines.length))
    const limit = numberArg(a, 'limit', DEFAULT_READ_LINES, 1, 20_000)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const body = slice.map((line, i) => `${offset + i}\t${line}`).join('\n')
    const more = offset - 1 + limit < lines.length ? `\n… ещё ${lines.length - (offset - 1 + limit)} строк (используйте offset)` : ''
    return truncateOutput(body + more)
  },
}

const writeFile: ToolSpec = {
  def: {
    name: 'write_file',
    description: 'Создаёт файл или полностью перезаписывает существующий. Недостающие папки создаются.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string', description: 'Полное содержимое файла' } }, ['path', 'content']),
  },
  summarize: (a) => `Запись файла ${String(a.path)}`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, String(a.path ?? '')), 'запись'),
  async run(a, ctx) {
    const file = resolvePath(ctx.workspace, stringArg(a, 'path'))
    const content = stringArg(a, 'content', false)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, content, 'utf8')
    return `Записано ${Buffer.byteLength(content)} байт в ${file}`
  },
}

const editFile: ToolSpec = {
  def: {
    name: 'edit_file',
    description: 'Заменяет точное вхождение old_string на new_string в файле. old_string должен быть уникальным, иначе укажите replace_all.',
    parameters: obj({
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Заменяемый фрагмент (точное совпадение, включая пробелы)' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
    }, ['path', 'old_string', 'new_string']),
  },
  summarize: (a) => `Правка файла ${String(a.path)}`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, String(a.path ?? '')), 'правка'),
  async run(a, ctx) {
    const file = resolvePath(ctx.workspace, stringArg(a, 'path'))
    const oldText = stringArg(a, 'old_string')
    const newText = stringArg(a, 'new_string', false)
    const original = await fs.promises.readFile(file, 'utf8').catch(() => { throw new ToolError(`Файл не найден: ${file}`) })
    const count = original.split(oldText).length - 1
    if (count === 0) throw new ToolError('old_string не найден в файле (проверьте пробелы и переносы строк)')
    if (count > 1 && a.replace_all !== true) throw new ToolError(`old_string встречается ${count} раз: расширьте контекст или передайте replace_all`)
    const updated = a.replace_all === true ? original.split(oldText).join(newText) : original.replace(oldText, () => newText)
    await fs.promises.writeFile(file, updated, 'utf8')
    return `Заменено вхождений: ${a.replace_all === true ? count : 1} в ${file}`
  },
}

const listDir: ToolSpec = {
  def: { name: 'list_dir', description: 'Список файлов и папок каталога.', parameters: obj({ path: { type: 'string', description: 'Каталог (по умолчанию — рабочая папка)' } }) },
  summarize: (a) => `Список каталога ${String(a.path ?? '.')}`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.'), 'просмотр'),
  async run(a, ctx) {
    const dir = resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.')
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => { throw new ToolError(`Каталог не найден: ${dir}`) })
    const sorted = entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
    const lines: string[] = []
    for (const entry of sorted.slice(0, MAX_LIST_ENTRIES)) {
      if (entry.isDirectory()) lines.push(`${entry.name}/`)
      else {
        const size = await fs.promises.stat(path.join(dir, entry.name)).then((s) => s.size).catch(() => 0)
        lines.push(`${entry.name}  (${size} Б)`)
      }
    }
    return `${dir}\n${lines.join('\n')}${sorted.length > MAX_LIST_ENTRIES ? `\n… ещё ${sorted.length - MAX_LIST_ENTRIES}` : ''}`
  },
}

const globTool: ToolSpec = {
  def: {
    name: 'glob',
    description: 'Ищет файлы по маске (например **/*.ts, src/**/*.{js,jsx}). node_modules и .git пропускаются.',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string', description: 'Корень поиска (по умолчанию — рабочая папка)' } }, ['pattern']),
  },
  summarize: (a) => `Поиск файлов ${String(a.pattern)}`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.'), 'поиск'),
  async run(a, ctx) {
    const root = resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.')
    const regex = globToRegExp(stringArg(a, 'pattern'))
    const found: string[] = []
    for await (const { rel } of walk(root, ctx.signal)) {
      if (regex.test(rel)) { found.push(rel); if (found.length >= MAX_LIST_ENTRIES) break }
    }
    return found.length ? found.join('\n') : 'Ничего не найдено'
  },
}

const grepTool: ToolSpec = {
  def: {
    name: 'grep',
    description: 'Ищет регулярное выражение в текстовых файлах. Возвращает путь:строка:текст.',
    parameters: obj({
      pattern: { type: 'string', description: 'Регулярное выражение (JavaScript)' },
      path: { type: 'string', description: 'Каталог или файл (по умолчанию — рабочая папка)' },
      glob: { type: 'string', description: 'Фильтр файлов, например **/*.ts' },
      ignore_case: { type: 'boolean' },
    }, ['pattern']),
  },
  summarize: (a) => `Поиск «${String(a.pattern)}»`,
  assess: (a, ctx) => pathAssessment(ctx, resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.'), 'поиск'),
  async run(a, ctx) {
    let regex: RegExp
    try { regex = new RegExp(stringArg(a, 'pattern'), a.ignore_case === true ? 'i' : '') } catch (err) { throw new ToolError(`Некорректное регулярное выражение: ${(err as Error).message}`) }
    const root = resolvePath(ctx.workspace, optionalString(a, 'path') ?? '.')
    const rootStat = await fs.promises.stat(root).catch(() => { throw new ToolError(`Путь не найден: ${root}`) })
    const filter = optionalString(a, 'glob') ? globToRegExp(optionalString(a, 'glob')!) : null
    const files: AsyncGenerator<{ full: string; rel: string }> | { full: string; rel: string }[] = rootStat.isFile()
      ? [{ full: root, rel: path.basename(root) }]
      : walk(root, ctx.signal)
    const matches: string[] = []
    for await (const { full, rel } of files) {
      if (filter && !filter.test(rel)) continue
      const stat = await fs.promises.stat(full).catch(() => null)
      if (!stat || stat.size > MAX_GREP_FILE_BYTES) continue
      const buffer = await fs.promises.readFile(full).catch(() => null)
      if (!buffer || looksBinary(buffer)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`)
          if (matches.length >= MAX_GREP_MATCHES) return `${matches.join('\n')}\n… достигнут лимит ${MAX_GREP_MATCHES} совпадений`
        }
      }
    }
    return matches.length ? matches.join('\n') : 'Совпадений нет'
  },
}

const bashTool: ToolSpec = {
  def: {
    name: 'bash',
    description: `Выполняет команду в терминале (${shellInfo().name}) в рабочей папке и возвращает вывод и код выхода. Не запускайте интерактивные команды.`,
    parameters: obj({
      command: { type: 'string' },
      timeout_ms: { type: 'number', description: 'Таймаут в миллисекундах (по умолчанию 120000, максимум 600000)' },
    }, ['command']),
  },
  summarize: (a) => `Команда: ${String(a.command).slice(0, 200)}`,
  assess(a, ctx) {
    const reason = riskyCommandReason(String(a.command ?? ''), ctx.workspace)
    return reason ? { level: 'ask', reason, sessionKey: `bash:${reason}` } : { level: 'safe' }
  },
  async run(a, ctx) {
    const command = stringArg(a, 'command')
    const cwd = ctx.workspace ?? process.cwd()
    return runShell(command, cwd, numberArg(a, 'timeout_ms', 120_000, 1_000, 600_000), ctx.signal)
  },
}

// ---- web search -------------------------------------------------------------

export type WebSearchHit = { title: string; url: string; snippet: string }

/**
 * Web search without API keys, via DuckDuckGo's HTML endpoint. Good enough for
 * agent research; MCP search servers can be added for higher quality.
 */
export async function webSearch(query: string, signal: AbortSignal, maxHits = 6): Promise<WebSearchHit[]> {
  const res = await safeGet(parseHttpUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`), signal)
  if (!res.ok) throw new ToolError(`Поисковик вернул HTTP ${res.status}`)
  const html = Buffer.from(await res.arrayBuffer()).toString('utf8')
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?<\/div>/gi
  for (const m of html.matchAll(re)) {
    let url = m[1]
    // DDG wraps outgoing links: /l/?uddg=<encoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const strip = (s: string) => htmlToText(s).slice(0, 400)
    hits.push({ title: strip(m[2]) || url, url, snippet: strip(m[3] ?? '') })
    if (hits.length >= maxHits) break
  }
  return hits
}

const webSearchTool: ToolSpec = {
  def: {
    name: 'web_search',
    description: 'Ищет в интернете (DuckDuckGo) и возвращает список страниц: заголовок, URL, краткое описание. Для содержимого страницы используйте web_fetch.',
    parameters: obj({
      query: { type: 'string', description: 'Поисковый запрос' },
      max_results: { type: 'number', description: 'Сколько результатов (по умолчанию 6, максимум 10)' },
    }, ['query']),
  },
  summarize: (a) => `Поиск в интернете: ${String(a.query)}`,
  assess: (a) => ({ level: 'safe' } as const),
  async run(a, ctx) {
    const query = stringArg(a, 'query').slice(0, 400)
    if (!query.trim()) throw new ToolError('Пустой поисковый запрос')
    const hits = await webSearch(query, ctx.signal, numberArg(a, 'max_results', 6, 1, 10))
    if (hits.length === 0) return 'Ничего не найдено. Попробуйте переформулировать запрос.'
    return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n')
  },
}

const webFetch: ToolSpec = {  def: {
    name: 'web_fetch',
    description: 'Загружает http(s)-страницу или API-ответ (GET) и возвращает текст. HTML очищается от разметки.',
    parameters: obj({ url: { type: 'string' }, max_chars: { type: 'number', description: 'Максимум символов (по умолчанию 20000)' } }, ['url']),
  },
  summarize: (a) => `Загрузка ${String(a.url)}`,
  assess: (a) => webAssessment(String(a.url ?? '')),
  async run(a, ctx) {
    const res = await safeGet(parseHttpUrl(stringArg(a, 'url')), ctx.signal)
    if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText}`)
    const type = res.headers.get('content-type') ?? ''
    if (!/text|json|xml|javascript|yaml/i.test(type)) throw new ToolError(`Тип содержимого не текстовый (${type || 'неизвестен'}); используйте download_file`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > MAX_FETCH_BYTES) throw new ToolError(`Ответ слишком большой (${buffer.length} байт)`)
    const raw = buffer.toString('utf8')
    const text = /html/i.test(type) ? htmlToText(raw) : raw
    return truncateOutput(text, numberArg(a, 'max_chars', 20_000, 500, MAX_OUTPUT_CHARS))
  },
}

const downloadFile: ToolSpec = {
  def: {
    name: 'download_file',
    description: 'Скачивает файл по http(s) URL и сохраняет на диск (например в рабочую папку).',
    parameters: obj({ url: { type: 'string' }, path: { type: 'string', description: 'Куда сохранить' } }, ['url', 'path']),
  },
  summarize: (a) => `Скачивание ${String(a.url)} → ${String(a.path)}`,
  async assess(a, ctx) {
    const web = await webAssessment(String(a.url ?? ''))
    if (web.level === 'ask') return web
    return pathAssessment(ctx, resolvePath(ctx.workspace, String(a.path ?? '')), 'запись')
  },
  async run(a, ctx) {
    const dest = resolvePath(ctx.workspace, stringArg(a, 'path'))
    const res = await safeGet(parseHttpUrl(stringArg(a, 'url')), ctx.signal)
    if (!res.ok || !res.body) throw new ToolError(`HTTP ${res.status} ${res.statusText}`)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    let written = 0
    const limiter = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        written += chunk.length
        if (written > MAX_DOWNLOAD_BYTES) throw new ToolError('Файл больше допустимого размера (500 МБ)')
        yield chunk
      }
    }
    try {
      await pipeline(Readable.fromWeb(res.body as never), limiter, fs.createWriteStream(dest), { signal: ctx.signal })
    } catch (err) {
      await fs.promises.rm(dest, { force: true })
      throw err instanceof ToolError ? err : new ToolError(`Не удалось скачать: ${(err as Error).message}`)
    }
    return `Сохранено ${written} байт в ${dest}`
  },
}

export const LOCAL_TOOLS: ToolSpec[] = [readFile, writeFile, editFile, listDir, globTool, grepTool, bashTool, webSearchTool, webFetch, downloadFile]

export type { ToolArgs }
