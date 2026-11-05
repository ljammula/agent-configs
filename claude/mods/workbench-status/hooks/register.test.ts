import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// Stands for the engine: gh says ljammula, :8080 is busy, SearXNG is down.
function engine(on: Parameters<TestBody>[1]) {
  const shown: (string | undefined)[] = []
  const timers: number[] = []
  let markShown = () => {}
  // Resolves on the first status write: the refresh runs unawaited by the hook.
  const firstStatus = new Promise<void>(resolve => (markShown = resolve))
  on('env.get', () => ({ value: 'studio' }))
  on('process.run', (_, e) => {
    const url = e.argv.at(-1) ?? ''
    if (e.argv[0] === 'gh') return { value: ok('ljammula\n') }
    if (url.endsWith(':8080/slots')) return { value: ok('[{"is_processing":true}]') }
    return { value: { ...ok(''), exitCode: 7 } }
  })
  on('clock.every', (_, e) => {
    timers.push(e.ms)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    shown.push(e.text)
    markShown()
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { shown, timers, firstStatus }
}

test('an interactive session shows the account, a busy model and searx down', async ($, on) => {
  const { shown, timers, firstStatus } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await firstStatus
  expect(shown.at(-1)).toBe('gh:ljammula  8080:busy  searx:down')
  expect(timers[0]).toBe(30_000)
})

test('a non-interactive session starts no poller and shows nothing', async ($, on) => {
  const { shown, timers } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect(shown).toEqual([])
  expect(timers).toEqual([])
})
