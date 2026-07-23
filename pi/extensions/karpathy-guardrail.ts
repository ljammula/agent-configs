import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi has no equivalent of Claude Code's CLAUDE.md "always invoke this skill"
// instruction (that phrasing names a "Skill tool" that doesn't exist here),
// and its own skill system surfaces skills by relevance-matching rather than
// unconditionally. This guarantees the karpathy-guidelines behavior fires on
// every coding turn regardless of matching -- the full guideline text stays
// in skills/karpathy-guidelines/SKILL.md as the single source of truth; this
// is just the trigger.
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\nApply the karpathy-guidelines skill at the start of any coding task: " +
        "make surgical changes only (touch only what the task requires), write " +
        "the minimum code that solves the stated problem (no speculative " +
        "abstractions or unrequested error handling), surface assumptions or " +
        "ambiguity before writing code rather than guessing, and define a " +
        "verifiable success criterion (e.g. a failing test) before looping on a fix.",
    };
  });
}
