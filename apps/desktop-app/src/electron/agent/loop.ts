/**
 * Agent loop: tool registry, guarded tool execution and the model↔tools cycle
 * for providers that return tool calls (OpenAI-compatible, Anthropic, Google).
 * Local GGUF models run the same tools through their own worker (see gguf.ts).
 */

import os from 'node:os'
import type { LLMProvider, ProviderConfig, Message, ToolCall, ToolDef } from '../../renderer/lib/providers'
import { PermissionDenied } from './permissions'
import { LOCAL_TOOLS, shellInfo, truncateOutput } from './tools'
import { REMOTE_TOOLS } from './remote'
import { ToolError, type ToolContext, type ToolResult, type ToolSpec, type ToolArgs } from './types'

export const ALL_TOOLS: ToolSpec[] = [...LOCAL_TOOLS, ...REMOTE_TOOLS]
const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.def.name, t]))

export const toolDefs = (): ToolDef[] => ALL_TOOLS.map((t) => t.def)

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thought'; content: string }
  | { type: 'tool_start'; toolCall: ToolCall; summary: string }
  | { type: 'tool_result'; toolCallId: string; name: string; output: string; isError: boolean }
  | { type: 'error'; error: string }

const EVENT_OUTPUT_LIMIT = 4000

export function summarizeCall(call: ToolCall): string {
  const spec = BY_NAME.get(call.name)
  try { return spec ? spec.summarize(call.arguments) : call.name } catch { return call.name }
}

/** Runs one tool call behind the permission gate; never throws. */
export async function executeTool(name: string, args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const spec = BY_NAME.get(name)
  if (!spec) return { output: `Неизвестный инструмент: ${name}`, isError: true }
  try {
    const assessment = await spec.assess(args, ctx)
    await ctx.gate.authorize(name, spec.summarize(args), assessment, JSON.stringify(args, null, 2).slice(0, 2000))
    if (ctx.signal.aborted) return { output: 'Прервано пользователем', isError: true }
    return { output: truncateOutput(await spec.run(args, ctx)), isError: false }
  } catch (err) {
    if (err instanceof PermissionDenied || err instanceof ToolError) return { output: err.message, isError: true }
    return { output: `Ошибка: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

export function buildSystemPrompt(workspace: string | null): string {
  const shell = shellInfo().name
  return [
    'You are an autonomous coding and operations assistant running inside DeepSeek Harness Desktop.',
    'You can read, search, create and edit files, run shell commands, fetch web pages, download files and work on remote servers over SSH/SFTP by calling the provided tools.',
    '',
    `Workspace folder: ${workspace ?? '(not selected — ask the user to choose one before changing files)'}`,
    `OS: ${os.platform()} ${os.release()}, shell for the bash tool: ${shell}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Guidelines:',
    '- Prefer tools over guessing: inspect files before editing them; use grep/glob to locate code.',
    '- Use edit_file for small changes and write_file for new files. Never claim a change you did not make.',
    '- Relative paths resolve against the workspace. Network shares (UNC paths such as \\\\server\\share) work like local paths but may need the user\'s approval.',
    '- Remote servers: call list_connections, then use ssh_exec / sftp_* with a connection name. Credentials are never visible to you.',
    '- Actions outside the workspace, risky commands and remote operations ask the user for approval; if declined, do not retry the same action — explain or choose another approach.',
    '- Keep answers concise, and reply in the language of the user.',
  ].join('\n')
}

export type RunAgentOptions = {
  provider: LLMProvider
  config: ProviderConfig
  model: string
  history: Message[]
  ctx: ToolContext
  temperature: number
  maxTokens: number
  maxSteps?: number
  onEvent: (event: AgentEvent) => void
}

const DEFAULT_MAX_STEPS = 30

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { provider, config, model, ctx, onEvent } = opts
  const tools = toolDefs()
  const messages: Message[] = [{ role: 'system', content: buildSystemPrompt(ctx.workspace) }, ...opts.history]
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS

  for (let step = 0; step < maxSteps; step++) {
    let text = ''
    let calls: ToolCall[] = []

    for await (const chunk of provider.chat({ model, messages, tools, temperature: opts.temperature, maxTokens: opts.maxTokens, signal: ctx.signal, config })) {
      if (chunk.type === 'text' && chunk.content) { text += chunk.content; onEvent({ type: 'text', content: chunk.content }) }
      else if (chunk.type === 'tool_calls' && chunk.toolCalls) calls = chunk.toolCalls
      else if (chunk.type === 'error') { onEvent({ type: 'error', error: chunk.error ?? 'Ошибка модели' }); return }
    }
    if (calls.length === 0 || ctx.signal.aborted) return

    messages.push({ role: 'assistant', content: text, toolCalls: calls })
    for (const call of calls) {
      if (ctx.signal.aborted) return
      onEvent({ type: 'tool_start', toolCall: call, summary: summarizeCall(call) })
      const result = await executeTool(call.name, call.arguments, ctx)
      onEvent({ type: 'tool_result', toolCallId: call.id, name: call.name, output: result.output.slice(0, EVENT_OUTPUT_LIMIT), isError: result.isError })
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.output })
    }
  }
  onEvent({ type: 'text', content: `\n\n_Достигнут лимит в ${maxSteps} шагов. Напишите «продолжай», чтобы продолжить._` })
}
