# buildgate worker skills

Skills for sandboxed buildgate workers, mounted read-only per role by
`factoryd` (`skill_dirs:` + `roles.<role>.skills:` in the session config).
`install.sh` never links this folder into a local agent; local skills live
under `claude/`, `codex/`, `copilot/` and `pi/`.

Every skill here must be:

| Rule | Why |
|---|---|
| Portable front matter: `name` (= folder name), `description`, optional `license` | pi, codex and copilot all load it |
| Instruction-only: no scripts, no symlinks, no exec bits | the snapshot refuses them |
| Non-interactive: never ask, stop or wait for a person | nobody answers during a run |
| No network, no host tools (`gh`, local models, browsers) | the worker has none |
| Consistent with buildgate's prompts: the ticket's `Verify-Command` decides; no commits; never edit oracle tests; reviewers and drafters answer in JSON/files only | the factory, not the agent, owns verify, git and output formats |

| Role | Skills |
|---|---|
| planning | none (spec/plan drafting prompts are fully specified) |
| execution | `buildgate-ticket-done`, `buildgate-guidelines`, `buildgate-tdd`, `buildgate-diagnosing`, and the stack skills `go-service`, `python-service`, `typescript-service`, `flutter-app`, `kafka-processing`, `postgres-change`, `temporal-go` (each applies only when the repo matches) |
| review | none (single-turn, JSON-only prompts; skills add tokens and invite tool use) |
