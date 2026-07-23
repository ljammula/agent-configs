import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Port of claude/hooks/rtk-rewrite.sh to pi's tool_call event. Same single
// source of truth: all rewrite logic lives in `rtk rewrite` (the Rust
// registry), this only shuttles the command through it.
//
// Worth more here than in Claude Code: the local ai-stack slots have an 85K
// context window, so the 60-90% output reduction on git/ls/find/cargo buys
// proportionally more turns before compaction kicks in.
//
// `rtk rewrite` exit codes:
//   0 + stdout  rewrite available          -> apply it
//   1           no rtk equivalent          -> leave the command alone
//   2           deny rule matched          -> leave it alone (pi has no
//                                             native deny list to defer to,
//                                             and blocking here would be a
//                                             behavior change, not a rewrite)
//   3 + stdout  ask rule matched           -> apply the rewrite, no prompt
//
// Code 3 is treated exactly like code 0 here. In Claude Code it means "rewrite,
// but let the native permission layer prompt"; pi has no native permission
// prompts, and rtk returns 3 for reads as ordinary as `git status`, so
// prompting on it would put a confirmation in front of nearly every command.
// Blocking or gating is the job of protected-paths.ts, not of a rewrite that
// changes only how much output comes back.
//
// Any other exit code, a missing binary, or a timeout is a pass-through: a
// token optimization must never be able to break the command it optimizes.
export default function (pi: ExtensionAPI) {
  let available: boolean | undefined;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string | undefined;
    if (!command) return undefined;

    if (available === undefined) {
      const probe = await pi.exec("rtk", ["--version"], { timeout: 5000 }).catch(() => undefined);
      // reachingforthejack/rtk (Rust Type Kit) is a different binary with the
      // same name and no `rewrite` subcommand -- treat it as absent.
      available = probe?.code === 0 && /^rtk \d+\.\d+\.\d+/.test(probe.stdout.trim());
    }
    if (!available) return undefined;

    const result = await pi
      .exec("rtk", ["rewrite", command], { timeout: 10000, signal: ctx.signal })
      .catch(() => undefined);
    if (!result) return undefined;

    const rewritten = result.stdout.trim();
    if ((result.code !== 0 && result.code !== 3) || !rewritten || rewritten === command) {
      return undefined;
    }

    event.input.command = rewritten;
    return undefined;
  });
}
