# personal-budget-simplifier — build plan

**Date:** 2026-08-05
**Source:** `research/product-ideas/experiments/2026-08-05.md` (build brief, PASS on channel-verification gate)
**Driven by:** explicit user goal (`/goal`), not the product-lab's own stage gate — the lab candidate
is still `discovered` with Event A/B unmeasured from the HTML prevalidation MVP. This build runs in
parallel to that; it does not change the candidate's lab stage.
**Repo:** `~/code/personal-budget-simplifier` (new, separate from the research/product-ideas repo —
that repo tracks lab experiments, not shipped code)
**Harness:** pi (`~/code/agent-configs/pi`, local ThinkingCap-Qwen3.6-27B route) does the implementation,
chunked into small verified steps per `AGENTS.md` working rules. This document is the plan Claude
authored; Claude drives pi and checks its work, not the other way around.

## Scope decision (stated up front, per karpathy-guidelines rule 3)

The build brief's "connect bank account" is a Plaid-class integration requiring paid API credentials
this machine doesn't have. Substituting: **CSV import of transactions** stands in for "connect
account" in this build — same UX shape (one action produces a categorized transaction list), zero
external dependency. Real bank aggregation is a swap-in later, not a redesign.

Native target: **Flutter desktop (macOS)**, talking to a **local Go HTTP server** over
`localhost`. Mobile (gomobile-embedded backend) is out of scope for this pass — the brief's own
out-of-scope list already excludes "mobile app". Cross-platform here means the Flutter client also
builds for Windows/Linux without changes; only macOS is actually run/verified on this machine.

No real payments. The paid-tier CTA is a UI/business-logic gate (free tier stops you at 3 budgets),
not a Stripe integration — matches "Out-of-scope" in the brief implicitly (no billing infra listed
as in-scope either).

## Architecture

**Backend (Go, `backend/`)**
- `net/http` + `chi` router (or stdlib `ServeMux` if Go 1.26's pattern routing covers it — check
  before adding a dependency).
- SQLite via `modernc.org/sqlite` (pure Go, no cgo — keeps cross-compile simple).
- Domain: `Account`, `Category` (fixed seed set: Groceries, Dining, Transport, Utilities,
  Entertainment, Shopping, Income, Other), `Transaction`, `Budget`.
- Auto-categorization: deterministic keyword-match against merchant string. No ML — matches brief's
  "no methodology lectures" simplicity ethos and is trivially testable.
- Free-tier rule lives in the backend, not just the UI: reject a 4th active budget with a typed
  error the client renders as the upgrade CTA.

Endpoints:
- `POST /accounts`, `GET /accounts`
- `POST /transactions/import` (multipart CSV) → categorizes on ingest, returns import summary
- `GET /transactions?month=YYYY-MM`
- `GET /categories`
- `GET /summary/monthly?month=YYYY-MM` → spend per category, top category flagged
- `POST /budgets` `{category_id, monthly_limit}` → 409 + `LIMIT_REACHED` once 3 active budgets exist
- `GET /budgets` → each with `spent`, `limit`, `over_budget`

**Frontend (Flutter/Dart, `app/`)**
Screens, matching the brief's happy path exactly:
1. Onboarding (local profile name only, no auth server)
2. Connect account → CSV file picker → import summary
3. Dashboard → categorized monthly spending (list, top category highlighted)
4. Set-budget dialog on a category
5. Over-budget banner + "Unlock 3 More Budgets — $4.99/mo" CTA (non-functional placeholder screen)

## Verification per chunk

- Go: `gofmt -l .` clean, `go build ./...`, `go test ./...`
- Dart: `dart format --output=none --set-exit-if-changed .`, `flutter analyze`, `flutter test`
- Final: run the backend, run the Flutter desktop app against it, walk the happy path once by hand,
  screenshot the dashboard and the upgrade-CTA state.

## Chunked implementation steps (each one a bounded pi -p call)

1. Go module scaffold + SQLite schema + migrations, no HTTP yet. Test: schema creates, seed
   categories present.
2. Domain repository layer (CRUD for Account/Transaction/Category/Budget) + categorizer. Unit tests
   per repository method and categorizer keyword table.
3. HTTP handlers + routing wiring the above. Table-driven handler tests (httptest).
4. `flutter create app`, add `http`, `file_picker`, `provider`/`riverpod` (pick one, prefer
   fewer deps — plain `ChangeNotifier` if state needs are this small). API client + models.
5. Screens 1–3 (onboarding, connect/import, dashboard).
6. Screens 4–5 (budget dialog, over-budget banner + CTA) + wiring the 409 `LIMIT_REACHED` response
   to the CTA screen.
7. End-to-end manual verification pass + README for how to run both halves.

## Non-goals for this pass

Real bank aggregation, real payments/billing, savings goals, net worth tracking, multi-account
sharing, CSV export, mobile builds — all paid-tier or explicitly out-of-scope items from the brief.
Build the free-tier happy path solidly; expansion is a follow-up, not part of this goal.
