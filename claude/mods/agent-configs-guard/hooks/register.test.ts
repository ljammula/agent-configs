import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

type Links = Record<string, string>

// A fake file system: ~/.claude/skills/x is a link into agent-configs.
const LINKS: Links = {
  '/h': '/h',
  '/h/code': '/h/code',
  '/h/.claude': '/h/.claude',
  '/h/.claude/skills': '/h/.claude/skills',
  '/h/code/agent-configs': '/h/code/agent-configs',
  '/h/.claude/skills/x/SKILL.md': '/h/code/agent-configs/claude/skills/x/SKILL.md',
  '/h/.claude/skills/x': '/h/code/agent-configs/claude/skills/x',
  '/h/code/app': '/h/code/app',
  '/h/code/app/main.go': '/h/code/app/main.go',
  '/h/code/agent-configs/README.md': '/h/code/agent-configs/README.md',
}

// ~/code is itself a link to /vol/code: the source's real spelling differs from its home spelling.
const LINKED_CODE: Links = {
  '/h': '/h',
  '/h/code': '/vol/code',
  '/h/code/agent-configs': '/vol/code/agent-configs',
  '/h/code/agent-configs/README.md': '/vol/code/agent-configs/README.md',
}

// A dangling link: its target was deleted.
const DANGLING: Record<string, string> = {
  '/h/.claude/CLAUDE.md': '/h/code/agent-configs/claude/CLAUDE.md',
}

function engine(on: Parameters<TestBody>[1], links: Links = LINKS) {
  on('env.get', () => ({ value: '/h' }))
  on('session.cwd', () => ({ value: '/h/code/app' }))
  on('fs.stat', (_, e) => {
    const dangling = DANGLING[e.path] !== undefined
    if (dangling && !e.resolve) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }
    const realPath = links[e.path]
    if (realPath === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath } }
  })
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: `${DANGLING[e.argv[1] ?? ''] ?? ''}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
}

const denied = (r: object) => 'deny' in r && typeof r.deny === 'string'
const write = (file_path: string) => ({ tool: 'Write', file_path, content: '' }) as const

test('an edit through the symlink is refused and names the source', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: 'Edit', file_path: '/h/.claude/skills/x/SKILL.md', old_string: 'a', new_string: 'b' })
  expect(denied(r)).toBe(true)
  expect(JSON.stringify(r)).toContain('~/code/agent-configs/claude/skills/x/SKILL.md')
})

test('a new file through a linked folder is refused, however deep', async ($, on) => {
  engine(on)
  expect(denied(await $.tool.call(write('/h/.claude/skills/x/NEW.md')))).toBe(true)
  expect(denied(await $.tool.call(write('/h/.claude/skills/x/scripts/deep/new.sh')))).toBe(true)
})

test('~, relative and .. spellings are resolved before the check', async ($, on) => {
  engine(on)
  expect(denied(await $.tool.call(write('~/.claude/skills/x/SKILL.md')))).toBe(true)
  expect(denied(await $.tool.call(write('../../.claude/skills/x/SKILL.md')))).toBe(true)
  expect(denied(await $.tool.call(write('/h/code/agent-configs/../../.claude/skills/x/SKILL.md')))).toBe(true)
})

test('.. is folded by the engine before the hook, so x/../y is checked (and written) as y', async ($, on) => {
  engine(on)
  // The Write tool writes the folded path too, so an unlinked ~/.claude/skills/y is not the source.
  expect(denied(await $.tool.call(write('/h/.claude/skills/x/../y/SKILL.md')))).toBe(false)
})

test('a write through a dangling link into the source is refused', async ($, on) => {
  engine(on)
  expect(denied(await $.tool.call(write('/h/.claude/CLAUDE.md')))).toBe(true)
})

test('edits at the source and elsewhere go through', async ($, on) => {
  engine(on)
  expect(denied(await $.tool.call(write('/h/code/agent-configs/README.md')))).toBe(false)
  expect(denied(await $.tool.call(write('/h/code/app/main.go')))).toBe(false)
  expect(denied(await $.tool.call(write('main.go')))).toBe(false)
})

test('the source is not refused when ~/code itself is a link', async ($, on) => {
  engine(on, LINKED_CODE)
  expect(denied(await $.tool.call(write('/h/code/agent-configs/README.md')))).toBe(false)
})
