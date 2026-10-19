# BACKLOG-3993 — admin_invite_user cross-organisation duplicate check

Migration: `supabase/migrations/20261019010000_backlog_3993_unlicensed_duplicate_invite.sql`
Rollback: `rollback-3993.sql`

`admin_invite_user(uuid,text,text,uuid,text,uuid)` body md5 (`md5(pg_get_functiondef)`):

| Body | md5 |
|---|---|
| before (keepr-test and production, 2026-10-18) | `6c7f379eab8423c17ca23e4f44b99ad6` |
| after this migration | `7b4795fa1c14779c2336b909a5ea3ed1` |

## Files

- `controls.sql` — one DO block, fixtures + 12 controls, ends with `RAISE EXCEPTION` carrying the report (self-rolled-back).
- `mutants.sql` — the same fixtures and controls, run once per mutant of the live body. Each mutant runs in its own subtransaction. It counts only when its anchor occurs exactly once and the md5 changed.

Run both on keepr-test (`xiaobikzagpyubjcrcpb`) through `execute_sql` and read the report in the error text.

## Results, keepr-test, 2026-10-18

| Control | Before (6c7f379e) | After (7b4795fa) | M1 org→'pending' | M1b ind→'pending' | M2 org no user_id | M2b ind no user_id |
|---|---|---|---|---|---|---|
| C0 fresh address, org path → success | PASS | PASS | | | | |
| C1 unassigned unclaimed in A, invite to B → duplicate | **FAIL** | PASS | RED | | | |
| C2 pending in A, invite to B → duplicate | PASS | PASS | | | | |
| C3 claimed member in A (unassigned, user set) → success | PASS | PASS | | | RED | |
| C4a expired pending in A → duplicate (today's behaviour) | PASS | PASS | | | | |
| C4b expired unassigned in A → duplicate (same as C4a) | **FAIL** | PASS | RED | | | |
| C5 unassigned in A revoked (row deleted) → success | PASS | PASS | | | | |
| C6 unassigned in A, mixed case + spaces → duplicate | **FAIL** | PASS | RED | | | |
| C7 unassigned in A, individual path → duplicate | **FAIL** | PASS | | RED | | |
| C8 pending in A, individual path → duplicate | PASS | PASS | | | | |
| C9 fresh address, individual path → success | PASS | PASS | | | | |
| C10 claimed member in A, individual path → success | n/a (added after the base run) | PASS | | | | RED |

Mutant md5s: M1 `d0f0b0e8…`, M1b `6f119e27…`, M2 `cafdebb8…`, M2b `89c11942…`. Each was printed as `MUTATION APPLIED`. The live md5 after the mutant run was still `7b4795fa…`.

Rollback: ran `rollback-3993.sql` inside a block that undoes itself. The body md5 afterwards was `6c7f379e…`, the before body.
