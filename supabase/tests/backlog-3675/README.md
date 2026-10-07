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

Every mutant in `lib/mutants.py` must print `KILLED`.
