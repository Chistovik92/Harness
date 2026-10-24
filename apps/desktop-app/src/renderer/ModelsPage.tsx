import { useEffect, useRef, useState } from 'react'
import { Download, Trash2, Search, Check, X } from 'lucide-react'
import type { HubModel, LocalModel } from '../electron/preload'

const MODEL_ID = /^[\w.-]+\/[\w.-]+$/

type FileProgress = { loaded: number; total: number }

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} ГБ`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${Math.round(n / 1024)} КБ`
}

function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export default function ModelsPage({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState('')
  const [manualId, setManualId] = useState('')
  const [results, setResults] = useState<HubModel[]>([])
  const [local, setLocal] = useState<LocalModel[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Record<string, Record<string, FileProgress>>>({})
  const downloadingRef = useRef(downloading)
  downloadingRef.current = downloading

  async function refreshLocal() {
    setLocal(await window.__DSH__.hf.listLocal())
  }

  async function search(text: string) {
    setSearching(true)
    setError(null)
    try {
      setResults(await window.__DSH__.hf.search(text))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    refreshLocal().catch((err) => setError(cleanError(err)))
    search('').catch(() => {})
    return window.__DSH__.hf.onProgress((p) => {
      if (p.status === 'progress' && p.file && p.total) {
        setDownloading((prev) => {
          if (!prev[p.modelId]) return prev
          return { ...prev, [p.modelId]: { ...prev[p.modelId], [p.file!]: { loaded: p.loaded ?? 0, total: p.total! } } }
        })
      }
    })
  }, [])

  async function download(modelId: string) {
    if (!MODEL_ID.test(modelId)) { setError('Укажите id в формате организация/модель, например HuggingFaceTB/SmolLM2-135M-Instruct'); return }
    if (downloadingRef.current[modelId]) return
    setError(null)
    setDownloading((prev) => ({ ...prev, [modelId]: {} }))
    try {
      await window.__DSH__.hf.download(modelId)
      await refreshLocal()
    } catch (err) {
      setError(`${modelId}: ${cleanError(err)}`)
    } finally {
      setDownloading((prev) => {
        const { [modelId]: _done, ...rest } = prev
        return rest
      })
    }
  }

  async function remove(modelId: string) {
    if (!confirm(`Удалить модель ${modelId} с диска?`)) return
    try {
      await window.__DSH__.hf.remove(modelId)
      await refreshLocal()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  function progressOf(modelId: string): { percent: number; label: string } | null {
    const files = downloading[modelId]
    if (!files) return null
    const parts = Object.values(files)
    const total = parts.reduce((s, f) => s + f.total, 0)
    const loaded = parts.reduce((s, f) => s + f.loaded, 0)
    return total > 0 ? { percent: Math.min(100, Math.round((loaded / total) * 100)), label: `${formatBytes(loaded)} / ${formatBytes(total)}` } : { percent: 0, label: 'подготовка…' }
  }

  const downloaded = new Set(local.map((m) => m.id))

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Локальные модели Hugging Face</h1>
        <button onClick={onBack} className="px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Назад к чату</button>
      </div>

      <p className="text-sm text-slate-500">
        Модели скачиваются на компьютер и работают офлайн, без API-ключа. Запускаются модели в формате ONNX (тег transformers.js) —
        поиск показывает только такие. Выберите провайдера «Hugging Face (Локально)», чтобы общаться со скачанной моделью.
      </p>

      {error && <div className="p-3 rounded border border-red-700/50 bg-red-900/20 text-red-200 text-sm">{error}</div>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Скачано ({local.length})</h2>
        {local.length === 0 && <div className="text-xs text-slate-500">Пока ничего не скачано</div>}
        {local.map((m) => (
          <div key={m.id} className="flex items-center gap-3 border border-slate-800 rounded-lg px-4 py-3 bg-slate-900/50">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-100 truncate">{m.id}</div>
              <div className="text-xs text-slate-500">{formatBytes(m.sizeBytes)}</div>
            </div>
            <button onClick={() => remove(m.id)} aria-label={`Удалить ${m.id}`} className="p-1.5 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Скачать любую модель по id</h2>
        <div className="flex gap-2">
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') void download(manualId) }}
            placeholder="onnx-community/Qwen2.5-0.5B-Instruct"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button onClick={() => download(manualId)} disabled={!manualId || Boolean(downloading[manualId])} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm">
            <Download className="w-4 h-4" /> Скачать
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Поиск на Hugging Face</h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(query) }}
            placeholder="qwen, llama, smollm, phi…"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button onClick={() => search(query)} disabled={searching} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-sm">
            <Search className="w-4 h-4" /> {searching ? 'Поиск…' : 'Найти'}
          </button>
        </div>

        {results.map((m) => {
          const progress = progressOf(m.id)
          return (
            <div key={m.id} className="border border-slate-800 rounded-lg px-4 py-3 bg-slate-900/50 space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-100 truncate">{m.id}</div>
                  <div className="text-xs text-slate-500">{m.downloads.toLocaleString('ru-RU')} загрузок · {m.likes} ♥</div>
                </div>
                {downloaded.has(m.id) ? (
                  <span className="text-xs text-emerald-300">Скачано</span>
                ) : progress ? (
                  <button onClick={() => window.__DSH__.hf.cancelDownload(m.id)} aria-label="Отменить" className="p-1.5 text-slate-400 hover:text-red-400"><X className="w-4 h-4" /></button>
                ) : (
                  <button onClick={() => download(m.id)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs"><Download className="w-3.5 h-3.5" /> Скачать</button>
                )}
              </div>
              {progress && (
                <div>
                  <div className="h-1.5 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${progress.percent}%` }} /></div>
                  <div className="mt-1 text-xs text-slate-500">{progress.percent}% · {progress.label}</div>
                </div>
              )}
            </div>
          )
        })}
        {!searching && results.length === 0 && <div className="text-xs text-slate-500">Ничего не найдено</div>}
      </section>
    </div>
  )
}
