# BACKLOG-3846 harness

Controls and mutants for `supabase/migrations/20261012100000_backlog_3846_unsuspend_regrant_and_audit_actor.sql`
and `rollback-3846.sql`. Every run is one transaction ending in ROLLBACK.

Order per run: the 3845 helpers and fixtures (`../backlog-3845/lib`), the 3845 migration (idempotent)
and its post-apply step, `lib/prod-bodies.sql` (production bodies and grants of the functions the
controls call, md5-checked against production), `lib/fixtures-3846.sql`, the 3846 migration (or a
mutant), then the control.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
```

| Control | What it proves |
|---|---|
| u01 / u02 / u03 | unsuspend through each writer (admin_unsuspend_user, reinstate_suspended_account, admin_update_license), called as an internal user, restores Unlimited to current_period_end + 2 h |
| u04 / u05 / u06 | period over, paused, past_due -> nothing granted |
| u07 | the grant raises -> the unsuspend still succeeds |
| u08 | trigger function: no client EXECUTE, DEFINER, pinned search_path; one trigger with the suspended -> active WHEN |
| u09 | suspended -> cancelled grants nothing |
| u10 | refused grant (support override) -> unsuspend succeeds, override untouched |
| u11 | other licence writes and suspending grant nothing |
| k01 | dispute suspension as the service role succeeds, actorless audit row, replay deduped, reinstatement re-grants |
| k02 | log_admin_action: anon refused, owner role with anon claims refused, signed-in user and service role accepted |
| k03 | EXECUTE grants and actor_id nullability |
| k04 / k05 / k06 | apply twice; rollback restores production; a drifted log_admin_action stops the migration |

Venue: NAS `keepr-test` (PostgreSQL 17.6). It predates 3845 and three function bodies there differ
from production (`admin_update_license`, `reinstate_suspended_account`, `suspend_account_for_dispute`);
`lib/prod-bodies.sql` replaces them inside the run and checks every body a control relies on.
