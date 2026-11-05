// Pure rules for which GitHub account each command must run as.

export const OWNER = 'ljammula'
export const REVIEWER = 'narsimha-j'

const PREFIX = String.raw`^(?:\w+=\S*\s+)*`
const OWNER_ONLY = new RegExp(`${PREFIX}(?:git\\b(?:\\s+-C\\s+\\S+)*\\s+push\\b|gh\\s+pr\\s+(?:create|merge)\\b|gh\\s+release\\s+create\\b)`)
const REVIEWER_ONLY = new RegExp(`${PREFIX}gh\\s+pr\\s+review\\b`)
const SWITCH = new RegExp(`${PREFIX}gh\\s+auth\\s+switch\\b.*--user(?:=|\\s+)(\\S+)`)

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
    const switched = SWITCH.exec(part)?.[1]
    if (switched !== undefined) {
      account = switched
      continue
    }
    const wanted = needs(part)
    if (wanted !== undefined && wanted !== account) {
      return `\`${part}\` would run as ${account}; it must run as ${wanted}. Run \`gh auth switch --user ${wanted}\` first${wanted === REVIEWER ? `, then switch back to ${OWNER} after the review` : ''}.`
    }
  }
  return undefined
}

/** Whether the command needs a particular account anywhere, so the active one is worth looking up. */
export const isGated = (command: string): boolean => segments(command).some(p => needs(p) !== undefined)
