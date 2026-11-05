import type { Register } from 'claude-code'

import { isGated, mismatch } from './rules'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isGated(e.command)) return next(e)

    // Reads ~/.config/gh/hosts.yml locally; no network call.
    const { exitCode, stdout } = await $.process.run(['gh', 'config', 'get', '-h', 'github.com', 'user'], { timeoutMs: 5000 })
    const active = stdout.trim()
    if (exitCode !== 0 || active === '') return next(e)

    const deny = mismatch(e.command, active)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => {
    // A broken guard must not block every shell command: log and let it run.
    $.ui.log(`${$.plugin.name}: guard failed, account not checked`)
    return next(e)
  })
}
