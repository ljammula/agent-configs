import { expect, test } from 'claude-code/testing'

test('a message file with a Claude trailer is refused', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', () => ({ value: 'feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' }))
  on('tool.call', () => ({ result: {} }))

  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -F msg.txt' })
  expect('deny' in r && typeof r.deny === 'string').toBe(true)
})

test('a clean message file goes through', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', () => ({ value: 'feat: x\n' }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -F msg.txt' })
  expect('deny' in r && r.deny !== undefined).toBe(false)
})
