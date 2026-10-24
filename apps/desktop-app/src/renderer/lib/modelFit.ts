/**
 * Will a model run on this machine, and how fast? A rough estimate from the
 * weight size and the free memory: token generation is memory-bandwidth bound,
 * so speed is approximated as bandwidth / weights. Real speed varies with the
 * GPU/driver and model architecture (mixture-of-experts models are faster than
 * their size suggests), so the UI presents these as estimates.
 */

export type SystemInfo = {
  backend: string
  gpuName: string | null
  vramTotal: number
  vramFree: number
  totalRam: number
  freeRam: number
  cpuCores: number
  cpuModel: string
}

export type FitLevel = 'gpu' | 'partial' | 'cpu' | 'tight' | 'no'

export type Fit = {
  level: FitLevel
  label: string
  detail: string
  /** Rough generation speed range in tokens per second. */
  tokensPerSecond?: [number, number]
}

const GB = 1024 ** 3
/** Weights are mapped with overhead; the KV cache and compute buffers need extra room. */
const OVERHEAD_FACTOR = 1.08
const OVERHEAD_BYTES = 0.7 * GB
/** Effective bandwidths (GB/s) of a mid-range GPU and dual-channel desktop RAM. */
const GPU_BANDWIDTH = 200
const CPU_BANDWIDTH = 25
const MAX_TPS = 120

export const FIT_RANK: Record<FitLevel, number> = { gpu: 4, partial: 3, cpu: 2, tight: 1, no: 0 }

/** Usable video memory: unified-memory machines (Metal) share system RAM. */
function gpuBudget(system: SystemInfo): number {
  if (system.backend === 'cpu' || system.vramTotal <= 0) return 0
  if (system.backend === 'metal') return Math.min(system.vramFree || system.totalRam * 0.66, system.freeRam * 0.8)
  return system.vramFree * 0.92
}

const speed = (weightsGb: number, bandwidth: number) => Math.min(MAX_TPS, bandwidth / Math.max(weightsGb, 0.1))

function range(tps: number): [number, number] {
  const lo = Math.max(0.3, Math.round(tps * 0.6 * 10) / 10)
  const hi = Math.max(lo, Math.round(tps * 1.3 * 10) / 10)
  return [lo, hi]
}

export function formatTps([lo, hi]: [number, number]): string {
  const fmt = (n: number) => (n >= 10 ? String(Math.round(n)) : String(n).replace('.', ','))
  return `≈ ${fmt(lo)}–${fmt(hi)} ток/с`
}

export function estimateFit(weightsBytes: number, system: SystemInfo): Fit {
  const need = weightsBytes * OVERHEAD_FACTOR + OVERHEAD_BYTES
  const gpu = gpuBudget(system)
  const ram = system.freeRam * 0.85
  const weightsGb = weightsBytes / GB

  if (gpu > 0 && need <= gpu) {
    const tps = range(speed(weightsGb, GPU_BANDWIDTH))
    return { level: 'gpu', label: 'Быстро: целиком на видеокарте', detail: `Помещается в видеопамять. ${formatTps(tps)} (оценка).`, tokensPerSecond: tps }
  }
  if (gpu >= 1.5 * GB && need <= gpu + ram) {
    const onGpu = Math.min(1, gpu / need)
    const seconds = onGpu * weightsGb / GPU_BANDWIDTH + (1 - onGpu) * weightsGb / CPU_BANDWIDTH
    const tps = range(1 / seconds)
    return { level: 'partial', label: 'Средне: частично на видеокарте', detail: `Часть слоёв на GPU, остальное в ОЗУ (если загрузка с GPU не удастся, модель пойдёт на процессоре). ${formatTps(tps)} (оценка).`, tokensPerSecond: tps }
  }
  if (need <= ram) {
    const tps = range(speed(weightsGb, CPU_BANDWIDTH))
    return { level: 'cpu', label: 'Медленно: на процессоре', detail: `Помещается в оперативную память, но без ускорения видеокартой. ${formatTps(tps)} (оценка).`, tokensPerSecond: tps }
  }
  if (need <= system.totalRam * 0.85) {
    return { level: 'tight', label: 'Впритык: закройте другие программы', detail: `Свободной ОЗУ сейчас мало (${(system.freeRam / GB).toFixed(1)} ГБ): модель будет подгружаться с диска и может работать очень медленно.` }
  }
  return { level: 'no', label: 'Не поместится', detail: `Нужно около ${(need / GB).toFixed(1)} ГБ, а у системы ${(system.totalRam / GB).toFixed(0)} ГБ ОЗУ и ${(system.vramTotal / GB).toFixed(0)} ГБ видеопамяти.` }
}

/** Weight size of a ~4-bit build, for repositories where no concrete file is chosen yet. */
export const q4WeightsBytes = (parameters: number): number => parameters * 0.6

export function describeSystem(system: SystemInfo): string {
  const gb = (n: number) => `${(n / GB).toFixed(1).replace('.', ',')} ГБ`
  const gpu = system.gpuName && system.vramTotal > 0
    ? `${system.gpuName}, видеопамять ${gb(system.vramTotal)} (свободно ${gb(system.vramFree)}), ${system.backend}`
    : 'видеокарта для ускорения не найдена'
  return `${gpu} · ОЗУ ${gb(system.totalRam)} (свободно ${gb(system.freeRam)}) · процессор: ${system.cpuModel || 'неизвестен'}, потоков ${system.cpuCores}`
}
