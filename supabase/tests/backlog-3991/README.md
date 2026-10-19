# BACKLOG-3991 harness

Migration: `supabase/migrations/20261019050000_backlog_3991_idp_names_and_member_name_edit.sql`
Rollback: `rollback.sql` (drops the three functions and the ledger row).

Body md5 (`md5(prosrc)`) of this file's functions, pinned in its pre-check:

| Function | md5 |
|---|---|
| `sync_profile_names_from_idp(text,text,text)` | `18ee571b4bb9dd485032c1b98a0dd904` |
| `org_names_directory_managed(uuid)` | `99e8d288115addafe005249f42e7d4b8` |
| `set_member_name(uuid,text,text)` | `e6e1590f67f8c15f98fa32a6a94aeffb` |

After any body edit: `python3 pin_bodies.py` (re-pins), then `python3 compose.py`.

## Files

- `compose.py` writes `controls.sql`, `mutants.sql` and `dryrun.sql`, and refuses to write them
  unless every mutant anchor occurs exactly once in its function body.
- `controls.sql`: fixtures and every DB control, run against the live functions. It ends with
  `RAISE EXCEPTION`, which carries the report and rolls everything back.
- `mutants.sql`: the same fixtures. First the base run, then one subtransaction per mutant.
  Each mutant is an exact-once anchor replace of the live body, and its md5 must change. The
  report prints `MUTATION APPLIED` with both md5s and the red controls; then the subtransaction
  is undone. There are 38 body mutants, 8 grant/definer mutants and 4 guard mutants.
  - A body mutant always turns `C11 second run` red, because the guard pins this file's bodies.
    That control is left out of each mutant's catch.
- `reapply-keepr-test.sql`: keepr-test only. It drops, re-applies the file and re-writes the
  ledger row in one transaction (see Status).
- `jest-mutants.py`: the portal jest mutants (exact-once replace, numstat, `--bail=0`,
  restore verified).

Run each `.sql` on keepr-test (`xiaobikzagpyubjcrcpb`) through `execute_sql` and read the
report in the error text.

## Status (2026-10-19, keepr-test)

- Re-apply (`reapply-keepr-test.sql`): DONE. Live body md5s now match the file
  (sync `18ee571b`, gate `99e8d288`, set `e6e1590f`), ledger row `20261019050000` present.
- `controls.sql`, first run: 132 / 137. The 5 reds were harness defects, not function defects:
  - C19 x2: a `stripe_mode 'test'` org_deals row needs `organizations.is_test = true`
    (trigger guard_stripe_mode_is_test, 42501). The case now sets it inside the rolled-back case.
  - C20 x3: `proconfig::text` renders as `{"search_path=\"\""}`. The check now compares
    `proconfig = ARRAY['search_path=""']`.
- After the fixes: base 137 / 137 green (measured as the BASE line of the first mutant batch).
- Mutants, batch `S G` (21 body mutants): 21 / 21 applied and red.
- Mutants, batch `N` (17 set_member_name body mutants): 17 / 17 applied and red.
- Mutants, grant/definer (8) + guard (4): 12 / 12 applied and red. Applied is proven by the
  changed proacl / prosecdef, or the changed guard md5.
- Total: 50 / 50 applied, 50 / 50 caught. Base 137 / 137 green before every batch.
