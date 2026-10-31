# BACKLOG-4007 PR-4 — database controls

Migration: `supabase/migrations/20261020180000_backlog_4007_pr4_contacts_billing_login.sql`
Rollback: `rollback-4007-pr4.sql` (restores `broker_complete_billing_setup` to the PR-1 body and
checks its md5 `aeb580b5…`, drops the functions this PR adds, deletes the ledger row).

## Run

```bash
python3 compose.py /tmp/x.sql base,login_licensed,...            # against an applied database
python3 compose.py /tmp/x.sql base --with-migration              # migration composed in front (also the re-run check)
~/.claude/bin/kt-sql /tmp/x.sql                                  # keepr-test only
```

One call = one transaction that ends in `RAISE 'P4007PR4_RESULT …'`, so nothing persists. A
mutation is an exact-once text replacement of `pg_get_functiondef` (0 or 2+ matches raise) whose
md5 must change, or the mode reports `MUTATION NOT APPLIED`.

## Results — `results-2026-10-20.txt` (SQL), `js-mutations-2026-10-20.txt` (portal code)

- base: 54 / 54 pass. 19 SQL mutants, each applied (md5 or grant change printed), each red.
- 18 JS mutants (broker jest 138 tests per run, admin vitest 6), each applied, each red.
- The PR-1 harness (`../backlog-4007`) still passes 53 / 53 on top of this migration, and its
  completion mutants still red. Its `C_BL1` now expects `billing_login_needs_someone_else`.

## Fix-up 2026-10-20 (founder e8571c1f; SR F1, F2, F3) — `results-2026-10-20-fixup.txt`, `js-mutations-2026-10-20-fixup.txt`

- The migration was amended in place (keepr-test only, never on production): `_org_contact_caller` gains
  an `it_admin` kind; the billing contact and the billing-only login stay staff/broker/admin;
  `_org_billing_contact_set` is replaced (deletes the old contact's billing-only login on a change) and
  its pre-check accepts the PR-1 body or this file's. The rollback restores both PR-1 bodies.
- base: 94 / 94, including the People matrix (6 callers x 5 operations, each cell rolled back).
- 9 new SQL mutants, each applied and red. `access_ignores_removed` reds through the new
  C_F3_unassigned_again_old_contact_no_billing (a kept, licensed login un-licensed later).

## Final fix-up 2026-10-20 (SR d0be3b9c S1/S4; founder F6 = REFUSE) — `results-2026-10-20-final.txt`

- `_org_billing_login_create` returns `has_personal_account` for a user with an active personal-org
  membership. Trigger `guard_billing_login_personal_account` (BEFORE UPDATE OF user_id) refuses claiming a
  billing-only invitation for that user, so the personal membership is not retired.
- `set_member_license` replaced (same signature, live md5 39e4d29c pinned by the pre-check): 'assign'
  clears `provisioning_metadata.billing_only`. The rollback restores the 39e4d29c body.
- base: 101 / 101. 5 new SQL mutants and the 26 earlier ones, each applied and red.
