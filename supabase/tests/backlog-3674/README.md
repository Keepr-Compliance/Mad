# BACKLOG-3674 database controls

Runs the `users.tour_dismissed_at` migration against a test database (the NAS
`supabase_db_keepr-test` container), one transaction per control, always
ending in `ROLLBACK`. Nothing is committed.

The test database may be behind production. Every control therefore layers the
3673 and 3714 migrations from the repo (unchanged) before 3674, so the starting
state is production's: authenticated holds UPDATE on 16 named columns of
`public.users`, anon on none.

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash supabase/tests/backlog-3674/run.sh controls
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash supabase/tests/backlog-3674/run.sh mutants
```

| Control | Checks |
|---|---|
| d0 | before 3674 (3673 + 3714 applied): no column, authenticated UPDATE 16 columns, anon 0 |
| d1 | the column is nullable `timestamptz`, no default, commented; existing rows stay null |
| d2 | authenticated UPDATE = 17 columns (3714's 16 + `tour_dismissed_at`, nothing else); anon UPDATE 0; SELECT/INSERT/REFERENCES cover every column for both roles |
| d3 | the app's write as a signed-in user: own row 1 row; a second write 0 rows and the first value kept; another user's row 0 rows; anon `42501` |
| d4 | applying twice is a no-op |
| d5 | rollback then re-apply works, and the own-row write works again |
| d6 | rollback returns to 3714's state (no column, authenticated UPDATE 16) |

`lib/harness.sql` holds the app's write as `pg_temp.app_dismiss()` (the SQL
PostgREST runs for `supabaseService.dismissTour`), so a mutant can replace it.

## Reading the output

`controls` ends with `CONTROLS: pass=X fail=Y error=Z` (one count per control
file) and exits 0 only when every control passes. `ERROR` means psql failed
(fixture, syntax, a raise) or the control produced no checks: the control
proved nothing, which is not the same as `FAIL`.

`mutants` first runs every control against the unmutated migration and stops,
running no mutant, unless all of them pass. Each mutant is then:

| Verdict | Meaning |
|---|---|
| `KILLED` | at least one target control reported an assertion `FAIL`, and none errored |
| `SURVIVED` | every target control passed |
| `INVALID` | a target control errored, so the run says nothing about the mutant |

The run ends with `MUTANTS: killed=X survived=Y invalid=Z` and exits 0 only
when every mutant is `KILLED`. The verdict logic is `mutants.py classify`;
`python3 lib/test_mutants.py` checks it without a database.
