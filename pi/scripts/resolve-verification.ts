#!/usr/bin/env tsx
import { resolveVerificationCommand } from "../extensions/lib/verification.ts";

const cwd = process.argv[2];
if (!cwd) {
	process.stderr.write("usage: resolve-verification.ts <workspace>\n");
	process.exitCode = 2;
} else {
	const command = await resolveVerificationCommand(cwd);
	process.stdout.write(JSON.stringify({ command: command ?? null }));
}
