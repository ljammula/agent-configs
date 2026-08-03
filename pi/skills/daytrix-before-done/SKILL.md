---
name: daytrix-before-done
description: DayTrix completion overlay. Use only when the repository remote is ljammula/personal-assistant and code, UI, PR, CI, localization, or review state changes. Never expose this workflow in unrelated repositories.
---

# DayTrix before-done overlay

Apply the portable `before-done` core plus the repository's current instructions.

- Run `make fmt`, `make lint`, and the applicable focused tests; finish with `make verify`.
- For Flutter strings, run `scripts/check-l10n.sh` and confirm keys exist in every `.arb` locale.
- For Flutter UI, run tests with `--concurrency=4`, refresh only intended goldens, run the local Playwright preview, and inspect screenshots.
- Read the matching `docs/specs/` packet and complete its acceptance evidence when it uses `R-*` requirements.
- For PR work, use the repository/account workflow and verify the exact PR, CI run, and unresolved thread count. Review actions use `narsimha-j`; always switch back to `ljammula`.
- Release and TestFlight operations remain user-triggered skills and never follow implicitly from this gate.
