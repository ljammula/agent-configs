---
name: temporal-go
description: Temporal Go Workflow and Activity development. Use when go.mod includes the Temporal SDK or Temporal workflow code changes. Do not use for ordinary Go services without Temporal evidence.
---

# Temporal Go

- Keep Workflow code deterministic and put side effects in Activities.
- Use the Go SDK test environment for Workflow and Activity behavior, failures, cancellation, signals, retries, and time skipping.
- Replay representative recent open and closed histories for Workflow-definition changes; fail on nondeterminism.
- Version behavior changes that cannot safely replay against existing histories.
