# Pi harness evaluation records

This directory stores small, reviewable evidence records for local Pi harness
runs. Records use aggregate counts, commit identifiers, extension outcomes,
and verification results. They deliberately exclude prompts, source diffs,
credentials, complete command output, and chain-of-thought.

`app-x-2026-08-02.json` is the implementation-time full-stack exercise. It
records its revision as `working-tree` and must not be treated as a reproducible
adoption baseline. `hardened-baseline-2026-08-03.json` pins the resulting
runtime commit and deterministic results. Neither is a paired adoption battery:
no independent reviewer route was available, and Docker was unavailable. Those
features remain disabled or unproven rather than receiving a favorable verdict
from incomplete evidence.

`partial-screening-2026-08-02.json` records four complete pairs from a planned
nine-pair randomized baseline-versus-harness screen, stopped on request after
two reliability defects surfaced. **Superseded** by
`full-screening-2026-08-03.json`, the completed nine-pair rerun after both
defects were fixed — that file is the current battery evidence.
`run_screening.py` is the reusable sequential runner; it records its
randomization seed, runtime identity, raw-result locations, hidden-test
outcomes, extension errors, duration, and token usage.

`pair4-race-condition-2026-08-03.json` is a deep-dive on the one task both
arms failed in the completed battery (a real `go test -race` data race, not a
harness defect), including a per-field token/APC-cache breakdown for its
outlier session.

Current status and the full dated investigation history are in
`../../pi-harness-validation-status.md` and `../../pi-harness-history.md`.
