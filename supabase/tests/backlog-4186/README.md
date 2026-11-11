# BACKLOG-4186 PR A harness: sender rule set admin reads

keepr-test only. `kt-sql` refuses the production ref.

| Script | What it does |
|---|---|
| `run.sh` | One transaction: drop the two read functions, apply the migration twice, run `controls.sql`, end in RAISE (nothing persists). Prints `P4186_RESULT`. |
| `mutate.py <mode>\|all` | Exact-string mutation of the migration (or rollback) file, prints `MUTATION APPLIED` and the changed lines, runs the controls, restores with `git checkout --`. Commit first. |
| `rollback-4186.sql` | Drops both functions and the `schema_migrations` row. |

The functions are dropped before each run because `CREATE OR REPLACE` keeps an existing
function's ACL. Without the drop, a mutation that removes a REVOKE cannot red once the migration
is applied on keepr-test for real.

`R1w_readers_cannot_write_4175` exercises the unchanged 4175 write functions (editor and viewer
get 42501 on publish / pin / revert_all). It is not a write-gate control; those mutations live in
`supabase/tests/backlog-4175`.

`R6_pin_inner_join` is an equivalent mutant: `sender_rule_set_pins.org_id` has an
`ON DELETE CASCADE` FK, so a pin's org always exists and LEFT and INNER JOIN return the same rows.

Results: `results-2026-11-09.txt`.
