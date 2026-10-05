# Spec

## Problem

personal-budget-simplifier categorizes imported transactions only by keyword
substrings (`categorize.Categorize`), and `PATCH /transactions/{id}` fixes one
transaction at a time. A merchant the keywords get wrong (or miss) has to be
fixed by hand on every transaction, every month. Users need a rule: "every
transaction from this merchant belongs to this category", applied to the
transactions already imported and to every future CSV import.

## Scope

Merchant rules in the Go backend:

- Table `merchant_rules (id, merchant UNIQUE, category_id)` — already added to
  `backend/internal/db/schema.go`.
- Store API in `backend/internal/store/merchant_rule.go` (stubs exist with the
  final signatures): `NormalizeMerchant`, `(*Store).CreateMerchantRule`,
  `ListMerchantRules`, `DeleteMerchantRule`, `CategoryForMerchant`, type
  `MerchantRule`, sentinel errors `ErrEmptyMerchant`, `ErrMerchantRuleExists`,
  `ErrMerchantRuleNotFound`; the existing `store.ErrCategoryNotFound` is reused.
- HTTP handlers in `backend/internal/api/merchant_rules.go` for
  `POST /merchant-rules`, `GET /merchant-rules`, `DELETE /merchant-rules/{id}`
  (routes already registered in `api.go`). Errors use the existing
  `writeError` helper (status + `{"error": "<message>"}`, `Content-Type:
  application/json`); success uses `writeJSON`.
- CSV import (`handleImportCSV` in `api.go`) applies a matching rule before
  the keyword categorizer.

A merchant is **normalized** by removing surrounding whitespace and
lower-casing (ASCII case-insensitivity is what is required). A rule matches a
transaction when the normalized transaction merchant equals the rule's
merchant exactly (no substring matching).

## Non-goals

- Substring, prefix or pattern rules; rule priorities.
- Editing a rule (delete and re-create instead).
- Changing transactions when a rule is deleted.
- Changing `categorize.Categorize`, summaries, budgets, trends or export.
- Flutter app changes.

## Affected services and packages

- backend/internal/store (`merchant_rule.go`)
- backend/internal/api (`merchant_rules.go`, `api.go` import handler)

## Acceptance criteria

1. `NormalizeMerchant` removes surrounding whitespace and lower-cases: `"  Starbucks #12 "` becomes `"starbucks #12"`; inner whitespace is kept.
2. `CreateMerchantRule(m, c)` with a merchant that is non-empty after normalization and an existing category `c` stores a rule whose `Merchant` is `NormalizeMerchant(m)` and whose `CategoryID` is `c`, returns it with `ID > 0`, and the rule is returned by `ListMerchantRules`.
3. `CreateMerchantRule` sets category `c` on every existing transaction whose normalized merchant equals the rule's merchant (whatever its previous category, including 0) and returns the number of those transactions; transactions with any other merchant — including merchants that merely contain the rule's text, e.g. `"Starbucks #12 Airport"` — keep their categories.
4. A merchant that is empty or whitespace-only returns an error satisfying `errors.Is(err, store.ErrEmptyMerchant)`; this is checked before the category, so it wins over an unknown category. Nothing is stored and no transaction changes.
5. A `categoryID` that is 0, negative, or matches no category returns an error satisfying `errors.Is(err, store.ErrCategoryNotFound)`; nothing is stored and no transaction changes. (Foreign keys are not enabled; the category must be looked up.)
6. Creating a rule whose normalized merchant already has a rule returns an error satisfying `errors.Is(err, store.ErrMerchantRuleExists)` (checked after the category); the existing rule is unchanged and no transaction changes.
7. `ListMerchantRules` returns all rules ordered by merchant ascending; with no rules it returns an empty slice and a nil error.
8. `DeleteMerchantRule(id)` removes that rule (later `ListMerchantRules` omits it) and changes no transaction's category; an unknown id returns an error satisfying `errors.Is(err, store.ErrMerchantRuleNotFound)`.
9. `CategoryForMerchant(m)` returns `(categoryID, true, nil)` when a rule matches `NormalizeMerchant(m)` and `(0, false, nil)` when none does.
10. `POST /merchant-rules` with body `{"merchant": "<text>", "category_id": N}` that creates a rule returns 201, `Content-Type: application/json`, and `{"rule": {"id": <id>, "merchant": "<normalized>", "category_id": N}, "applied_to": <count from criterion 3>}`. Unknown extra JSON fields are ignored.
11. A body that is not valid JSON — including trailing data after a valid JSON value (`{"merchant":"x","category_id":1} trailing`, `{...}{}`), an empty body, a JSON value that is not an object (`[]`), or a field of the wrong JSON type (`"merchant": 5`, `"category_id": "2"`, `"category_id": 1.5`) — returns 400 `{"error": "invalid JSON"}`.
12. A body whose `merchant` is missing, `null`, empty or whitespace-only returns 400 `{"error": "merchant is required"}`; this is checked before `category_id`.
13. A body whose `category_id` is missing or `null` (with a valid merchant) returns 400 `{"error": "category_id is required"}`.
14. A `category_id` that is 0, negative or matches no category returns 400 `{"error": "unknown category"}`.
15. A merchant that already has a rule (after normalization, e.g. `"AMAZON "` after `"amazon"`) returns 409 `{"error": "merchant rule already exists"}`; any other store error returns 500 `{"error": "failed to create merchant rule"}`. Rejected requests store nothing and change no transaction.
16. `GET /merchant-rules` returns 200, `Content-Type: application/json`, and a JSON array of rules (`id`, `merchant`, `category_id`) ordered by merchant ascending; with no rules the body is `[]`, not `null`. A store error returns 500 `{"error": "failed to list merchant rules"}`.
17. `DELETE /merchant-rules/{id}` returns 204 with an empty body for an existing rule; a non-integer `{id}` returns 400 `{"error": "invalid merchant rule id"}`; an unknown id returns 404 `{"error": "merchant rule not found"}`; any other store error returns 500 `{"error": "failed to delete merchant rule"}`.
18. `POST /transactions/import` gives a row whose normalized merchant has a rule the rule's category instead of the keyword categorizer's (e.g. a rule `"amazon"` -> Groceries makes `"AMAZON "` rows Groceries, not Shopping); rows without a matching rule are categorized exactly as before, and the `imported`/`skipped` counts keep their meaning.
19. After a rule is deleted, later imports categorize that merchant with the keyword categorizer again.

## Risks

- Case-insensitive matching: SQLite `lower()` folds only ASCII; Go's
  `strings.ToLower` folds Unicode. Only ASCII behaviour is required; matching
  can be done in SQL or in Go.
- `merchant_rules.merchant` is UNIQUE; the duplicate check must still map to
  `ErrMerchantRuleExists` (check first, or translate the constraint error).
- Foreign keys are off: unknown categories must be looked up explicitly.
- Creating a rule and recategorizing should not leave a rule without its
  recategorization on error (use one transaction or check before writing).

## Open questions

None.
