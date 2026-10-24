import type { ToolDef } from '../../renderer/lib/providers'
import type { Assessment, PermissionGate } from './permissions'
import type { RemoteManager } from './remote'

export type ToolArgs = Record<string, unknown>

/** What a tool may touch while running; built per agent run. */
export type ToolContext = {
  workspace: string | null
  gate: PermissionGate
  signal: AbortSignal
  remote: RemoteManager
}

export type ToolSpec = {
  def: ToolDef
  /** One line shown in the permission dialog and the tool card. */
  summarize: (args: ToolArgs) => string
  /** Decides whether the call may run unattended in `workspace-auto` mode. */
  assess: (args: ToolArgs, ctx: ToolContext) => Promise<Assessment> | Assessment
  run: (args: ToolArgs, ctx: ToolContext) => Promise<string>
}

export type ToolResult = { output: string; isError: boolean }

export class ToolError extends Error {}

export function stringArg(args: ToolArgs, key: string, required = true): string {
  const value = args[key]
  if (typeof value === 'string' && (value.length > 0 || !required)) return value
  if (value === undefined && !required) return ''
  throw new ToolError(`Аргумент "${key}" обязателен и должен быть строкой`)
}

export function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function numberArg(args: ToolArgs, key: string, fallback: number, min: number, max: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
}
