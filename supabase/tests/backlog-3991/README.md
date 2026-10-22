# BACKLOG-3991 harness

Migration: `supabase/migrations/20261019050000_backlog_3991_idp_names_and_member_name_edit.sql`
Rollback: `rollback.sql` (drops the three functions and the ledger row).

Body md5 (`md5(prosrc)`) of this file's functions, pinned in its pre-check:

| Function | md5 |
|---|---|
| `sync_profile_names_from_idp(text,text,text)` | `984dc45b04f369274a1f003344042cae` |
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
  is undone. There are 50 body mutants, 8 grant/definer mutants and 4 guard mutants.
  - A body mutant always turns `C11 second run` red, because the guard pins this file's bodies.
    That control is left out of each mutant's catch.
- `reapply-keepr-test.sql`: SUPERSEDED, kept as the record of the first keepr-test re-apply
  (pre-skip body). Do not run it.
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

## SCIM-names skip (2026-10-19, founder decision pm_comments d48323db)

`sync_profile_names_from_idp` now skips the write (`success:true, updated:false,
skipped:'directory_managed'`) for a caller with a claimed, non-deactivated membership in an
organization with `scim_enabled`, `directory_sync_enabled`, or a live SCIM token (not revoked,
not expired). JIT, manual and solo users are unchanged. No JIT term, no caller-role term.

- keepr-test: only the `CREATE OR REPLACE FUNCTION public.sync_profile_names_from_idp` statement
  (plus its REVOKE/GRANT) was run. Live md5 `984dc45b` == this file's pin. Ledger statement for
  `20261019050000` updated to the new file md5. Production: function absent, no ledger row.
- New fixtures: k1 (scim_enabled org s), k2 (live token, no expiry, tk), k3 (directory sync, d),
  k4 (suspended in s), k5 (expired token only, te), k6 (revoked token only, tr), k7 (s + manual m),
  k8 (token with future expiry, tf). Controls C40-C47 (16).
- C19 fixture: `org_deals` insert now sets `suspended_at` (and `version`, which defaults to 1 and
  was never the cause). 20261019090000 (`_billing_enqueue_org_work`) builds
  `billing_outbox.dedupe_key` from `suspended_at`; NULL was a 23502.
- Unassigned SCIM member (SR review d00133ea): fixture k9 (`unassigned`, member of s), control C48,
  mutant K12 (skip only active members, i.e. `member_status_grants_access` in place of
  `NOT member_status_is_deactivated`; md5 `984dc45b` -> `daec2e51`). Base 154 / 154 green; K12
  applied and C48 is the only red (C11 second run excluded). K1-K11 not re-run: k9 is read only
  by C48, and a mutant's other reds come from fixtures it does not share.
- Results (before k9): BASE 153 / 153 green. Mutants K1-K11 (skip): 11 / 11 applied (md5 changed) and red.
  Mutants S1a-S10 (existing sync mutants, re-run because the body changed): 13 / 13 applied and red.
- `rollback.sql` is unchanged: it still removes the three functions and the ledger row.
