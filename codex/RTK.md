# RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands.

## Rule

Always prefix shell commands with `rtk`.

Examples:

```bash
rtk git status
rtk cargo test
rtk npm run build
rtk pytest -q
```

## Meta Commands

```bash
rtk gain            # Token savings analytics
rtk gain --history  # Recent command savings history
rtk proxy <cmd>     # Run raw command without filtering
```

## Verification

```bash
rtk --version
rtk gain
which rtk
```

## Test output

RTK's summary of test output can be wrong (a passing `go test` run once read
"No tests found", 2026-09-27). Save test output to a file, read it with
`rtk proxy cat`/`rtk proxy grep`, and decide pass or fail by exit status.
