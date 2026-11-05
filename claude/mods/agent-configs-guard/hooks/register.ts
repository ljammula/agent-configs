import type { EngineInterface, Register } from 'claude-code'

import { absolute, isUnder, parent, sourceSpelling } from './paths'

const SOURCE_ROOT = 'code/agent-configs'

async function resolve($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const { realPath } = await $.fs.stat(path, { resolve: true })
    return realPath
  } catch {
    return undefined
  }
}

// Where a path lands, following links: the nearest ancestor that exists, resolved, plus the rest.
async function landing($: EngineInterface, path: string): Promise<string> {
  let rest = ''
  for (let at = path; at !== '/'; at = parent(at)) {
    const real = await resolve($, at)
    if (real !== undefined) return `${real}${rest}`
    rest = `${at.slice(at.lastIndexOf('/'))}${rest}`
  }
  return path
}

// Denies a path that lands in agent-configs only by way of a symlink.
async function check($: EngineInterface, rawPath: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined

  const path = absolute(rawPath, await $.session.cwd(), home)
  const literalRoot = `${home}/${SOURCE_ROOT}`
  const realRoot = (await resolve($, literalRoot)) ?? literalRoot
  if (isUnder(path, literalRoot) || isUnder(path, realRoot)) return undefined

  const real = await landing($, path)
  if (!isUnder(real, realRoot)) return undefined

  const source = sourceSpelling(real, realRoot, SOURCE_ROOT)
  return `${rawPath} is a symlink into agent-configs. Edit the source instead: ${source} (then rerun ./install.sh from the main checkout after merge).`
}

export const register: Register = on => {
  // A broken guard must not block every edit: each .catch logs and lets it run.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await check($, e.file_path)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => {
    $.ui.log(`${$.plugin.name}: guard failed, edit not checked`)
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await check($, e.file_path)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => {
    $.ui.log(`${$.plugin.name}: guard failed, edit not checked`)
    return next(e)
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await check($, e.notebook_path)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => {
    $.ui.log(`${$.plugin.name}: guard failed, edit not checked`)
    return next(e)
  })
}
