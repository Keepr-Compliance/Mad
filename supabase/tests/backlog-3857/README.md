# BACKLOG-3857 database controls

Runs `20261010145745_backlog_3857_no_trial_license_type.sql` against a test
database (the NAS `supabase_db_keepr-test` container, at the production schema:
ledger head `20261004232511`). One transaction per control, always ending in
`ROLLBACK`. Nothing is committed. Fixtures are synthetic rows created inside
each run (an internal-role user, an individual and a team license, two users
without a license); license column values are transcribed from production row
shapes (see `lib/fixtures.sql`).

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test \
  bash supabase/tests/backlog-3857/run.sh controls
# same env:
  bash supabase/tests/backlog-3857/run.sh mutants
```

| Control | Checks |
|---|---|
| c0 | before the migration: the CHECK, the four defaults, `admin_update_license`'s body md5 and its ACL equal production |
| c2 | `admin_update_license` with `license_type: 'trial'` (alone, and mixed with a status change) raises SQLSTATE `22023` — the CHECK alone would give `23514` |
| c3 | `service_role` UPDATE / INSERT of `'trial'` raise `23514`; CHECK is `('individual','team')` and validated |
| c4 | INSERT of only `user_id, license_key` gives `individual` and NULL `trial_status` / `trial_started_at` / `trial_expires_at` (one check per column) |
| c5 | other license_type and status changes still apply and are audited; a caller without an internal role is still refused |
| c6 | with a `'trial'` row present, the migration aborts on its own pre-check and changes nothing |
| c7 | applying twice: same end state; ACL / SECURITY DEFINER / search_path unchanged |
| c8 | rollback restores the CHECK, the defaults and the production body (md5) |
| c10 | `anon` calling `admin_update_license` gets 42501; authenticated and service_role keep EXECUTE; PUBLIC has none |
| c9 | an `admin_update_license` body that is neither production's nor this migration's makes the migration abort |

`rollback-3857.sql` is the rollback; c8 runs it.

## Reading the output

`controls` ends with `CONTROLS: pass=X fail=Y error=Z` and exits 0 only when
every control passes. `ERROR` means psql failed or the control produced no
checks.

`mutants` first runs every control against the unmutated migration and runs no
mutant unless all pass. Each mutant is an exact-string replacement that must
match exactly once (`lib/mutants.py`); its applied diff is printed after
`MUTATION APPLIED:`. Verdicts: `KILLED` (a target control FAILed, none
errored), `SURVIVED`, `INVALID` (a target control errored).

`control-run.txt` and `mutant-run.txt` are the recorded runs.
