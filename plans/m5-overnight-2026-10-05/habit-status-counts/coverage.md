# Coverage: habit-status-counts

| criterion | ticket | tests |
|---|---|---|
| 1 | 001 | TestRecentStatusCounts_CountsEachStatus |
| 2 | 001 | TestRecentStatusCounts_IgnoresUnknownStatuses |
| 3 | 001 | TestRecentStatusCounts_InclusiveWindow |
| 4 | 001 | TestRecentStatusCounts_NonPositiveDays |
| 5 | 001 | TestRecentStatusCounts_InvalidDates |
| 6 | 001 | TestRecentStatusCounts_LatestLogPerDateWins |
| 7 | 001 | TestRecentStatusCounts_DoesNotModifyInput |
| 8 | 002 | TestListHabits_SetsRecentStatusCounts, TestListHabits_StatusCountsUseRequestTimezone |
| 9 | 002 | TestListHabits_StatusCountsJSON |
| 10 | 002 | TestListHabits_StatusCountsLeaveOtherFields |
