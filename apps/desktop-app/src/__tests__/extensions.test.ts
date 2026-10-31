import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseMcpJson, parseOpenCodeConfig, parseCodexConfig,
  readSkill, readSingleFileSkill, scanSkillDir, collectSkills, skillPrompt, skillModelOutput, skillFiles,
  loadExtensions, saveExtensions,
} from '../electron/extensions'
import { webSearch, htmlToText } from '../electron/agent/tools'

afterEach(() => { vi.unstubAllGlobals() })

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-test-'))
}

// ---- config parsers ----------------------------------------------------------

describe('parseMcpJson (Claude Code .mcp.json)', () => {
  it('reads mcpServers with command+args and env', () => {
    const servers = parseMcpJson(JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        'with-env': { command: 'node', args: ['server.js'], env: { KEY: 'v' } },
      },
    }))
    expect(servers).toHaveLength(2)
    const fs2 = servers.find((s) => s.name === 'filesystem')!
    expect(fs2.command).toBe('npx')
    expect(fs2.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
    expect(fs2.enabled).toBe(true)
    expect(servers.find((s) => s.name === 'with-env')!.env).toEqual({ KEY: 'v' })
  })

  it('accepts mcp_servers alias and skips entries without a command', () => {
    const servers = parseMcpJson(JSON.stringify({ mcp_servers: { ok: { command: 'cmd' }, bad: { args: ['x'] } } }))
    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBe('cmd')
  })

  it('throws when mcpServers is missing', () => {
    expect(() => parseMcpJson('{"foo":1}')).toThrow()
    expect(() => parseMcpJson('not json')).toThrow()
  })
})

describe('parseOpenCodeConfig (opencode.json)', () => {
  it('reads mcp.servers local entries, including command-as-array', () => {
    const servers = parseOpenCodeConfig(JSON.stringify({
      mcp: { servers: {
        local1: { type: 'local', command: ['npx', 'server.js'], environment: { E: '1' } },
        local2: { command: 'cmd' },
        remote: { type: 'remote', url: 'https://x' },
        off: { command: 'cmd2', disabled: true },
      } },
    }))
    expect(servers.map((s) => s.name).sort()).toEqual(['local1', 'local2', 'off'])
    expect(servers.find((s) => s.name === 'local1')!.args).toEqual(['server.js'])
    expect(servers.find((s) => s.name === 'local1')!.env).toEqual({ E: '1' })
    expect(servers.find((s) => s.name === 'off')!.enabled).toBe(false)
  })

  it('throws when mcp.servers is missing', () => {
    expect(() => parseOpenCodeConfig('{"mcp":{}}')).toThrow()
  })
})

describe('parseCodexConfig (config.toml)', () => {
  it('reads [mcp_servers.*] sections with args arrays', () => {
    const servers = parseCodexConfig([
      '# comment',
      '[mcp_servers.files]',
      'command = "npx"',
      'args = ["-y", "@mcp/files"]',
      '',
      '[other_section]',
      'command = "ignored"',
      '',
      '[mcp_servers.bare]',
      'command = "node"',
    ].join('\n'))
    expect(servers).toHaveLength(2)
    expect(servers.find((s) => s.name === 'files')!.args).toEqual(['-y', '@mcp/files'])
    expect(servers.find((s) => s.name === 'bare')!.command).toBe('node')
  })

  it('skips sections without a command', () => {
    expect(parseCodexConfig('[mcp_servers.nothing]\nargs = ["x"]')).toHaveLength(0)
  })
})

// ---- skills -------------------------------------------------------------------

describe('skills', () => {
  it('reads SKILL.md frontmatter from a skill folder', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: Does the thing.\n---\n\nInstructions here.')
    const skill = readSkill(dir)
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('my-skill')
    expect(skill!.description).toBe('Does the thing.')
  })

  it('rejects SKILL.md without description', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\nbody')
    expect(readSkill(dir)).toBeNull()
  })

  it('reads single-file skills (<name>.md with frontmatter)', () => {
    const root = tmpDir()
    fs.writeFileSync(path.join(root, 'helper.md'), '---\nname: helper\ndescription: Helps.\n---\n\nDo stuff.')
    const skills = scanSkillDir(root)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('helper')
    expect(skills[0].file).toBe('helper.md')
    expect(skillFiles(skills[0].dir, skills[0].file)).toEqual(['helper.md'])
  })

  it('collectSkills dedupes and combines dirs', () => {
    const a = tmpDir()
    const b = tmpDir()
    fs.writeFileSync(path.join(a, 'SKILL.md'), '---\nname: a\ndescription: A\n---\nA')
    fs.writeFileSync(path.join(b, 'SKILL.md'), '---\nname: b\ndescription: B\n---\nB')
    const all = collectSkills({ mcpServers: [], skillDirs: [a, a, b], disabledSkills: [] })
    expect(all.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('skillModelOutput wraps content in <skill_content> with <skill_files>', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: s\ndescription: D\n---\n\nStep 1.')
    fs.writeFileSync(path.join(dir, 'script.sh'), 'echo hi')
    const skill = readSkill(dir)!
    const out = skillModelOutput(skill)
    expect(out).toContain('<skill_content name="s">')
    expect(out).toContain('Step 1.')
    expect(out).toContain('<skill_files>')
    expect(out).toContain('<file>script.sh</file>')
    expect(out).toContain(dir)
  })

  it('skillPrompt lists skills in <available_skills>', () => {
    const prompt = skillPrompt([{ dir: '/x', name: 'n', description: 'd' }])
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('<name>n</name>')
    expect(skillPrompt([])).toBe('')
  })
})

// ---- extensions config ---------------------------------------------------------

describe('loadExtensions/saveExtensions', () => {
  it('round-trips config and tolerates a missing file', () => {
    const file = path.join(tmpDir(), 'extensions.json')
    const cfg = loadExtensions(file)
    expect(cfg.mcpServers).toEqual([])
    saveExtensions(file, { ...cfg, mcpServers: [{ id: 'x', name: 'x', command: 'c', args: [], enabled: true }] })
    expect(loadExtensions(file).mcpServers).toHaveLength(1)
  })

  it('caps mcpServers at 30 on load', () => {
    const file = path.join(tmpDir(), 'extensions.json')
    const servers = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, command: 'c', args: [], enabled: true }))
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }))
    expect(loadExtensions(file).mcpServers).toHaveLength(30)
  })
})

// ---- web search ------------------------------------------------------------------

describe('webSearch', () => {
  const signal = () => new AbortController().signal

  it('parses DuckDuckGo results and unfolds redirect links', async () => {
    const html = [
      '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example page</a>',
      '<a class="result__snippet" data-testid="result-snippet">A great <b>snippet</b></a></div>',
      '<div class="result"><a class="result__a" href="https://plain.org/x">Plain</a></div>',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    const hits = await webSearch('test query', signal())
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].url).toBe('https://example.com/page')
    expect(hits[0].title).toBe('Example page')
    expect(hits[0].snippet).toContain('A great snippet')
    expect(hits.some((h) => h.url === 'https://plain.org/x')).toBe(true)
  })

  it('returns [] on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    await expect(webSearch('q', signal())).rejects.toThrow()
  })
})

describe('htmlToText', () => {
  it('strips tags, scripts and collapses whitespace', () => {
    const text = htmlToText('<html><head><script>evil()</script><style>a{}</style></head><body><h1>Заголовок</h1><p>Текст  тут</p></body></html>')
    expect(text).toContain('Заголовок')
    expect(text).toContain('Текст тут')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('{}')
  })
})
