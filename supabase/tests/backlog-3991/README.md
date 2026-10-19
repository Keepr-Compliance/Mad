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

## Status (2026-10-19)

- First keepr-test apply: done. The file and its ledger row went in one call. The body md5s
  were `73d9e667…` (sync), `99e8d288…` (gate) and `1dfeac62…` (set).
  - The trim set had been sent as `\u` escapes. In transit they became raw characters.
  - Behaviour is the same, but the bodies did not match the file.
  - The file now builds the set with `chr()`, so every channel sends the same body.
- Re-apply (`reapply-keepr-test.sql`): NOT RUN. The call came back
  `Invalid or expired requestState` and was not retried.
- `controls.sql` / `mutants.sql`: NOT RUN on keepr-test yet. They wait on the re-apply.
