import { useEffect, useState } from 'react'
import { ShieldAlert, Terminal, FileText, Globe, Server, Wrench, Loader2, Check, X, ChevronRight } from 'lucide-react'
import type { PermissionRequest, ToolStep } from '../../electron/preload'

const ICONS: Record<string, typeof Wrench> = {
  bash: Terminal, read_file: FileText, write_file: FileText, edit_file: FileText, list_dir: FileText, glob: FileText, grep: FileText,
  web_fetch: Globe, download_file: Globe, ssh_exec: Server, list_connections: Server,
}
const iconFor = (name: string) => ICONS[name] ?? (name.startsWith('sftp_') ? Server : Wrench)

/** Queue of approval requests coming from the main process; the oldest is shown first. */
export function PermissionDialog() {
  const [queue, setQueue] = useState<PermissionRequest[]>([])

  useEffect(() => window.__DSH__.agent.onPermission((request) => setQueue((prev) => [...prev, request])), [])

  const current = queue[0]
  if (!current) return null

  const answer = (value: 'once' | 'session' | 'deny') => {
    void window.__DSH__.agent.replyPermission(current.id, value)
    setQueue((prev) => prev.slice(1))
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Запрос разрешения" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-amber-700/50 bg-slate-900 shadow-2xl">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-800">
          <ShieldAlert className="w-5 h-5 text-amber-300" />
          <h2 className="font-semibold text-slate-100">Агент просит разрешение</h2>
          {queue.length > 1 && <span className="ml-auto text-xs text-slate-500">ещё {queue.length - 1} в очереди</span>}
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <div className="text-slate-100 break-words">{current.summary}</div>
          <div className="text-amber-200 text-xs">Причина запроса: {current.reason}</div>
          {current.details && (
            <pre className="max-h-48 overflow-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-300 whitespace-pre-wrap break-words">{current.details}</pre>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={() => answer('deny')} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800">Отклонить</button>
          <button onClick={() => answer('session')} className="px-4 py-2 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 text-slate-100">Разрешить на сессию</button>
          <button onClick={() => answer('once')} autoFocus className="px-4 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white">Разрешить один раз</button>
        </div>
      </div>
    </div>
  )
}

function StepCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor(step.name)
  const StatusIcon = step.status === 'running' ? Loader2 : step.status === 'error' ? X : Check
  const statusStyle = step.status === 'running' ? 'text-indigo-300 animate-spin' : step.status === 'error' ? 'text-red-400' : 'text-emerald-400'

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/60 text-xs">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <ChevronRight className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-slate-200">{step.summary}</span>
        <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${statusStyle}`} aria-label={step.status} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="text-slate-500">Вызов: <span className="text-slate-300">{step.name}</span></div>
          <pre className="max-h-40 overflow-auto rounded bg-slate-900 p-2 text-slate-300 whitespace-pre-wrap break-words">{JSON.stringify(step.arguments, null, 2)}</pre>
          {step.output !== undefined && (
            <pre className={`max-h-64 overflow-auto rounded bg-slate-900 p-2 whitespace-pre-wrap break-words ${step.status === 'error' ? 'text-red-300' : 'text-slate-300'}`}>{step.output || '(пустой вывод)'}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolSteps({ steps }: { steps?: ToolStep[] }) {
  if (!steps?.length) return null
  return <div className="mb-2 space-y-1.5">{steps.map((s) => <StepCard key={s.id} step={s} />)}</div>
}
