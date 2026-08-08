import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeStackSkills } from "./stack-router.ts";

// The 8 stack skills (go-service, python-service, ...) used to be linked
// into every machine's global ~/.pi/agent/skills/ (install.sh's
// PI_STACK_SKILLS), which means Pi advertised all 8 names+descriptions in
// the system prompt on every session regardless of repo -- ~1,790 of the
// harness's measured ~7,036-token startup tax (pi-harness-validation-status.md).
// Same fix as project-skill-overlay.ts's DayTrix skills: stop shipping them
// globally, load only the ones this repo's own evidence matches via
// resources_discover -- same detection stack-router.ts already trusts to
// name a skill in its before_agent_start nudge.
export async function resolveStackSkillsRoot(extensionFile = import.meta.filename): Promise<string> {
	return resolve(dirname(await realpath(extensionFile)), "..", "skills");
}

export default function stackSkillOverlay(pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const skills = await routeStackSkills(event.cwd);
		if (skills.length === 0) return undefined;
		const skillsRoot = await resolveStackSkillsRoot();
		return { skillPaths: skills.map((name) => resolve(skillsRoot, name)) };
	});
}
