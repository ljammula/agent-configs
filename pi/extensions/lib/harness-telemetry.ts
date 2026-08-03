// Shared support module; the installed lib directory is not an extension entry point.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HARNESS_SCHEMA_VERSION = 1;

export type HarnessOutcome =
	| "pass"
	| "fail"
	| "clean"
	| "flagged"
	| "transient"
	| "blocked"
	| "cap-hit"
	| "unconfigured";

export interface HarnessTrace {
	schemaVersion: 1;
	extension: string;
	extensionVersion: string;
	sessionId: string | null;
	taskFixture: string | null;
	diffHash: string | null;
	event: "verification" | "review" | "nudge" | "block" | "timeout" | "startup" | "routing";
	outcome: HarnessOutcome;
	durationMs: number;
	metadata: Record<string, boolean | number | string | null>;
}

export function appendHarnessTrace(
	pi: ExtensionAPI,
	trace: Omit<HarnessTrace, "schemaVersion" | "extensionVersion" | "sessionId" | "taskFixture">,
): void {
	pi.appendEntry("pi-harness-trace", {
		schemaVersion: HARNESS_SCHEMA_VERSION,
		extensionVersion: process.env.PI_HARNESS_VERSION ?? "working-tree",
		sessionId: process.env.PI_SESSION_ID ?? null,
		taskFixture: process.env.PI_TASK_FIXTURE ?? null,
		...trace,
	} satisfies HarnessTrace);
}
