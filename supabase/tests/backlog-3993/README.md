# BACKLOG-3993 — admin_invite_user cross-organisation duplicate check

Migration: `supabase/migrations/20261019010000_backlog_3993_unlicensed_duplicate_invite.sql`
Rollback: `rollback-3993.sql`

`admin_invite_user(uuid,text,text,uuid,text,uuid)` body md5 (`md5(pg_get_functiondef)`):

| Body | md5 |
|---|---|
| before (keepr-test and production, 2026-10-18) | `6c7f379eab8423c17ca23e4f44b99ad6` |
| after this migration | `7b4795fa1c14779c2336b909a5ea3ed1` |

## Files

- `controls.sql` — one DO block, fixtures + 14 controls, ends with `RAISE EXCEPTION` carrying the report (self-rolled-back).
- `mutants.sql` — the same fixtures and controls, run once per mutant of the live body. Each mutant runs in its own subtransaction. It counts only when its anchor occurs exactly once and the md5 changed.

Run both on keepr-test (`xiaobikzagpyubjcrcpb`) through `execute_sql` and read the report in the error text.

## Results, keepr-test, 2026-10-18

Base (live body 7b4795fa): all 14 controls PASS. Reds per mutant, each printed as MUTATION APPLIED with the live md5 equal to the intended mutant md5:

| Mutant | What it changes | Mutant md5 | Red controls |
|---|---|---|---|
| M1 | org path: predicate back to 'pending' only | `d0f0b0e8…` | C1, C4b, C6 |
| M1b | individual path: predicate back to 'pending' only | `6f119e27…` | C7 |
| M2 | org path: drop `user_id IS NULL` | `cafdebb8…` | C3 |
| M2b | individual path: drop `user_id IS NULL` | `89c11942…` | C10 |
| M3 | org path: new predicate without its outer parentheses | `fa368105…` | C11 |
| M3b | individual path: same, without outer parentheses | `aab82118…` | C11i |

Controls: C0 fresh address (org); C1 unassigned in A (org); C2 pending in A (org); C3 claimed member in A (org, allowed); C4a/C4b expired pending/unassigned in A (org, still refused); C5 revoked (org, allowed); C6 mixed case + spaces (org); C7 unassigned in A (individual); C8 pending in A (individual); C9 fresh address (individual); C10 claimed member (individual, allowed); C11/C11i unclaimed 'unassigned' invite in A for a different address, fresh address invited (org / individual, allowed).
Before this migration (6c7f379e) C1, C4b, C6 and C7 fail.
The fixture deletes pre-existing unclaimed 'pending'/'unassigned' rows inside the rolled-back run, so results do not depend on leftover test data. The live md5 afterwards was `7b4795fa…` and no fixture rows remained.

Rollback: `rollback-3993.sql` restores the before body and, in its last block and the same transaction, deletes the `20261019010000` ledger row if the ledger table exists. The rollback as a whole, including its ledger-delete block, has NOT been run. Only the function-body restore was measured earlier: after restoring, the body md5 was back to `6c7f379e…`, the before body.
