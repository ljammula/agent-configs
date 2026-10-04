# Spec

## Problem

Transactions in personal-budget-simplifier get a category only from the
merchant auto-categorizer at CSV import time. A wrong or missing category
cannot be corrected, so monthly summaries, budgets and trends stay wrong.

## Scope

Add `PATCH /transactions/{id}` to the Go backend. The JSON body
`{"category_id": N}` sets the category of one existing transaction;
`category_id` 0 marks it uncategorized (0 is the existing "uncategorized"
value of `Transaction.CategoryID`). Implemented as a store method
`(*Store).UpdateTransactionCategory(id, categoryID int64) (Transaction, error)`
with sentinel errors `store.ErrTransactionNotFound` and
`store.ErrCategoryNotFound` (both already declared in
`backend/internal/store/transaction_category.go`), and the handler
`handleUpdateTransactionCategory` in
`backend/internal/api/transaction_category.go` (the route is already
registered in `api.go`). Error responses use the existing `writeError`
helper: status code plus JSON body `{"error": "<message>"}` with
`Content-Type: application/json`; success uses `writeJSON`.

## Non-goals

- Editing any other transaction field (date, merchant, amount, account).
- Bulk recategorization or "apply to all transactions from this merchant".
- Changing the auto-categorizer, CSV import, summaries, budgets or trends code.
- Flutter app changes.
- Database schema changes.

## Affected services and packages

- backend/internal/store (`transaction_category.go`)
- backend/internal/api (`transaction_category.go`)

## Acceptance criteria

1. `UpdateTransactionCategory(id, c)` with an existing transaction and an existing category `c` stores `c` as the transaction's category and returns the transaction with every other field (ID, AccountID, Date, Merchant, AmountCents) unchanged.
2. `UpdateTransactionCategory(id, 0)` marks the transaction uncategorized: category 0 is stored and returned.
3. Only the target transaction changes; other transactions keep their categories.
4. An `id` that matches no transaction returns an error satisfying `errors.Is(err, store.ErrTransactionNotFound)`; the transaction is checked before the category, so an unknown transaction with an unknown category also returns `ErrTransactionNotFound`.
5. A non-zero `categoryID` that matches no category (including negative values) returns an error satisfying `errors.Is(err, store.ErrCategoryNotFound)` and leaves the transaction unchanged.
6. `PATCH /transactions/{id}` with body `{"category_id": N}` for an existing transaction and an existing category returns 200, `Content-Type: application/json`, and the updated transaction as JSON (same shape as `GET /transactions` items); the change is visible through `GET /transactions?month=YYYY-MM`.
7. `{"category_id": 0}` returns 200 with the transaction showing `category_id` 0.
8. A non-integer `{id}` returns 400 with `{"error": "invalid transaction id"}`.
9. A body that is not valid JSON returns 400 with `{"error": "invalid JSON"}`.
10. A body without `category_id`, or with `"category_id": null`, returns 400 with `{"error": "category_id is required"}`.
11. An `{id}` that matches no transaction returns 404 with `{"error": "transaction not found"}`.
12. A `category_id` that matches no category (including negative values) returns 400 with `{"error": "unknown category"}`; any other store error returns 500 with `{"error": "failed to update transaction"}`. Rejected requests leave the transaction unchanged.

## Risks

- Unknown-category detection must not rely on SQLite foreign keys: they are
  not enabled in this database, so the category must be looked up explicitly.
- Uncategorized transactions store category_id 0 (not NULL); the update must
  keep that convention so existing scans into int64 keep working.

## Open questions

None.
