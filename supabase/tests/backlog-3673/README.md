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

Every mutant in `lib/mutants.py` must print `KILLED`.
