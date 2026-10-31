import { useEffect, useState, useCallback } from 'react'
import { X, Plus, Trash2, Play, Upload, FolderOpen, FileCode, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import type { ExtensionsInfo, McpServerInfo, McpTestResult } from '../electron/preload'

type EditableServer = Partial<McpServerInfo> & { command: string }

/** Adds or edits an MCP server (stdio command). Empty command = add form hidden. */
function ServerForm({ initial, onSave, onCancel }: { initial?: McpServerInfo; onSave: (s: EditableServer) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join(' '))
  const [env, setEnv] = useState(Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'))

  const submit = () => {
    const trimmed = command.trim()
    if (!trimmed) return
    const envMap: Record<string, string> = {}
    for (const line of env.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq > 0) envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    onSave({
      id: initial?.id,
      name: name.trim() || undefined,
      command: trimmed,
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: Object.keys(envMap).length > 0 ? envMap : undefined,
    })
  }

  return (
    <div className="p-4 rounded-xl border border-slate-700 bg-slate-950/60 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-400">Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" className="mt-1 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Команда *</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem /путь" className="mt-1 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-slate-400">Аргументы (через пробел)</span>
        <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="/home/user/documents --allow-write" className="mt-1 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
      </label>
      <label className="block">
        <span className="text-xs text-slate-400">Переменные окружения (KEY=value, по одной в строке)</span>
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder="API_KEY=secret" className="mt-1 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
      </label>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:bg-slate-800">Отмена</button>
        <button onClick={submit} disabled={!command.trim()} className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white">Сохранить</button>
      </div>
    </div>
  )
}

export default function ExtensionsPage({ onBack }: { onBack: () => void }) {
  const [info, setInfo] = useState<ExtensionsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<McpServerInfo | 'new' | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<McpTestResult[] | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setInfo(await window.__DSH__.ext.get())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const saveServer = async (s: EditableServer) => {
    try {
      await window.__DSH__.ext.setMcpServer(s)
      setEditing(null)
      setTestResults(null)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeServer = async (id: string) => {
    try {
      await window.__DSH__.ext.removeMcpServer(id)
      setTestResults(null)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResults(null)
    try {
      setTestResults(await window.__DSH__.ext.testMcp())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const importMcp = async () => {
    setImportMsg(null)
    try {
      const res = await window.__DSH__.ext.importMcp()
      setImportMsg(res.imported > 0 ? `Импортировано серверов: ${res.imported}` : 'Новые серверы не найдены (возможно, уже добавлены)')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const addSkillDir = async () => {
    try {
      await window.__DSH__.ext.addSkillDir()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeSkillDir = async (dir: string) => {
    try {
      await window.__DSH__.ext.removeSkillDir(dir)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const servers = info?.mcpServers ?? []
  const skills = info?.skills ?? []
  const skillDirs = info?.skillDirs ?? []

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-red-200 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto p-1 hover:text-white"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ---- MCP servers ---- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-slate-100">MCP-серверы</h2>
          <div className="flex gap-2">
            <button onClick={() => void test()} disabled={testing || servers.length === 0} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-700 hover:bg-slate-800 text-slate-300 disabled:opacity-50">
              <Play className="w-3.5 h-3.5" /> {testing ? 'Проверка…' : 'Проверить'}
            </button>
            <button onClick={() => void importMcp()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-700 hover:bg-slate-800 text-slate-300" title="Импорт из .mcp.json (Claude Code), opencode.json или config.toml (Codex)">
              <Upload className="w-3.5 h-3.5" /> Импорт
            </button>
            <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white">
              <Plus className="w-4 h-4" /> Добавить
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-500">Серверы Model Context Protocol добавляют агенту сторонние инструменты (файлы, браузер, базы данных…). Их инструменты доступны в режиме агента, каждый вызов спрашивает разрешение.</p>
        {importMsg && <div className="p-2 rounded-lg bg-emerald-900/20 border border-emerald-700/50 text-emerald-200 text-xs">{importMsg}</div>}

        {editing && (
          <ServerForm
            initial={editing === 'new' ? undefined : editing}
            onSave={saveServer}
            onCancel={() => setEditing(null)}
          />
        )}

        {servers.length === 0 && !editing && (
          <div className="p-4 rounded-xl border border-dashed border-slate-700 text-sm text-slate-500">Серверов пока нет. Добавьте свой или импортируйте из конфига Claude Code / opencode / Codex.</div>
        )}

        <div className="space-y-2">
          {servers.map((s) => {
            const tr = testResults?.find((r) => r.id === s.id)
            return (
              <div key={s.id} className="p-3 rounded-xl border border-slate-800 bg-slate-950/40">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{s.name}</span>
                  {!s.enabled && <span className="text-xs text-slate-500">(выключен)</span>}
                  {tr && (tr.ok
                    ? <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> работает, инструментов: {tr.toolCount}</span>
                    : <span className="flex items-center gap-1 text-xs text-red-400"><AlertCircle className="w-3.5 h-3.5" /> не отвечает</span>)}
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => void window.__DSH__.ext.setMcpServer({ ...s, enabled: !s.enabled })} className="px-2 py-1 rounded text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200">{s.enabled ? 'Выключить' : 'Включить'}</button>
                    <button onClick={() => setEditing(s)} className="px-2 py-1 rounded text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200">Изменить</button>
                    <button onClick={() => void removeServer(s.id)} aria-label="Удалить" className="p-1.5 rounded text-slate-500 hover:bg-red-900/40 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
                <div className="mt-1 text-xs text-slate-500 break-all font-mono">{[s.command, ...s.args].join(' ')}</div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ---- Skills ---- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-slate-100">Скиллы</h2>
          <div className="flex gap-2">
            <button onClick={() => void window.__DSH__.ext.openSkillsFolder()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-700 hover:bg-slate-800 text-slate-300">
              <FolderOpen className="w-3.5 h-3.5" /> Папка скиллов
            </button>
            <button onClick={() => void addSkillDir()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white">
              <Plus className="w-4 h-4" /> Добавить папку
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-500">SKILL.md-скиллы (совместимы с Claude Code и opencode): специальные инструкции для конкретных задач. Агент сам подгружает подходящий скилл через инструмент read_skill.</p>

        {skillDirs.length > 0 && (
          <div className="space-y-1">
            {skillDirs.map((dir) => (
              <div key={dir} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40 text-xs">
                <FileCode className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                <span className="truncate text-slate-300" title={dir}>{dir}</span>
                <button onClick={() => void removeSkillDir(dir)} aria-label="Удалить" className="ml-auto p-1 rounded text-slate-500 hover:bg-red-900/40 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1">
          {skills.map((s) => (
            <div key={s.dir + s.name} className="px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40">
              <div className="text-sm text-slate-200">{s.name}</div>
              <div className="text-xs text-slate-500">{s.description}</div>
            </div>
          ))}
          {skills.length === 0 && (
            <div className="p-4 rounded-xl border border-dashed border-slate-700 text-sm text-slate-500">
              Скиллов нет. Откройте папку скиллов и положите туда папку с SKILL.md (frontmatter с name и description) или одиночный файл-скилл.
            </div>
          )}
        </div>
      </section>

      <div className="flex justify-between items-center pt-2">
        <button onClick={() => void window.__DSH__.ext.openMcpConfig()} className="text-xs text-slate-500 hover:text-slate-300 underline">Открыть файл конфигурации расширений</button>
        <button onClick={onBack} className="px-4 py-2 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 text-slate-200">Назад к чату</button>
      </div>
    </div>
  )
}
