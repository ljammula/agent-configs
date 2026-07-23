import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "path";

// Port of claude/hooks/format-on-edit.sh (a PostToolUse hook) to pi's
// tool_result event.
//
// This matters more here than under Claude Code: a formatting slip that a
// cloud model rarely makes is exactly the kind of mechanical error a local
// model makes often, and `make verify` fails on it. Fixing it at the source
// costs one subprocess; leaving it costs a full failed-verify turn, which on
// an 85K context window is expensive.
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
    }

    // Returning undefined leaves the tool result untouched: the model should
    // see what it wrote, not a diff it did not make.
    return undefined;
  });
}
