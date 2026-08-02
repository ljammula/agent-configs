import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi calls its terminal tool "bash". These are all built-in tools, so an
// extension enables them rather than registering duplicate implementations.
const FULL_STACK_TOOLS = ["read", "edit", "write", "find", "grep", "bash"];

const WORKFLOW_PROMPT = `

Strict autonomous full-stack development workflow:
1. Restate the problem, inspect the relevant code and project instructions,
   state safe assumptions, and produce a comprehensive numbered plan. Give
   every step an observable acceptance criterion and verification command.
2. Work autonomously. Resolve routine implementation choices from the code,
   tests, documentation, and existing conventions. Never ask the user to run
   commands, interpret failures, or make a decision that can be made safely
   from repository evidence. Stop only for a genuine external blocker such as
   unavailable credentials, required authorization, or irreducible ambiguity.
3. Implement one coherent, small chunk of the plan at a time. Read a file
   before changing it and keep every change limited to the stated task.
4. Immediately run the relevant focused test, build, lint, typecheck, or other
   verification after every implementation chunk. Use bash for all commands
   and test execution; read and interpret the complete failure output yourself.
5. When a check fails, diagnose its root cause, make the smallest corrective
   change, and rerun the check. Continue this edit-test-debug loop without
   handing work back to the user until the check passes.
6. After all chunks pass, run the project's broad verification suite, inspect
   the final diff against every acceptance criterion, and fix any remaining
   defect. Report completion only with the observed passing results. If an
   external blocker makes completion impossible, report the exact evidence.
`;

export default function fullStackDevExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...FULL_STACK_TOOLS])]);
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt + WORKFLOW_PROMPT,
	}));
}
