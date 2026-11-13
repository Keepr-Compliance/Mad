# BACKLOG-4185 PR A harness: devices.hardware_profile

keepr-test only. `kt-sql` refuses the production ref.

| Script | What it does |
|---|---|
| `run.sh` | One transaction: rollback, apply the migration twice, `mutations.sql`, then `controls.sql`, ending in RAISE (nothing persists). Prints `P4185_RESULT`; exits 1 when no result or zero controls ran. |
| `mutate.py <mode>\|all` | Exact-string mutation of the migration, the rollback, or the `mutations.sql` slot. Prints `MUTATION APPLIED`, the changed lines and the numstat, runs the controls, restores with `git checkout --`. Commit first. |
| `mutations.sql` | Empty slot. A policy-state mutation (an extra UPDATE policy, a widened USING, `WITH CHECK (true)`) is DDL on the database the migration lands on, not a line of the migration, so it is applied here. |
| `rollback-4185.sql` | Drops the constraint, both columns and the `schema_migrations` row. |

The rollback runs first in `run.sh`, so the migration is measured against a table without the new
columns even after it has been applied to keepr-test for real.

Actors: two plain users and one Super Admin. The admin holds report access to `analytics`, so
`devices_select_public` lets it SELECT every device row. That is the actor an extra UPDATE policy
lets through; a plain user cannot see another user's row, so a plain-user probe stays at 0 rows
whether or not the table is guarded. F1/F2 prove the admin fixture really has that access.

`WITH CHECK`: the own-row UPDATE policy has none (`with_check IS NULL`), so Postgres re-applies
`USING` to the new row. A plain user moving a row to another user is refused by the SELECT policy
as well, so `WITH CHECK (true)` cannot red as a plain user (B7 stays 42501). The admin actor (B8)
and the `with_check IS NULL` pin (S6) catch it.

Results: `results-2026-11-10.txt`.
