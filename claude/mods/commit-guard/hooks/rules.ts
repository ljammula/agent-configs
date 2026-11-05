// Pure rules for the commit guard: no I/O here, so tests need no engine.

const GIT_COMMIT = /^(?:\w+=\S*\s+)*git\b(?:\s+-[Cc]\s+\S+)*\s+commit\b/
const MESSAGE_FLAG = /\s(?:--message\b|-[a-zA-Z]*m)/
const GH_BODY_CMD = /^(?:\w+=\S*\s+)*gh\s+(?:pr|issue)\s+(?:create|edit|comment|review)\b/
const BODY_FLAG = /\s(?:--body(?!-file)\b|-b\b)/
const FILE_FLAG = /\s(?:-F|--file)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/

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

/** The message file a `git commit -F` names, unquoted; undefined for stdin or no -F. */
export function commitFile(part: string): string | undefined {
  if (!GIT_COMMIT.test(part)) return undefined
  const match = FILE_FLAG.exec(part)
  const file = match?.[1]?.replace(/^["']|["']$/g, '')
  return file === undefined || file === '-' ? undefined : file
}
