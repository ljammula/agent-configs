import { expect, test } from 'claude-code/testing'

const denied = (r: object) => 'deny' in r && typeof r.deny === 'string'

test('a push as the reviewer account is refused', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'narsimha-j\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git push' }))).toBe(true)
})

test('a push as the owner goes through', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ljammula\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git push' }))).toBe(false)
})
