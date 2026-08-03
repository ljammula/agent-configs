---
name: go-service
description: Go service implementation and review. Use for Go modules, handlers, workers, concurrency, dependencies, or network exposure. Do not use for repositories without go.mod or for deployment-only work.
---

# Go service

Read `go.mod`, repository instructions, CI, and task-runner commands before editing. Prefer the repository's format, generation, lint, and verification commands.

- Add focused table-driven tests for changed behavior and run them after each coherent edit.
- Run the project-wide Go test/build command at completion.
- Run `go test -race` when changing goroutines, workers, caches, shared state, or concurrency.
- Run configured `govulncheck ./...` for dependency, authentication, parser, or network-exposure changes.
- Do not invent a second build workflow when the repository already declares one.
