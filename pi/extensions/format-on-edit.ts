import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import { join, resolve } from "path";

const JS_TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

// Port of claude/hooks/format-on-edit.sh (a PostToolUse hook) to pi's
// tool_result event.
//
// This matters more here than under Claude Code: a formatting slip that a
// cloud model rarely makes is exactly the kind of mechanical error a local
// model makes often, and `make verify` fails on it. Fixing it at the source
// costs one subprocess; leaving it costs a full failed-verify turn, which on
// a local context window is expensive.
export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (event.isError) return undefined;

    const path = (event.input as { path?: string }).path;
    if (!path) return undefined;

    const absolutePath = resolve(ctx.cwd, path);

    if (absolutePath.endsWith(".go")) {
      await pi.exec("gofmt", ["-w", absolutePath], { timeout: 10000 }).catch(() => undefined);
    } else if (absolutePath.endsWith(".dart")) {
      await pi.exec("dart", ["format", absolutePath], { timeout: 30000 }).catch(() => undefined);
    } else if (JS_TS_EXTENSIONS.some((ext) => absolutePath.endsWith(ext))) {
      // Unlike gofmt/dart format, there's no formatter bundled with the
      // language itself -- only run prettier if the repo actually installed
      // it, never via npx (which would silently fetch from the network).
      const prettierBin = join(ctx.cwd, "node_modules", ".bin", "prettier");
      if (await exists(prettierBin)) {
        await pi.exec(prettierBin, ["--write", absolutePath], { timeout: 10000 }).catch(() => undefined);
      }
    }

    // Returning undefined leaves the tool result untouched: the model should
    // see what it wrote, not a diff it did not make.
    return undefined;
  });
}
