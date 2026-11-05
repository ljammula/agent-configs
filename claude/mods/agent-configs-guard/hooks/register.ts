import type { EngineInterface, Register } from 'claude-code'

const SOURCE_ROOT = 'code/agent-configs'

async function resolve($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const { realPath } = await $.fs.stat(path, { resolve: true })
    return realPath
  } catch {
    return undefined
  }
}

// Where a path lands, following links; for a file not written yet, where its folder lands.
async function landing($: EngineInterface, path: string): Promise<string | undefined> {
  const direct = await resolve($, path)
  if (direct !== undefined) return direct

  const slash = path.lastIndexOf('/')
  if (slash <= 0) return undefined
  const folder = await resolve($, path.slice(0, slash))
  return folder === undefined ? undefined : `${folder}${path.slice(slash)}`
}

const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

// Denies a path that lands in agent-configs only by way of a symlink.
async function check($: EngineInterface, path: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (home === undefined || !path.startsWith('/')) return undefined

  const root = (await resolve($, `${home}/${SOURCE_ROOT}`)) ?? `${home}/${SOURCE_ROOT}`
  const real = await landing($, path)
  if (real === undefined || !isUnder(real, root) || isUnder(path, root)) return undefined

  const source = `~/${SOURCE_ROOT}${real.slice(root.length)}`
  return `${path} is a symlink into agent-configs. Edit the source instead: ${source} (then rerun ./install.sh from the main checkout after merge).`
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
