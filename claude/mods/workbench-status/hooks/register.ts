import type { EngineInterface, Register } from 'claude-code'

import { line, modelState } from './format'

const PERIOD_MS = 30_000

// curl, not $.http.fetch: curl's -m bounds an unreachable host to 3 seconds.
async function get($: EngineInterface, url: string): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['curl', '-sf', '-m', '3', url], { timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  return exitCode === 0 ? stdout : undefined
}

async function account($: EngineInterface): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['gh', 'config', 'get', '-h', 'github.com', 'user'], { timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined
}

async function refresh($: EngineInterface): Promise<void> {
  const host = (await $.env.get('AI_STACK_HOST')) ?? 'localhost'
  const [who, slots, searx] = await Promise.all([
    account($),
    get($, `http://${host}:8080/slots`),
    get($, `http://${host}:8888/healthz`),
  ])
  $.ui.status(line({ account: who, model: modelState(slots), search: searx !== undefined }))
}

// Never awaited by a hook: a slow probe must not hold up a session start or a tool result.
function refreshLater($: EngineInterface): void {
  refresh($).catch(() => $.ui.log(`${$.plugin.name}: status refresh failed`))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // -p and SDK sessions draw no status line, so they get no poller.
    if (e.isInteractive) {
      refreshLater($)
      $.clock.every(PERIOD_MS, () => refreshLater($))
    }
    return started
  })

  // A gh auth switch changes the account now, not at the next tick.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgh\s+auth\s+switch\b/.test(e.command)) refreshLater($)
    return ran
  })
}
