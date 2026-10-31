import { useEffect, useState } from 'react'
import { Key } from 'lucide-react'
import { useDsh } from '@/context/DshContext'

type Settings = {
  temperature?: number
  maxTokens?: number
  theme?: 'light' | 'dark'
  fontSize?: number
}

export default function SettingsPage({ onSave, onOpenProviders }: { onSave: () => void; onOpenProviders: () => void }) {
  const { settings, saveSettings } = useDsh()
  const [local, setLocal] = useState<Required<Settings>>({
    temperature: settings.temperature ?? 0.7,
    maxTokens: settings.maxTokens ?? 4096,
    theme: settings.theme ?? 'dark',
    fontSize: settings.fontSize ?? 14,
  })

  useEffect(() => {
    setLocal({
      temperature: settings.temperature ?? 0.7,
      maxTokens: settings.maxTokens ?? 4096,
      theme: settings.theme ?? 'dark',
      fontSize: settings.fontSize ?? 14,
    })
  }, [settings])

  async function handleSave() {
    await saveSettings(local)
    onSave()
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-semibold">Настройки</h1>

      <div className="p-4 rounded-lg border border-indigo-700/50 bg-indigo-900/20 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-indigo-100"><Key className="w-4 h-4" /> Провайдеры и API-ключи</div>
        <p className="text-xs text-slate-300">
          DeepSeek, OpenAI, Anthropic (Claude), Google (Gemini), Groq, Together, OpenRouter, Hugging Face и любые
          OpenAI-совместимые API настраиваются в разделе «Провайдеры API» — там же вводятся ключи.
        </p>
        <button onClick={onOpenProviders} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium">
          Открыть «Провайдеры API»
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Температура (0 — точно, 2 — креативно)</label>
            <input
              type="range" min="0" max="2" step="0.1"
              value={local.temperature}
              onChange={(e) => setLocal({ ...local, temperature: parseFloat(e.target.value) })}
              className="w-full accent-indigo-600"
            />
            <span className="text-xs text-slate-500">{local.temperature}</span>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Макс. токенов ответа</label>
            <input
              type="number" min="64" max="131072" step="64"
              value={local.maxTokens}
              onChange={(e) => setLocal({ ...local, maxTokens: parseInt(e.target.value) || 4096 })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Тема</label>
            <select
              value={local.theme}
              onChange={(e) => setLocal({ ...local, theme: e.target.value as 'light' | 'dark' })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
            >
              <option value="dark">Тёмная</option>
              <option value="light">Светлая</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Размер шрифта</label>
            <input
              type="number" min="8" max="32" step="1"
              value={local.fontSize}
              onChange={(e) => setLocal({ ...local, fontSize: parseInt(e.target.value) || 14 })}
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
