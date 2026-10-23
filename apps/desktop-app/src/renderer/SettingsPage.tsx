import { useEffect, useState } from 'react'
import { useDsh } from '@/context/DshContext'

type Settings = {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export default function SettingsPage({ onSave }: { onSave: () => void }) {
  const { settings, saveSettings } = useDsh()
  const [local, setLocal] = useState<Settings & { temperature: number; maxTokens: number }>({
    apiKey: settings.apiKey ?? '',
    baseUrl: settings.baseUrl ?? '',
    model: settings.model ?? '',
    temperature: settings.temperature ?? 0.7,
    maxTokens: settings.maxTokens ?? 4096,
  })

  useEffect(() => {
    setLocal({
      apiKey: settings.apiKey ?? '',
      baseUrl: settings.baseUrl ?? '',
      model: settings.model ?? '',
      temperature: settings.temperature ?? 0.7,
      maxTokens: settings.maxTokens ?? 4096,
    })
  }, [settings])

  async function handleSave() {
    await saveSettings({
      apiKey: local.apiKey || undefined,
      baseUrl: local.baseUrl || undefined,
      model: local.model || undefined,
      temperature: local.temperature,
      maxTokens: local.maxTokens,
    })
    onSave()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Настройки</h1>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">API-ключ DeepSeek</label>
          <input
            type="password"
            value={local.apiKey}
            onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
            placeholder="sk-..."
          />
          <p className="text-xs text-slate-500 mt-1">Получить ключ: <a href="https://platform.deepseek.com/apiKeys" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">platform.deepseek.com</a></p>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Базовый URL</label>
          <input
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Модель</label>
          <select
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="deepseek-chat">DeepSeek Chat (V3)</option>
            <option value="deepseek-reasoner">DeepSeek Reasoner (R1)</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Температура</label>
            <input
              type="range" min="0" max="2" step="0.1"
              value={local.temperature}
              onChange={(e) => setLocal({ ...local, temperature: parseFloat(e.target.value) })}
              className="w-full accent-indigo-600"
            />
            <span className="text-xs text-slate-500">{local.temperature}</span>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Макс. токенов</label>
            <input
              type="number" min="64" max="32768" step="64"
              value={local.maxTokens}
              onChange={(e) => setLocal({ ...local, maxTokens: parseInt(e.target.value) || 4096 })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>
      </div>
      <div className="pt-4 border-t border-slate-800">
        <button onClick={handleSave} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-2 rounded-lg font-medium">Сохранить</button>
      </div>
    </div>
  )
}
