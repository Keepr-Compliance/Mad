# BACKLOG-3675 database controls

Runs the `unlimited_transactions` feature migration against a test database
(the NAS `supabase_db_keepr-test` container), one transaction per control,
always ending in `ROLLBACK`. Nothing is committed.

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash supabase/tests/backlog-3675/run.sh controls
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash supabase/tests/backlog-3675/run.sh mutants
```

| Control | Checks |
|---|---|
| d0 | before the migration the key is absent (baseline) |
| d1 | a signed-in user cannot write the override, the plan rows or the definition |
| d2 | an override on the personal organization reads `enabled: true, source: override`; without it `false, plan` |
| d3 | applying twice leaves one definition and one row per plan |
| d4 | after the apply every plan row is off and the definition is shaped as approved |
| d5 | a member reads his organization's overrides (incl. `paid_through`); a non-member reads none |
| d6 | an override with `paid_through` is accepted and reads as enabled; removing the key revokes |
| d7 | rollback then re-apply works |
| d8 | rollback leaves no definition and no override |

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

## Fixtures

`lib/fixtures.sql` inserts the Individual plan (values transcribed from
production) when the database has none, so the controls do not depend on the
test database's seed rows. The insert rolls back with the run.
