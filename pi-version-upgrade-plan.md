# Pi version upgrade — runbook

**Status as of 2026-08-20: no upgrade scheduled.** Pi is deliberately pinned
at `0.83.0` across `pi/package.json`'s four `@earendil-works/pi-*`
dependencies (see "Current configuration" in
`pi-harness-validation-status.md`). This file is the procedure to follow
*when* a bump is warranted — a CVE, a fix or feature this harness actually
needs, or upstream dropping support for `0.83.0` — not a plan to bump now.

## Why pinned (recap)

The whole validation battery — the Qwen3.8 migration replication, the 7/9
and 9/9 harness-only batteries, the `defaultThinkingLevel` fix — is only
valid evidence *for 0.83.0*. Pi is a controlled variable in every one of
those comparisons; letting it float would make every future "N/M passing"
result indistinguishable from a version-caused regression. Extensions also
typecheck against pinned 0.83.0 public types (`pi-harness-validation-status.md`
line 88), so an upstream type rename lands as a silent hole, not a loud
break, if the pin moves without a check.

## Latest-version check (done 2026-08-20)

Checked npm (`@earendil-works/pi-coding-agent` dist-tag `latest`) and the
`earendil-works/pi` GitHub releases for `0.83.0` → `0.84.2`:

- 0.84.0: fullscreen TUI, Mermaid/LaTeX rendering, `AGENTS.override.md`, a
  v4 session-storage rewrite (`JsonlSessionRepo`/`SessionRepo`), a
  `message_update` JSON/RPC event-shape change, `ModelsStreamTransforms` →
  `ModelsRequestTransforms` rename.
- 0.84.1: `pi auth check`, Qwen Token Plan Individual provider, tool-call
  termination in extensions.
- 0.84.2: fullscreen transcript search, `defaultTools` setting,
  experimental constrained sampling.

None of the renamed/removed types appear in `pi/extensions/`, `pi/scripts/`,
or `pi/evals/` (only in `node_modules` typings). `run_screening.py`'s
`parse_usage()`/`parse_traces()` read `agent_end.messages[]` and
`entry_appended`/`pi-harness-trace` — both untouched by the `message_update`
event-shape change, even though that event type does appear in real
`pi-output.jsonl` evidence (1,147 occurrences in one file) — it's just never
parsed. No extension subscribes to `message_update` or touches
`assistantMessageEvent`/`.partial`. **Conclusion: no forcing fix or feature
in 0.84.x for this harness.** Re-run this check before triggering the
procedure below, since the gap between 0.83.0 and `latest` will have grown.

## Procedure, when it's time

1. **Bump the pin, all four packages in lockstep** (they cross-depend on
   each other via `^0.83.0` peer ranges in `package-lock.json` — don't
   bump one and leave the others behind):

   ```bash
   cd pi
   npm install @earendil-works/pi-agent-core@<version> \
     @earendil-works/pi-ai@<version> \
     @earendil-works/pi-coding-agent@<version> \
     @earendil-works/pi-tui@<version> --save-exact
   ```

2. **Static checks** — cheap, catches breakage before spending model time:

   ```bash
   npm run typecheck   # tsc --noEmit against the new package's public types
   npm run test        # tsx --test tests/*.test.ts + Python unittest suite
   ```

3. **Live preflight** — same shape `run_screening.py`'s `main()` /
   `model_identity()` already do; confirm by hand first:

   ```bash
   pi --version
   curl -fsS http://kannasmacstudio.lan:8080/v1/models   # Qwen3.8 route
   curl -fsS http://kannasmacstudio.lan:8081/v1/models   # Gemma reviewer route
   ```

4. **Validation subset, not a cold full battery** — 2-3 pairs, including at
   least one that's previously found a real defect (pair 4):

   ```bash
   python3 evals/run_screening.py --seed 20260802 --max-pairs 3 \
     --host kannasmacstudio.lan \
     --output evals/battery-results/<date>-seed20260802-<version>-validation
   ```

   Check: hidden-test pass rate matches prior runs, `extension errors`
   count is still 0, and `pi-harness-trace` entries still appear (a version
   bump that silently changes the custom-event shape shows up here as
   traces going missing, not as a crash).

5. **Decide on the full 9-pair battery** — only if the subset is ambiguous,
   or if the new pin should carry full-battery evidence rather than a
   spot-check.

6. **Update the docs** — the "Current configuration" `Pi 0.83.0` sentence
   in `pi-harness-validation-status.md`, plus a dated entry in
   `pi-harness-history.md` recording what was bumped, what was checked, and
   the result, matching every other dated entry in that file.

## Rollback

If step 2 or 3 fails, or step 4's subset regresses relative to the last
recorded battery for the same pairs, revert `pi/package.json` and
`pi/package-lock.json` (`git checkout -- pi/package.json
pi/package-lock.json && cd pi && npm install`) and record why in
`pi-harness-history.md` rather than silently retrying — a failed bump
attempt is itself evidence worth keeping, the same way this repo already
keeps records of failed/superseded trials elsewhere.
