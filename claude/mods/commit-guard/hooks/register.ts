import type { Register } from 'claude-code'

import { commitFile, segments, verdict } from './rules'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const parts = segments(e.command)
    const inline = verdict(parts)
    if (inline !== undefined) return { deny: inline }

    for (const part of parts) {
      const file = commitFile(part)
      if (file === undefined) continue

      const path = file.startsWith('/') ? file : `${await $.session.cwd()}/${file}`
      const text = await $.fs.read(path).catch(() => '')
      if (/^Co-Authored-By:\s*Claude/im.test(text)) {
        return { deny: `${file} has a Co-Authored-By: Claude trailer; CLAUDE.md says to leave it out. Remove the line and commit again.` }
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    // A broken guard must not block every shell command: log and let it run.
    $.ui.log(`${$.plugin.name}: guard failed, command not checked`)
    return next(e)
  })
}
