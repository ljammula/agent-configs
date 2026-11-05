import { expect, test } from 'claude-code/testing'

test('session start shows the account, a busy model and searx down', async ($, on) => {
  const shown: (string | undefined)[] = []
  on('env.get', () => ({ value: 'studio' }))
  on('process.run', (_, e) => {
    const url = e.argv.at(-1) ?? ''
    if (e.argv[0] === 'gh') return { value: ok('ljammula\n') }
    if (url.endsWith(':8080/slots')) return { value: ok('[{"is_processing":true}]') }
    return { value: { ...ok(''), exitCode: 7 } }
  })
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(shown.at(-1)).toBe('gh:ljammula  8080:busy  searx:down')
})

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
