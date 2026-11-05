// Pure rules for the commit guard: no I/O here, so tests need no engine.

// Same prefix as gh-account-guard's rules.ts: env assignments and an `rtk` / `rtk proxy` wrapper.
const PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?`
// git's global options before the subcommand: -C dir, -c key=value, --flag[=value].
const GIT = String.raw`git(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*`
const GIT_COMMIT = new RegExp(String.raw`${PREFIX}${GIT}\s+commit\b`)
const GH_BODY_CMD = new RegExp(String.raw`${PREFIX}gh\s+(?:pr|issue)\s+(?:create|edit|comment|review)\b`)
const MESSAGE_FLAG = /\s(?:--message\b|-[a-zA-Z]*m)/
const BODY_FLAG = /\s(?:--body(?!-file)\b|-b\b)/
const WORD = String.raw`("[^"]+"|'[^']+'|\S+)`
const FILE_FLAG = new RegExp(String.raw`\s(?:-F|--file)(?:=|\s+)${WORD}`)
const GIT_DIR = new RegExp(String.raw`\s-C\s+${WORD}`)
const CD = new RegExp(String.raw`^cd\s+${WORD}$`)

/** Splits a shell command on &&, ||, ;, | and newlines (quotes not honoured: best effort). */
export const segments = (command: string): string[] =>
  command.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)

/** The reason to refuse the command, or undefined when its inline text is fine. */
export function verdict(parts: readonly string[]): string | undefined {
  for (const part of parts) {
    if (GIT_COMMIT.test(part) && MESSAGE_FLAG.test(part)) {
      return 'Write the commit message to a file with the Write tool and run `git commit -F <file>`; inline -m text gets corrupted by command substitution and the RTK hook.'
    }
    if (GH_BODY_CMD.test(part) && BODY_FLAG.test(part)) {
      return 'Write the body to a file with the Write tool and pass `--body-file <file>` instead of --body/-b.'
    }
  }
  return undefined
}

const unquote = (word: string): string => word.replace(/^["']|["']$/g, '')

/** The message file a `git commit -F` names, unquoted; undefined for stdin or no -F. */
export function commitFile(part: string): string | undefined {
  if (!GIT_COMMIT.test(part)) return undefined
  const word = FILE_FLAG.exec(part)?.[1]
  const file = word === undefined ? undefined : unquote(word)
  return file === '-' ? undefined : file
}

/** `path` from `dir`, unless it is absolute or starts at home. */
export function join(dir: string, path: string, home: string): string {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) return `${home}${path.slice(1)}`
  return `${dir}/${path}`
}

/** A `cd` target the guard can follow; `$VAR`, a backtick, `-` or a bare `cd` cannot be. */
const isFollowable = (target: string): boolean => target !== '-' && !/[$`]/.test(target)

/** A segment without the subshell or group brackets around it: `(cd x` -> `cd x`. */
const ungroup = (part: string): string => part.replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '')

const isCd = (part: string): boolean => /^cd\b/.test(part)

/** The folder a `cd` segment moves to; undefined when it cannot be told. */
function afterCd(part: string, dir: string | undefined, home: string): string | undefined {
  const target = CD.exec(part)?.[1]
  if (dir === undefined || target === undefined) return undefined
  const unquoted = unquote(target)
  return isFollowable(unquoted) ? join(dir, unquoted, home) : undefined
}

/** git's folder for a commit segment: each `-C dir` before `commit`, applied in order. */
function gitFolder(part: string, dir: string, home: string): string | undefined {
  const globals = part.slice(0, part.search(/\scommit\b/))
  let folder = dir
  for (const match of globals.matchAll(new RegExp(GIT_DIR, 'g'))) {
    const target = unquote(match[1] ?? '')
    if (!isFollowable(target)) return undefined
    folder = join(folder, target, home)
  }
  return folder
}

/**
 * Each `git commit -F` file as a full path, following `cd dir` segments and
 * `git -C dir`; `{ unknown }` names a relative file whose folder cannot be told.
 */
export function commitFiles(parts: readonly string[], cwd: string, home: string): Array<string | { unknown: string }> {
  const files: Array<string | { unknown: string }> = []
  let dir: string | undefined = cwd
  for (const raw of parts) {
    const part = ungroup(raw)
    if (isCd(part)) {
      dir = afterCd(part, dir, home)
      continue
    }
    const file = commitFile(part)
    if (file === undefined) continue
    const absoluteFile = file.startsWith('/') || file.startsWith('~')
    const base = dir === undefined ? undefined : gitFolder(part, dir, home)
    files.push(base === undefined && !absoluteFile ? { unknown: file } : join(base ?? '/', file, home))
  }
  return files
}
