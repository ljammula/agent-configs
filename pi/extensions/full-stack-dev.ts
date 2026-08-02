import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi calls its terminal tool "bash". These are all built-in tools, so an
// extension enables them rather than registering duplicate implementations.
const FULL_STACK_TOOLS = ["read", "edit", "write", "find", "grep", "bash"];

const WORKFLOW_PROMPT = `

Full-stack development workflow:
1. Restate the problem, state any assumptions, inspect the relevant code, and
   produce a comprehensive numbered plan with verification for each step.
2. Implement one coherent, small chunk of that plan at a time. Read a file
   before changing it and keep each change limited to the stated task.
3. Immediately run the relevant test, build, lint, or focused verification
   after every implementation chunk. Use bash as the terminal for commands
   and test execution.
4. When a check fails, inspect the failure, debug it, make the next small
   correction, and rerun the relevant check. Repeat until the requested work
   is verified. Do not claim success without reporting an observed result.
`;

export default function fullStackDevExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...FULL_STACK_TOOLS])]);
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt + WORKFLOW_PROMPT,
	}));
}
