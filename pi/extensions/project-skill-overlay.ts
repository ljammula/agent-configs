import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROJECT_SKILLS = [
	"backend-dev",
	"daytrix-before-done",
	"daytrix-wiring-verify",
	"frontend-dev",
	"feature-dev",
	"pr-remediate",
	"release",
	"self-review",
	"testflight-cut",
];

export function isDayTrixRemote(remote: string): boolean {
	return /(?:^|[/:])(?:ljammula\/)?personal-assistant(?:\.git)?$/i.test(remote.trim());
}

export async function resolveProjectSkillsRoot(extensionFile = import.meta.filename): Promise<string> {
	return resolve(dirname(await realpath(extensionFile)), "..", "skills");
}

export default function projectSkillOverlay(pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const remote = await pi.exec("git", ["remote", "get-url", "origin"], {
			cwd: event.cwd,
			timeout: 5000,
		}).catch(() => undefined);
		if (!remote || remote.code !== 0 || !isDayTrixRemote(remote.stdout)) return undefined;
		const skillsRoot = await resolveProjectSkillsRoot();
		return { skillPaths: PROJECT_SKILLS.map((name) => resolve(skillsRoot, name)) };
	});
}
