import type { Register } from 'claude-code'

import { commitFiles, segments, verdict } from './rules'

const TRAILER = /^Co-Authored-By:\s*Claude/im

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const parts = segments(e.command)
    const inline = verdict(parts)
    if (inline !== undefined) return { deny: inline }

    const home = (await $.env.get('HOME')) ?? ''
    for (const path of commitFiles(parts, await $.session.cwd(), home)) {
      // A file that cannot be read now (written later in the same command) is not checked.
      const text = await $.fs.read(path).catch(() => '')
      if (TRAILER.test(text)) {
        return { deny: `${path} has a Co-Authored-By: Claude trailer; CLAUDE.md says to leave it out. Remove the line and commit again.` }
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    // A broken guard must not block every shell command: log and let it run.
    $.ui.log(`${$.plugin.name}: guard failed, command not checked`)
    return next(e)
  })
}
