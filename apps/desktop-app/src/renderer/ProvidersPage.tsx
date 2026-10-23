import { useState, useEffect } from 'react'
import { Trash2, Plus, Key, Check } from 'lucide-react'
import type { ProviderConfig } from '../electron/preload'

export const DEFAULT_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022' },
  { id: 'google', name: 'Google Gemini', kind: 'google', defaultModel: 'gemini-1.5-flash' },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-70b-versatile' },
  { id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat' },
  { id: 'huggingface-api', name: 'Hugging Face (API)', kind: 'huggingface-api', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct' },
  { id: 'huggingface-local', name: 'Hugging Face (Локально)', kind: 'huggingface-local', local: true, defaultModel: 'Xenova/llama2.c-stories15M' },
]

/** Saved providers on top of the built-in ones, so every known provider is selectable. */
export function mergeProviders(saved: ProviderConfig[]): ProviderConfig[] {
  const byId = new Map(saved.map((p) => [p.id, p]))
  const defaults = DEFAULT_PROVIDERS.map((d) => ({ enabled: true, ...d, ...byId.get(d.id) }))
  const custom = saved.filter((p) => !DEFAULT_PROVIDERS.some((d) => d.id === p.id))
  return [...defaults, ...custom] as ProviderConfig[]
}

export default function ProvidersPage({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderConfig>({ id: '', name: '', kind: 'openai-compatible', enabled: true })

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setProviders(mergeProviders(await window.__DSH__.providers.list()))
  }

  const [error, setError] = useState<string | null>(null)

  async function saveProvider(p: ProviderConfig) {
    try {
      await window.__DSH__.providers.set(p)
      setError(null)
      await load()
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  async function removeProvider(id: string) {
    if (!confirm('Удалить провайдера?')) return
    await window.__DSH__.providers.remove(id).catch((err) => setError(String(err)))
    await load()
  }

  function startAdd() {
    setForm({ id: '', name: '', kind: 'openai-compatible', baseUrl: '', defaultModel: '', enabled: true })
    setEditing('new')
  }

  function startEdit(p: ProviderConfig) {
    setForm({ ...p, enabled: p.enabled !== false })
    setEditing(p.id)
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Провайдеры и ключи API</h1>
        <button onClick={onBack} className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">
          <Plus className="w-4 h-4" /> Назад к чату
        </button>
      </div>

      <p className="text-sm text-slate-500">Ключи хранятся локально на вашем компьютере (зашифровано) и не уходят в сеть, за исключением прямых запросов к выбранному провайдеру.</p>

      <div className="space-y-3">
        {providers.map((p) => (
          <div key={p.id} className="border border-slate-800 rounded-lg p-4 bg-slate-900/50 flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">
                {p.kind === 'huggingface-local' ? 'L' : p.kind === 'huggingface-api' ? 'H' : p.name[0]}
              </div>
              <div>
                <div className="font-medium text-slate-100">{p.name}</div>
                <div className="text-xs text-slate-500">{p.kind}{p.local ? ' · локальная модель' : ''}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {p.apiKey ? (
                <span className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-200 text-xs">
                  <Check className="w-3 h-3" /> Ключ сохранён
                </span>
              ) : p.requiresKey === false || p.local ? (
                <span className="px-2 py-1 rounded bg-slate-800 text-slate-400 text-xs">Ключ не требуется</span>
              ) : (
                <span className="px-2 py-1 rounded bg-amber-900/30 border border-amber-700/50 text-amber-200 text-xs">Нужен ключ</span>
              )}
              <button onClick={() => startEdit(p)} className="p-1.5 text-slate-400 hover:text-white">
                <Key className="w-4 h-4" />
              </button>
              {!DEFAULT_PROVIDERS.some((d) => d.id === p.id) && (
                <button onClick={() => removeProvider(p.id)} className="p-1.5 text-slate-500 hover:text-red-400">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="p-3 rounded border border-red-700/50 bg-red-900/20 text-red-200 text-sm">{error}</div>}

      {editing && (
        <div className="border border-slate-800 rounded-lg p-6 bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">{editing === 'new' ? 'Добавить провайдера' : 'Редактировать'}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Имя</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Тип</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500">
                <option value="openai-compatible">OpenAI-совместимый</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="huggingface-api">Hugging Face API</option>
                <option value="huggingface-local">Hugging Face локально</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Base URL</label>
              <input value={form.baseUrl ?? ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">API-ключ</label>
              <input type="password" value={form.apiKey ?? ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Модель по умолчанию</label>
              <input value={form.defaultModel ?? ''} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} placeholder="deepseek-chat" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="flex items-center">
              <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="w-4 h-4 rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-indigo-500" />
              <label className="ml-2 text-sm text-slate-300">Включён</label>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => { setEditing(null) }} className="px-4 py-2 text-slate-400 hover:text-white">Отмена</button>
            <button onClick={() => saveProvider({ ...form, id: form.id || (providers.find((p) => p.name === form.name)?.id || crypto.randomUUID()) })} className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium">Сохранить</button>
          </div>
        </div>
      )}
    </div>
  )
}
