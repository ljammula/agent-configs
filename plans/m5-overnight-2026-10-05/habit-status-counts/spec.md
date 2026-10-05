# Spec

## Problem

`GET /api/v1/habits` reports a streak, a consistency score and the raw
`recent_logs`, but not how the last month went by outcome. The habits screen
wants a one-line summary ("last 30 days: 18 done · 3 skipped · 2 rest · 1
missed") without every client re-deriving it from `recent_logs` with its own
rules for legacy logs, duplicates and time zones.

## Scope

- `domain.HabitStatusCounts` (`done`, `skip`, `rest`, `fail`) and the field
  `HabitWithStreak.RecentStatusCounts` (`json:"recent_status_counts"`) —
  already added in `backend/internal/domain/habit.go`.
- `recentStatusCounts(logs []domain.HabitLog, today string, days int)
  domain.HabitStatusCounts` in `backend/internal/service/habit_status_counts.go`
  (stub exists).
- `HabitService.ListHabits` (`backend/internal/service/habit.go`) fills
  `RecentStatusCounts` for every habit over the last 30 days, ending on today
  in the request's time zone (the same `today` it already uses).

Status rules: a log's `Status` of `""` (legacy logs) or `"done"` counts as
done; `"skip"`, `"rest"`, `"fail"` count as themselves; any other value
(including different case, e.g. `"DONE"`) is not counted. A date counts at
most once: when several logs share a date, the one with the latest
`LoggedAt` decides that date's status (equal `LoggedAt`: the one later in
the slice).

## Non-goals

- A new endpoint or query parameter (the window is fixed at 30 days).
- Changing streaks, consistency score, `recent_logs` or any other field.
- Frontend changes.
- Firestore repository changes (`ListHabits` already loads 90 days of logs).

## Affected services and packages

- backend/internal/service (`habit_status_counts.go`, `habit.go`)
- backend/internal/domain (`habit.go`, already done in the bundle commit)

## Acceptance criteria

1. `recentStatusCounts` counts each counted date's status into `Done`, `Skip`, `Rest` or `Fail`, with `""` and `"done"` both counting as `Done`.
2. Logs whose status is anything else (`"partial"`, `"DONE"`, `"Skip"`) are not counted.
3. The window is inclusive: with `days = 30`, dates from `today - 29` through `today` count; `today - 30` and any date after `today` do not. With `days = 1` only `today` counts.
4. `days <= 0` returns all-zero counts.
5. Logs whose `Date` is not a valid `YYYY-MM-DD` date (`"bad"`, `""`, `"2026-5-1"`, `"2026-02-30"`) are ignored; an invalid `today` returns all-zero counts.
6. When several logs share a date, only the one with the latest `LoggedAt` counts (equal `LoggedAt`: the later one in the slice); if that log's status is not counted (criterion 2), the date counts nothing.
7. `recentStatusCounts` does not modify the input slice (order and contents unchanged).
8. `ListHabits` sets `RecentStatusCounts` on every returned habit to `recentStatusCounts(logs, today, 30)` for that habit's logs, where `today` is the request time zone's current date; a habit with no logs gets all zeros.
9. The JSON of a listed habit contains `"recent_status_counts": {"done": n, "skip": n, "rest": n, "fail": n}`, with zero counts present (not omitted).
10. All other `ListHabits` fields keep their current values (streak, consistency score, recent logs, labels), and an invalid time zone still returns `domain.ErrInvalidTimezone`.

## Risks

- `time.Parse("2006-01-02", ...)` rejects `"2026-5-1"` and `"2026-02-30"`;
  compare parsed dates, not strings, for the window.
- Time zones: `ListHabits` computes `today` with `strictLocalDateFor(tz)`;
  reuse that value, do not recompute in UTC.
- Do not sort the caller's slice in place (criterion 7).

## Open questions

None.
