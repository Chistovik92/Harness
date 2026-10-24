import { useEffect, useState } from 'react'
import { Server, Trash2, Plug, Plus, Pencil } from 'lucide-react'
import type { SshConnectionInfo, SshConnectionInput } from '../electron/preload'

const EMPTY: SshConnectionInput = { name: '', host: '', port: 22, username: '', authType: 'key', privateKeyPath: '' }
const input = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500'

function cleanError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export default function ConnectionsPage({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<SshConnectionInfo[]>([])
  const [form, setForm] = useState<SshConnectionInput | null>(null)
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<Record<string, { ok: boolean; message: string } | 'testing'>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => setList(await window.__DSH__.ssh.list())

  useEffect(() => { refresh().catch((err) => setError(cleanError(err))) }, [])

  async function save() {
    if (!form) return
    try {
      await window.__DSH__.ssh.set({ ...form, port: Number(form.port) || 22 })
      setForm(null)
      setError(null)
      await refresh()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  async function test(name: string) {
    setStatus((prev) => ({ ...prev, [name]: 'testing' }))
    const result = await window.__DSH__.ssh.test(name)
    setStatus((prev) => ({ ...prev, [name]: result }))
    refresh().catch(() => {})
  }

  async function remove(name: string) {
    if (!confirm(`Удалить подключение «${name}»?`)) return
    await window.__DSH__.ssh.remove(name)
    await refresh()
  }

  const edit = (c: SshConnectionInfo) => {
    setEditing(true)
    setForm({ name: c.name, host: c.host, port: c.port, username: c.username, authType: c.authType, privateKeyPath: c.privateKeyPath ?? '' })
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">SSH / SFTP подключения</h1>
        <button onClick={onBack} className="px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Назад к чату</button>
      </div>
      <p className="text-sm text-slate-500">
        Агент может работать с файлами и командами на удалённых серверах по имени подключения. Пароли и ключи хранятся зашифрованно и моделям не показываются;
        каждое обращение к серверу требует вашего разрешения. Отпечаток ключа сервера запоминается при первом входе, при смене подключение блокируется.
        Сетевые диски (<code>\\сервер\папка</code>) доступны как обычные пути, без настройки.
      </p>

      {error && <div className="p-3 rounded border border-red-700/50 bg-red-900/20 text-red-200 text-sm">{error}</div>}

      <div className="space-y-3">
        {list.length === 0 && <div className="text-xs text-slate-500">Подключений пока нет</div>}
        {list.map((c) => {
          const state = status[c.name]
          return (
            <div key={c.name} className="border border-slate-800 rounded-lg px-4 py-3 bg-slate-900/50 space-y-2">
              <div className="flex items-center gap-3">
                <Server className="w-4 h-4 text-indigo-300 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-100">{c.name}</div>
                  <div className="text-xs text-slate-500">{c.username}@{c.host}:{c.port} · {c.authType === 'key' ? 'ключ' : c.authType === 'agent' ? 'ssh-agent' : 'пароль'}{c.hostKey ? ' · ключ хоста закреплён' : ''}</div>
                </div>
                <button onClick={() => test(c.name)} disabled={state === 'testing'} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs disabled:opacity-60"><Plug className="w-3.5 h-3.5" /> Проверить</button>
                <button onClick={() => edit(c)} aria-label={`Изменить ${c.name}`} className="p-1.5 text-slate-400 hover:text-white"><Pencil className="w-4 h-4" /></button>
                <button onClick={() => remove(c.name)} aria-label={`Удалить ${c.name}`} className="p-1.5 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
              </div>
              {state && state !== 'testing' && <div className={`text-xs ${state.ok ? 'text-emerald-300' : 'text-red-300'}`}>{state.message}</div>}
              {state === 'testing' && <div className="text-xs text-slate-500">Подключение…</div>}
            </div>
          )
        })}
      </div>

      {!form && (
        <button onClick={() => { setEditing(false); setForm({ ...EMPTY }) }} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm"><Plus className="w-4 h-4" /> Добавить подключение</button>
      )}

      {form && (
        <div className="border border-slate-800 rounded-lg p-5 bg-slate-900 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">{editing ? 'Изменить подключение' : 'Новое подключение'}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-xs text-slate-400">Имя (латиницей)
              <input className={input} value={form.name} disabled={editing} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="prod" />
            </label>
            <label className="text-xs text-slate-400">Хост
              <input className={input} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="example.com" />
            </label>
            <label className="text-xs text-slate-400">Порт
              <input className={input} type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
            </label>
            <label className="text-xs text-slate-400">Пользователь
              <input className={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="root" />
            </label>
            <label className="text-xs text-slate-400">Способ входа
              <select className={input} value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as SshConnectionInput['authType'] })}>
                <option value="key">Файл ключа</option>
                <option value="password">Пароль</option>
                <option value="agent">ssh-agent</option>
              </select>
            </label>
            {form.authType === 'password' && (
              <label className="text-xs text-slate-400">Пароль {editing && <span className="text-slate-600">(пусто — оставить прежний)</span>}
                <input className={input} type="password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" />
              </label>
            )}
            {form.authType === 'key' && (
              <>
                <label className="text-xs text-slate-400">Путь к приватному ключу
                  <input className={input} value={form.privateKeyPath ?? ''} onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })} placeholder="C:\Users\me\.ssh\id_ed25519" />
                </label>
                <label className="text-xs text-slate-400">Пароль ключа {editing && <span className="text-slate-600">(пусто — оставить прежний)</span>}
                  <input className={input} type="password" value={form.passphrase ?? ''} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} autoComplete="off" />
                </label>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setForm(null)} className="px-4 py-2 text-slate-400 hover:text-white">Отмена</button>
            <button onClick={save} className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium">Сохранить</button>
          </div>
        </div>
      )}
    </div>
  )
}
