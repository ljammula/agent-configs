---
name: backend-dev
description: >
  Go backend development discipline for DayTrix: red/green table-driven tests,
  handler→service→repository layering with sentinel errors, the private→household→share
  fallback chain, feature-grant middleware, API-contract sync with Flutter models, and
  fail-closed security defaults. Trigger when writing or changing anything under
  backend/ — handlers, services, repositories, middleware, routes.
user-invocable: false
---

# Backend Dev — Go

Practices distilled from this project's conventions and fix history (fail-closed
internal endpoints, CORS allowlist, SSRF guards) plus red/green TDD as the
behavioral contract.

## 1. Red/green TDD — table-driven

Write the failing test before the implementation:

```bash
cd backend && go test ./internal/<pkg>/... -run TestName -v   # red first
# implement
cd backend && go test ./...                                    # green, full suite
```

- Table-driven tests for handlers and services; each case names the behavior it pins.
- Test the error paths, not just the happy path — sentinel-error mapping is behavior.

## 2. Layering — keep each layer honest

- **Repositories** return domain sentinel errors (`ErrNotFound`, …) — never HTTP concepts.
- **Handlers** map sentinels to status codes — never touch Firestore directly.
- **Services** are stateless; dependencies injected in `cmd/server/main.go`.
- Async work: goroutines spawned from a service `Start()`, never fire-and-forget inside a request handler without ownership.

## 3. Item access — fallback chain

Checklist/reminder/note lookups check **private → household → user-share** collections
in that order on not-found. Any new item-scoped endpoint must implement the same chain,
or shared items silently 404 for members.

## 4. Feature gating — all four steps

New gated feature = (1) constant in `userfeatures/feature.go`, (2) `featureProtected(key, handler)`
on the route, (3) `FeatureFlagsController` getter, (4) Flutter widget guard.
Run the `wiring-verify` skill after — partial wiring is the classic miss.

## 5. API contract — the frontend is a consumer

Changing a response shape, field name, or status code breaks Flutter models silently:

- Grep `frontend/lib/` for the endpoint path and the JSON field names you touched.
- Update the Dart model + its tests in the same branch — never leave the contract split
  across two PRs.
- Derived-at-read values (e.g. habit streaks computed from `habit_logs` on every GET)
  must stay derived — do not cache/store them.

## 6. Security defaults — fail closed

Each of these has been a real security fix in this repo:

- Internal/admin endpoints: if the gating secret (`INTERNAL_SECRET`, `ADMIN_SECRET`)
  is unset, **reject** — never fall through to open.
- Anything fetching a user-supplied URL: SSRF guards (private IP ranges, IPv6, ports).
- CORS: explicit allowlist, never `*` with credentials.
- Every user route sits behind Firebase Auth middleware; a new route group must opt in
  explicitly — verify with a curl without a token (expect 401).

## 7. Lint and race

```bash
cd backend && golangci-lint run
cd backend && go test -race ./internal/<pkg>/...   # anything touching goroutines
```

## Done means

Red test written → green → full `go test ./...` → contract greps clean →
`make verify` clean. Then the `before-done` gate.
