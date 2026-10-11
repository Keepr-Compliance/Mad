# BACKLOG-3673 database controls

Runs the `onboarding_completed_at` write-once + backfill migration
(`20261003160000`) against a test database (the NAS `supabase_db_keepr-test`
container), one transaction per control, always ending in `ROLLBACK`. Nothing
is committed. Fixtures are three synthetic users created inside each run.

The rollback SQL is not kept in the repo. It is posted with the apply packet on
the backlog item; save it locally and pass its path.

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test \
ROLLBACK_FILE=<rollback-3673.sql> FULL_ROLLBACK_FILE=<rollback-3673-full.sql> \
  bash supabase/tests/backlog-3673/run.sh controls
# same env:
  bash supabase/tests/backlog-3673/run.sh mutants
```

| Control | Checks |
|---|---|
| c1 | before the migration: no trigger, no function; the pre-check selects only the pending fixture |
| c2 | after the apply: trigger enabled; EXECUTE revoked from PUBLIC, anon, authenticated; backfilled set = pre-check set; values = the email answer; other rows untouched |
| c3 | as `authenticated` on the own row: null→ts accepted; ts→null and ts→other ts keep the value; the app's statement on a set row updates 0 rows |
| c4 | applying twice: one trigger, one function, same values |
| c5a | data rollback: listed rows null, others unchanged, trigger re-enabled and enforcing |
| c5b | data rollback then re-apply |
| c5c | data rollback then full rollback: trigger and function gone |

## Reading the output

`controls` ends with `CONTROLS: pass=X fail=Y error=Z` (one count per control
file) and exits 0 only when every control passes. `ERROR` means psql failed
(fixture, syntax, an unexpected raise) or the control produced no checks: the
control proved nothing, which is not the same as `FAIL`; psql's error text is
printed.

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

Three expected refusals are recorded as `FAIL` checks rather than raises, so a
kill names an assertion: the second migration apply (only `duplicate_object`,
42710, is caught, label `apply-twice: second apply raised`), and the rollback
files' two data checks (`rollback verify: a listed row is still set`, `rollback
verify: an unlisted row changed`) plus the trigger and full-rollback checks.
The harness rewrites those `RAISE EXCEPTION` lines to `pg_temp.check(label,
false)` when it runs a rollback file (`rb_body` in `run.sh`); the files and
their conditions are untouched.
