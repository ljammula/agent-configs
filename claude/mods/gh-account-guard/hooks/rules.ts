// Pure rules for which GitHub account each command must run as.

export const OWNER = 'ljammula'
export const REVIEWER = 'narsimha-j'

// Same prefix as commit-guard's rules.ts: env assignments and an `rtk` / `rtk proxy` wrapper.
const PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?`
// git's global options before the subcommand: -C dir, -c key=value, --flag[=value].
const GIT = String.raw`git(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*`
const OWNER_ONLY = new RegExp(String.raw`${PREFIX}(?:${GIT}\s+push\b|gh\s+pr\s+(?:create|merge)\b|gh\s+release\s+create\b)`)
const REVIEWER_ONLY = new RegExp(String.raw`${PREFIX}gh\s+pr\s+review\b`)
const SWITCH = new RegExp(String.raw`${PREFIX}gh\s+auth\s+switch\b`)
const SWITCH_USER = /\s(?:-u|--user)(?:=|\s+)["']?([\w-]+)["']?/

/** A bare `gh auth switch` picks an account by what is logged in, so the guard cannot tell which. */
const UNKNOWN = 'whatever account a bare `gh auth switch` picked'

export const segments = (command: string): string[] =>
  command.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)

/** The account a segment needs, or undefined when any account will do. */
export function needs(part: string): string | undefined {
  if (REVIEWER_ONLY.test(part)) return REVIEWER
  if (OWNER_ONLY.test(part)) return OWNER
  return undefined
}

/** Walks the command, following `gh auth switch`, and returns why it runs as the wrong account. */
export function mismatch(command: string, active: string): string | undefined {
  let account = active
  for (const part of segments(command)) {
    if (SWITCH.test(part)) {
      account = SWITCH_USER.exec(part)?.[1] ?? UNKNOWN
      continue
    }
    const wanted = needs(part)
    if (wanted !== undefined && wanted !== account) {
      const back = wanted === REVIEWER ? `, then switch back to ${OWNER} after the review` : ''
      return `\`${part}\` would run as ${account}; it must run as ${wanted}. Run \`gh auth switch --user ${wanted}\` first${back}.`
    }
  }
  return undefined
}

/** Whether the command needs a particular account anywhere, so the active one is worth looking up. */
export const isGated = (command: string): boolean => segments(command).some(p => needs(p) !== undefined)
