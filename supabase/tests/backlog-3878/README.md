# BACKLOG-3878 harness

Controls and mutants for `supabase/migrations/20261013170000_backlog_3878_licence_pause_resume.sql`
and `rollback-3878.sql`. Every run is one transaction ending in ROLLBACK.

Order per run: the 3845 helpers and fixtures (`../backlog-3845/lib`), the 3845 migration (idempotent)
and its post-apply step, the 3846 production bodies (`../backlog-3846/lib/prod-bodies.sql`, md5-checked
against production; the five licence writers' md5s re-read from production 2026-10-13 and unchanged)
and fixtures, the 3846 migration (so `billing_regrant_on_unsuspend` is present, SR R9),
`lib/fixtures-3878.sql`, the 3878 migration (or a mutant), then the control.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
```

| Control | What it proves |
|---|---|
| w01 / w02 / w03 | suspension through each writer (admin_suspend_user, suspend_account_for_dispute as the service role, admin_update_license) -> exactly one pause row in the customer's mode; a dispute replay adds nothing |
| w04 / w05 / w06 | reinstatement through each writer (admin_unsuspend_user, reinstate_suspended_account, admin_update_license) -> one resume row |
| w07 | no stripe_customers row -> no row (a mirror row alone does not enqueue) |
| w08 | customer row without a mirror row -> a pause row (SR R6) |
| w09 | other columns, active -> active, active -> expired -> active, suspended -> suspended -> nothing |
| w10 | suspended -> expired / cancelled -> no resume row (SR R9) |
| w11 | two cycles in one transaction -> 2 pause + 2 resume rows, 4 distinct keys (SR R9) |
| w12 | NULL -> suspended -> one pause row (SR R9) |
| w13 | a customer in each mode -> one row per mode |
| w14 | the outbox insert raises -> the suspension and reinstatement still land, no row |
| w15 | catalog: no client EXECUTE, DEFINER, pinned search_path, trigger WHEN, both licence triggers |
| w16 | with the 3846 trigger: mirror paused -> no regrant, one resume row; mirror unpaused -> regrant once, resume row still written (SR R9 / C9) |
| k01 / k02 | apply twice; rollback removes this trigger and keeps the 3846 one |

Venue: NAS `keepr-test` (PostgreSQL 17.6), which predates 3845; the run applies 3845 and 3846 itself.
