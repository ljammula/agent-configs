// Pure path helpers for the guard: spelling only, no file system.

/** Folds `.`, `..` and repeated slashes in an absolute path. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** An absolute, normalized path: `~/` from home, a relative one from cwd. */
export function absolute(path: string, cwd: string, home: string): string {
  if (path === '~' || path.startsWith('~/')) return normalize(`${home}${path.slice(1)}`)
  return normalize(path.startsWith('/') ? path : `${cwd}/${path}`)
}

/** The folder holding an absolute path; `/` for `/` itself. */
export const parent = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

export const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`)

/** `real` under `realRoot`, spelled from home: `~/<sourceRoot>/...`. */
export const sourceSpelling = (real: string, realRoot: string, sourceRoot: string): string =>
  `~/${sourceRoot}${real.slice(realRoot.length)}`
