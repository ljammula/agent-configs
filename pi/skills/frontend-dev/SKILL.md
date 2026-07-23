---
name: frontend-dev
description: >
  Flutter frontend development discipline for DayTrix: red/green TDD with bloc and
  widget tests, correct state-management choice (BLoC vs ChangeNotifier), l10n keys
  in all .arb files, list-ordering stability tests, golden refresh, and visual
  verification via local preview before claiming a UI change works. Trigger when
  writing or changing anything under frontend/lib/ — widgets, screens, blocs,
  notifiers, navigation.
user-invocable: false
---

# Frontend Dev — Flutter

Practices distilled from this project's fix-commit history plus current agentic
engineering patterns (red/green TDD, run-tests-first, verify visually — don't assume).

## 1. Red/green TDD — the test is the spec

Write the failing test **before** the implementation, watch it fail, then make it pass.
Tests written after the code get bent to match the code (this produced
"fix: expect ReminderRestored" — a test adjusted to wrong behavior).

```bash
cd frontend && flutter test test/features/<feature>/ -r expanded   # red first
# implement
cd frontend && flutter test --concurrency=4                        # green, full suite
```

- Bloc behavior → `bloc_test` with explicit `expect:` event/state sequences.
- Widget behavior → `testWidgets` driving the actual gesture (`tester.tap`), not just pumping state.

## 2. State management — match the existing pattern

- **BLoC** (`flutter_bloc`): checklists, reminders, chat.
- **ChangeNotifier**: notes, routines, habits, mood, household, saved items.

Do not introduce a new pattern for a feature; extend whichever its area already uses.

## 3. List interactions — test ordering and identity

Check-off / reorder / undo flows have needed multiple fix commits (habit re-sort,
tapping one habit checking another). For any list mutation:

- Write a test asserting **which item** was affected (by id, not index).
- Write a test asserting the **list order after** the interaction (stable vs re-sorted —
  read the spec for which is intended).
- Keys: interactive list tiles need `ValueKey(item.id)` so taps hit the right row after re-sorts.

## 4. Localization — no hardcoded user-facing strings

Every string a user sees goes through l10n and into **every** `.arb` file — including
snackbars, error messages, and empty states, the three repeat offenders. Verify with
the shared script rather than by eye:

```bash
~/.pi/agent/skills/before-done/scripts/check-l10n.sh
```

## 5. Feature gating

UI for a gated feature checks its `FeatureFlagsController` getter / `app_config.dart`
flag. Adding gated UI without the guard breaks non-granted accounts.

## 6. Verify visually — never claim a UI change works unseen

After any change under `frontend/lib/`:

```bash
make serve-local
BASE_URL=http://localhost:3000 npx playwright test \
  --config=playwright.local.config.js e2e/local-preview.spec.js
```

Read the screenshots in `test-results/preview-*.png` before reporting done.
A passing test suite is not visual confirmation.

## 7. Goldens and format

- Widget changes: `flutter test --update-goldens test/features/<feature>/`, then full suite clean.
- `dart format lib test` (or `make fmt`) before committing — new test files are the usual miss.

## Done means

Red test written → green → full suite passes → l10n complete → preview screenshots
verified → `make verify` clean. Then the `before-done` gate.
