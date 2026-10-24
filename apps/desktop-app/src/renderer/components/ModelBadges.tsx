import { RUSSIAN_LABELS, STRENGTH_LABELS, TIER_LABELS, type ModelProfile, type RussianLevel } from '@/lib/modelProfile'
import type { Fit, FitLevel } from '@/lib/modelFit'

const RUSSIAN_STYLE: Record<RussianLevel, string> = {
  native: 'bg-emerald-900/40 border-emerald-600/50 text-emerald-200',
  good: 'bg-emerald-900/30 border-emerald-700/50 text-emerald-200',
  fair: 'bg-amber-900/30 border-amber-700/50 text-amber-200',
  weak: 'bg-orange-900/30 border-orange-700/50 text-orange-200',
  none: 'bg-red-900/30 border-red-700/50 text-red-200',
  unknown: 'bg-slate-800 border-slate-700 text-slate-300',
}

const FIT_STYLE: Record<FitLevel, string> = {
  gpu: 'bg-emerald-900/40 border-emerald-600/50 text-emerald-200',
  partial: 'bg-sky-900/30 border-sky-700/50 text-sky-200',
  cpu: 'bg-amber-900/30 border-amber-700/50 text-amber-200',
  tight: 'bg-orange-900/30 border-orange-700/50 text-orange-200',
  no: 'bg-red-900/30 border-red-700/50 text-red-200',
}

/** How well a model fits this machine: level, speed estimate and the reason. */
export function FitBadge({ fit, compact = false, note }: { fit: Fit; compact?: boolean; note?: string }) {
  return (
    <div className="space-y-0.5">
      <span title={fit.detail} className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${FIT_STYLE[fit.level]}`}>
        {fit.label}{note ? ` (${note})` : ''}
      </span>
      {!compact && <div className="text-xs text-slate-500">{fit.detail}</div>}
    </div>
  )
}

export function formatParameters(n?: number): string | null {
  if (!n) return null
  return n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} млрд` : `${Math.round(n / 1e6)} млн`
}

function formatContext(n?: number): string | null {
  if (!n) return null
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн токенов` : `${Math.round(n / 1024)}K токенов`
}

/** One-line summary: Russian quality, size and the main strengths. */
export function ModelBadges({ profile, max = 4 }: { profile?: ModelProfile; max?: number }) {
  if (!profile) return null
  const size = formatParameters(profile.parameters)
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span title={profile.russianNote} className={`px-1.5 py-0.5 rounded border ${RUSSIAN_STYLE[profile.russian]}`}>
        Русский: {RUSSIAN_LABELS[profile.russian]}
      </span>
      {size && <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300">{size}</span>}
      {profile.runtime === 'cloud' && <span className="px-1.5 py-0.5 rounded border border-indigo-700/50 bg-indigo-900/30 text-indigo-200">Облако</span>}
      {profile.strengths.slice(0, max).map((s) => (
        <span key={s} className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 text-slate-300">{STRENGTH_LABELS[s]}</span>
      ))}
    </div>
  )
}

/** Full description of the selected model. */
export function ModelProfileCard({ profile }: { profile?: ModelProfile }) {
  if (!profile) return null
  const rows: [string, string][] = []
  const size = formatParameters(profile.parameters)
  if (size) rows.push(['Размер', `${size} параметров${profile.tier ? ` · ${TIER_LABELS[profile.tier]}` : ''}`])
  const context = formatContext(profile.contextLength)
  if (context) rows.push(['Контекст', context])
  if (profile.memoryGb) rows.push(['Память (Q4)', `≈ ${profile.memoryGb} ГБ ОЗУ/видеопамяти`])
  if (profile.license) rows.push(['Лицензия', profile.license])
  if (profile.vendor) rows.push(['Разработчик', profile.vendor])
  if (profile.languages?.length) rows.push(['Языки в карточке', profile.languages.slice(0, 8).join(', ')])

  return (
    <div className="mt-2 p-3 rounded-lg border border-slate-800 bg-slate-900/60 space-y-2 text-xs text-slate-300">
      <ModelBadges profile={profile} max={10} />
      <div><span className="text-slate-500">Русский язык: </span>{profile.russianNote}</div>
      {profile.tierNote && <div><span className="text-slate-500">Уровень: </span>{profile.tierNote}</div>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-slate-500">{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
      <div className="text-[10px] text-slate-500">
        Оценка по семейству и метаданным модели, а не результат бенчмарка. Качество на ваших задачах лучше проверить самим.
      </div>
    </div>
  )
}
