# BACKLOG-3998 harness

Migration: `supabase/migrations/20261016070000_backlog_3998_users_email_from_auth.sql`
Rollback: `rollback.sql` (drops the three triggers and four new functions, drops the update
policy's WITH CHECK, restores `handle_new_user` / `admin_add_internal_user` to md5
`64c98e28` / `058aebe4`; previous email values are not restored).

Body md5 (`md5(prosrc)`), pinned in the migration's pre-check:

| Function | md5 |
|---|---|
| `users_email_from_auth()` | `eb762a864ef17d09fa0e6351fbdd8468` |
| `users_client_write_guard()` | `22a40e688af40dc838879df00f4e7133` |
| `users_own_oauth_pair()` | `6d37e0a6759c880f2e2b7d3d1a3a9808` |
| `user_id_for_auth_email(text)` | `a6eb9a7dedf1edfe381f544a16cc6f9a` |
| `sync_email_from_auth()` | `8dde26ff3b2c18b19c4e27ecb424025e` |
| `handle_new_user()` | `d29adc102b649c9d53f754725feb66b3` |
| `admin_add_internal_user(text,text)` | `d104c223d7e75ee270540b044203e9cd` |

After any body edit: `python3 pin_bodies.py` (re-pins this migration and the 3991 pre-check's
`handle_new_user` entry), then `python3 compose.py`.

## Files

- `compose.py` writes `controls-<n>.sql` (at most 10 controls each), `mutants-<n>.sql` (at most
  15 control runs each, BASE first) and `c14-rollback-reapply.sql`. It refuses to write them
  unless every body-mutant anchor occurs exactly once in the migration's function body.
- Every file ends with `RAISE EXCEPTION` carrying the report, so nothing persists. Each control
  runs in its own subtransaction. Run on keepr-test with `~/.claude/bin/kt-sql <file>` and
  read the report in the error text.
- Body mutants replace an anchor in the live definition (exact-once, checked again in SQL) and
  require `md5(prosrc)` to change; state mutants (grant, SECURITY DEFINER, trigger, policy)
  require the probe query's value to change. Both print `MUTATION APPLIED`.
- `jest-mutants.py`: the code mutants (exact-once replace, `git diff --numstat`, `--bail=0`,
  non-zero test count, byte-for-byte restore verified).

## Results (2026-10-19, keepr-test)

- Apply: migration + ledger row `20261016070000` + 3991 ledger statement. Live md5s equal the
  pins above. `users_own_oauth_pair` was then re-applied alone after its provider filter was
  added (ledger statement updated to file md5 `c991a57c`).
- Controls: 31 / 31 green (C1, C2, C2b, C4-C8, C11, C11b, C12, C13, C13b, C15-C30).
  First-run reds were harness defects, fixed: `session_replication_role` not settable (stale
  values are now written with the email trigger disabled inside the control's subtransaction);
  C19 compared booleans as `true` where `concat_ws` renders `t`; C21's SSO fixture used a
  provider the users table's check constraint refuses.
- C14 (rollback, re-apply, read-back): md5s after re-apply equal the pins.
- Body mutants: 42 applied; 41 red (M24: pair kept but the reset also runs on client UPDATE, reds only C29; M25: first of several unclaimed rows, reds only C30). M14 (metadata email restored in `handle_new_user`) stays
  green: the email trigger replaces the value on the same insert. Equivalent mutant.
- State mutants: 8 applied; 6 red. S3 (update policy without WITH CHECK) stays green: with no
  WITH CHECK, Postgres applies the policy's USING expression to the new row, so the id move is
  refused either way; the explicit WITH CHECK states the same rule. S7 (email trigger without
  `OF id`) stays green: the id move is refused by the policy first.
- Code mutants (`jest-mutants.py`): 8 / 8 applied and red (J8: SCIM lookup error not checked).
