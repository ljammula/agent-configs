import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

// A fake file system: ~/.claude/skills/x is a link into agent-configs.
const LINKS: Record<string, string> = {
  '/h/code/agent-configs': '/h/code/agent-configs',
  '/h/.claude/skills/x/SKILL.md': '/h/code/agent-configs/claude/skills/x/SKILL.md',
  '/h/.claude/skills/x': '/h/code/agent-configs/claude/skills/x',
  '/h/code/app/main.go': '/h/code/app/main.go',
  '/h/code/agent-configs/README.md': '/h/code/agent-configs/README.md',
}

function engine(on: Parameters<TestBody>[1]) {
  on('env.get', () => ({ value: '/h' }))
  on('fs.stat', (_, e) => {
    const realPath = LINKS[e.path]
    if (realPath === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath } }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))
}

const denied = (r: object) => 'deny' in r && typeof r.deny === 'string'

test('an edit through the symlink is refused and names the source', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: 'Edit', file_path: '/h/.claude/skills/x/SKILL.md', old_string: 'a', new_string: 'b' })
  expect(denied(r)).toBe(true)
  expect(JSON.stringify(r)).toContain('~/code/agent-configs/claude/skills/x/SKILL.md')
})

test('a new file written through a linked folder is refused', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: 'Write', file_path: '/h/.claude/skills/x/NEW.md', content: '' })
  expect(denied(r)).toBe(true)
})

test('edits at the source and elsewhere go through', async ($, on) => {
  engine(on)
  const atSource = await $.tool.call({ tool: 'Write', file_path: '/h/code/agent-configs/README.md', content: '' })
  const elsewhere = await $.tool.call({ tool: 'Write', file_path: '/h/code/app/main.go', content: '' })
  expect(denied(atSource)).toBe(false)
  expect(denied(elsewhere)).toBe(false)
})
