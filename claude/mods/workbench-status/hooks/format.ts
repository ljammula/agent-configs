// Pure formatting for the status line: probes go in, one line comes out.

export type ModelState = 'idle' | 'busy' | 'down'

export type Snapshot = {
  account: string | undefined
  model: ModelState
  search: boolean
}

/** Reads llama.cpp's /slots reply: busy when any slot is processing; down when it is not JSON. */
export function modelState(slotsJson: string | undefined): ModelState {
  if (slotsJson === undefined) return 'down'
  try {
    const slots: unknown = JSON.parse(slotsJson)
    if (!Array.isArray(slots)) return 'down'
    return slots.some(s => typeof s === 'object' && s !== null && (s as { is_processing?: unknown }).is_processing === true) ? 'busy' : 'idle'
  } catch {
    return 'down'
  }
}

export const line = (s: Snapshot): string =>
  [`gh:${s.account ?? '?'}`, `8080:${s.model}`, `searx:${s.search ? 'up' : 'down'}`].join('  ')
