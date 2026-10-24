import { useEffect, useRef, useState } from 'react'
import { Download, Trash2, Search, Check, X, LogIn, LogOut, Lock, ChevronDown } from 'lucide-react'
import type { AuthStatus, GgufFile, HubModel, LocalModel } from '../electron/preload'
import { ModelBadges } from '@/components/ModelBadges'

type Format = 'gguf' | 'onnx'
type FileProgress = { loaded: number; total: number }

const REPO_ID = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/
const RECOMMENDED_QUANTS = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q5_K_M']

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} ГБ`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${Math.round(n / 1024)} КБ`
}

function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const ggufModelId = (repo: string, file: string) => `gguf:${repo}/${file}`

export default function ModelsPage({ onBack }: { onBack: () => void }) {
  const [format, setFormat] = useState<Format>('gguf')
  const [query, setQuery] = useState('')
  const [manualId, setManualId] = useState('')
  const [results, setResults] = useState<HubModel[]>([])
  const [local, setLocal] = useState<LocalModel[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthStatus>({ loggedIn: false })
  const [signingIn, setSigningIn] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, GgufFile[] | 'loading'>>({})
  const [downloading, setDownloading] = useState<Record<string, Record<string, FileProgress>>>({})
  const downloadingRef = useRef(downloading)
  downloadingRef.current = downloading

  const refreshLocal = async () => setLocal(await window.__DSH__.hf.listLocal())

  async function search(text: string, fmt: Format) {
    setSearching(true)
    setError(null)
    try {
      setResults(await window.__DSH__.hf.search(fmt, text))
    } catch (err) {
      setResults([])
      setError(cleanError(err))
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    refreshLocal().catch((err) => setError(cleanError(err)))
    window.__DSH__.hf.authStatus().then(setAuth).catch(() => {})
    return window.__DSH__.hf.onProgress((p) => {
      if (p.status === 'progress' && p.file && p.total) {
        setDownloading((prev) => {
          if (!prev[p.modelId]) return prev
          return { ...prev, [p.modelId]: { ...prev[p.modelId], [p.file!]: { loaded: p.loaded ?? 0, total: p.total! } } }
        })
      }
    })
  }, [])

  useEffect(() => {
    setExpanded(null)
    search(query, format).catch(() => {})
    // Re-run only when the tab changes; typing triggers search explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format])

  async function signIn() {
    setSigningIn(true)
    setError(null)
    try {
      setAuth(await window.__DSH__.hf.login())
      search(query, format).catch(() => {})
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setSigningIn(false)
    }
  }

  async function signOut() {
    await window.__DSH__.hf.logout()
    setAuth({ loggedIn: false })
  }

  async function run(modelId: string, action: () => Promise<void>) {
    if (downloadingRef.current[modelId]) return
    setError(null)
    setDownloading((prev) => ({ ...prev, [modelId]: {} }))
    try {
      await action()
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

  const downloadOnnx = (id: string) => {
    if (!REPO_ID.test(id)) { setError('Укажите id в формате организация/модель, например HuggingFaceTB/SmolLM2-135M-Instruct'); return }
    void run(id, () => window.__DSH__.hf.download(id))
  }

  const downloadGguf = (repo: string, file: GgufFile) =>
    run(ggufModelId(repo, file.file), () => window.__DSH__.hf.downloadGguf(repo, file.file, file.parts))

  async function toggleFiles(repo: string) {
    if (expanded === repo) { setExpanded(null); return }
    setExpanded(repo)
    if (files[repo] && files[repo] !== 'loading') return
    setFiles((prev) => ({ ...prev, [repo]: 'loading' }))
    try {
      const list = await window.__DSH__.hf.ggufFiles(repo)
      setFiles((prev) => ({ ...prev, [repo]: list }))
    } catch (err) {
      setFiles((prev) => { const { [repo]: _x, ...rest } = prev; return rest })
      setError(`${repo}: ${cleanError(err)}`)
      setExpanded(null)
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
    const parts = downloading[modelId]
    if (!parts) return null
    const values = Object.values(parts)
    const total = values.reduce((s, f) => s + f.total, 0)
    const loaded = values.reduce((s, f) => s + f.loaded, 0)
    return total > 0 ? { percent: Math.min(100, Math.round((loaded / total) * 100)), label: `${formatBytes(loaded)} / ${formatBytes(total)}` } : { percent: 0, label: 'подготовка…' }
  }

  const downloaded = new Set(local.map((m) => m.id))
  const recommended = (list: GgufFile[]) => RECOMMENDED_QUANTS.map((q) => list.find((f) => f.quant === q)).find(Boolean)

  function ProgressBar({ id }: { id: string }) {
    const progress = progressOf(id)
    if (!progress) return null
    return (
      <div>
        <div className="h-1.5 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${progress.percent}%` }} /></div>
        <div className="mt-1 text-xs text-slate-500">{progress.percent}% · {progress.label}</div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Локальные модели Hugging Face</h1>
        <button onClick={onBack} className="px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Назад к чату</button>
      </div>

      <p className="text-sm text-slate-500">
        Модели скачиваются на компьютер и работают офлайн, без API-ключа. <b className="text-slate-300">GGUF</b> — основной формат (тысячи моделей, поддержка агента с инструментами);
        <b className="text-slate-300"> ONNX</b> — запасной, для небольших моделей. Затем выберите провайдера «Hugging Face (Локально)».
      </p>

      {error && <div className="p-3 rounded border border-red-700/50 bg-red-900/20 text-red-200 text-sm">{error}</div>}

      <section className="border border-slate-800 rounded-lg p-4 bg-slate-900/50 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          {auth.loggedIn ? (
            <>
              <div className="text-sm text-slate-100 flex items-center gap-2">
                {auth.user?.avatar && <img src={auth.user.avatar} alt="" className="w-5 h-5 rounded-full" />}
                Вы вошли как <b>{auth.user?.name ?? 'Hugging Face'}</b>
              </div>
              <div className="text-xs text-slate-500">Доступны закрытые модели, принятые вами условия (Llama, Gemma…) и облачные модели Hugging Face без API-ключа.</div>
            </>
          ) : (
            <>
              <div className="text-sm text-slate-100">Вход в аккаунт Hugging Face</div>
              <div className="text-xs text-slate-500">Нужен для закрытых моделей (Llama, Gemma и др.) и для облачных моделей Hugging Face без API-ключа. Откроется браузер; пароль приложение не видит.</div>
            </>
          )}
        </div>
        {auth.loggedIn ? (
          <button onClick={signOut} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm"><LogOut className="w-4 h-4" /> Выйти</button>
        ) : (
          <button onClick={signIn} disabled={signingIn} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm"><LogIn className="w-4 h-4" /> {signingIn ? 'Ожидание входа в браузере…' : 'Войти через Hugging Face'}</button>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Скачано ({local.length})</h2>
        {local.length === 0 && <div className="text-xs text-slate-500">Пока ничего не скачано</div>}
        {local.map((m) => (
          <div key={m.id} className="border border-slate-800 rounded-lg px-4 py-3 bg-slate-900/50 space-y-2">
            <div className="flex items-center gap-3">
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-100 truncate">{m.name}</div>
                <div className="text-xs text-slate-500">{m.format.toUpperCase()} · {formatBytes(m.sizeBytes)}</div>
              </div>
              <button onClick={() => remove(m.id)} aria-label={`Удалить ${m.name}`} className="p-1.5 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
            </div>
            <ModelBadges profile={m.profile} />
          </div>
        ))}
      </section>

      <div className="flex gap-2 border-b border-slate-800">
        {(['gguf', 'onnx'] as Format[]).map((f) => (
          <button key={f} onClick={() => setFormat(f)} className={`px-4 py-2 text-sm border-b-2 -mb-px ${format === f ? 'border-indigo-500 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {f === 'gguf' ? 'GGUF (рекомендуется)' : 'ONNX'}
          </button>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Скачать любую модель по id</h2>
        <div className="flex gap-2">
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') { if (format === 'onnx') downloadOnnx(manualId); else if (REPO_ID.test(manualId)) void toggleFiles(manualId) } }}
            placeholder={format === 'gguf' ? 'Qwen/Qwen2.5-7B-Instruct-GGUF' : 'onnx-community/Qwen2.5-0.5B-Instruct'}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={() => (format === 'onnx' ? downloadOnnx(manualId) : void toggleFiles(manualId))}
            disabled={!REPO_ID.test(manualId) || Boolean(downloading[manualId])}
            className="flex items-center gap-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm"
          >
            <Download className="w-4 h-4" /> {format === 'gguf' ? 'Показать файлы' : 'Скачать'}
          </button>
        </div>
        {format === 'gguf' && expanded && expanded === manualId && <GgufFiles repo={manualId} />}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Поиск на Hugging Face</h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(query, format) }}
            placeholder="qwen, llama, gemma, mistral, coder…"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button onClick={() => search(query, format)} disabled={searching} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-sm">
            <Search className="w-4 h-4" /> {searching ? 'Поиск…' : 'Найти'}
          </button>
        </div>

        {results.map((m) => (
          <div key={m.id} className="border border-slate-800 rounded-lg px-4 py-3 bg-slate-900/50 space-y-2">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-100 truncate flex items-center gap-1.5">
                  {m.gated && <Lock className="w-3 h-3 text-amber-300 shrink-0" aria-label="Закрытая модель: нужен вход и принятие условий" />}
                  {m.id}
                </div>
                <div className="text-xs text-slate-500">{m.downloads.toLocaleString('ru-RU')} загрузок · {m.likes} ♥</div>
              </div>
              {format === 'gguf' ? (
                <button onClick={() => toggleFiles(m.id)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs">
                  Выбрать файл <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded === m.id ? 'rotate-180' : ''}`} />
                </button>
              ) : downloaded.has(m.id) ? (
                <span className="text-xs text-emerald-300">Скачано</span>
              ) : downloading[m.id] ? (
                <button onClick={() => window.__DSH__.hf.cancelDownload(m.id)} aria-label="Отменить" className="p-1.5 text-slate-400 hover:text-red-400"><X className="w-4 h-4" /></button>
              ) : (
                <button onClick={() => downloadOnnx(m.id)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs"><Download className="w-3.5 h-3.5" /> Скачать</button>
              )}
            </div>
            <ModelBadges profile={m.profile} />
            {m.profile && <div className="text-xs text-slate-500">{m.profile.russianNote}</div>}
            {format === 'onnx' && <ProgressBar id={m.id} />}
            {format === 'gguf' && expanded === m.id && <GgufFiles repo={m.id} />}
          </div>
        ))}
        {!searching && results.length === 0 && <div className="text-xs text-slate-500">Ничего не найдено</div>}
      </section>
    </div>
  )

  function GgufFiles({ repo }: { repo: string }) {
    const list = files[repo]
    if (!list || list === 'loading') return <div className="text-xs text-slate-500">Загрузка списка файлов…</div>
    if (list.length === 0) return <div className="text-xs text-slate-500">В репозитории нет GGUF-файлов</div>
    const best = recommended(list)
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Чем больше число в Q, тем выше качество и размер. Q4_K_M — хороший баланс.</div>
        {list.map((f) => {
          const id = ggufModelId(repo, f.file)
          const isDone = downloaded.has(id)
          const inProgress = Boolean(downloading[id])
          return (
            <div key={f.file} className="rounded border border-slate-800 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-200 truncate">{f.file}{f.parts.length > 1 ? ` (${f.parts.length} частей)` : ''}</div>
                  <div className="text-xs text-slate-500">{f.quant} · {formatBytes(f.size)}{best === f ? ' · рекомендуется' : ''}</div>
                </div>
                {isDone ? <span className="text-xs text-emerald-300">Скачано</span>
                  : inProgress ? <button onClick={() => window.__DSH__.hf.cancelDownload(id)} aria-label="Отменить" className="p-1 text-slate-400 hover:text-red-400"><X className="w-4 h-4" /></button>
                  : <button onClick={() => downloadGguf(repo, f)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs"><Download className="w-3.5 h-3.5" /> Скачать</button>}
              </div>
              <ProgressBar id={id} />
            </div>
          )
        })}
      </div>
    )
  }
}
