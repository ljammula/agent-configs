// Shared support module; the installed lib directory is not an extension entry point.

// Pi invalidates a captured `pi`/ctx after session replacement or reload (e.g.
// auto-compaction) and any further pi.* call throws this documented message.
// Extensions with async handlers that span such a boundary must not crash the
// turn; a fresh extension instance is registered for the replacement session,
// so there is nothing productive left to do in the stale one.
const STALE_CONTEXT_MESSAGE_FRAGMENT = "stale after session replacement or reload";

export function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE_CONTEXT_MESSAGE_FRAGMENT);
}
