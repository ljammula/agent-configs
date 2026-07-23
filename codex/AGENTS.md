Always use the `karpathy-guidelines` skill by default for coding tasks in every session.

## Local execution harness

Only applies on machines running a local model-serving stack (e.g. `ai-stack`)
with `~/code/ai-stack/scripts/dispatch_local.sh` present — check it exists
before relying on it, since these instructions load on every machine
regardless. When present, the `dispatch-local`, `local-search`,
`local-summarize`, and `before-done` (Phase 0) skills route mechanical
execution, cheap lookups, log triage, and an adversarial diff pass to the
local stack. In every case the local model self-corrects mechanical mistakes
but not logic bugs, so treat its output as evidence to review — never a
trusted result.

The served HTTP endpoints (code review :8080, log triage :8081, SearXNG :8888)
need not be on this machine: set `AI_STACK_HOST` to the serving host (e.g.
`192.168.1.233` for a LAN box) and the reachability checks and scripts resolve
there; unset, it defaults to `127.0.0.1`. Set it once in the shell environment
so all agents inherit it.

@RTK.md
