# BACKLOG-3858 harness

Controls and mutants for
`supabase/migrations/<version>_backlog_3858_personal_orgs_for_licensed_users.sql`
(every licensed, non-suspended user with no `organization_members` row gets a personal organization from
`public._ensure_personal_organization_for`) and for `rollback-3858.sql`.

Every run is one transaction ending in ROLLBACK; nothing is committed. Order per control:
`lib/harness.sql`, `lib/fixtures.sql` (synthetic users, prod-shaped default plan, a brokerage,
a desktop-made personal org; asserts the venue holds the production function body), optional
hooks, the migration (or a mutant), optionally a second apply and the rollback, the control.
The migration and the rollback run through `pg_temp.run_step`, so a raise becomes a FAIL.

```
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh mutants
```

| Control | What it proves |
|---|---|
| k1 | 0 licensed, non-suspended users without a membership; each cohort user (individual, team, expired invite) has exactly one membership, in their own personal org; all four recorded in the bookkeeping table |
| k2 | each created org / plan row / member row equals the desktop-made one (`ensure_personal_organization()` as the user) and the values transcribed from production personal orgs |
| k3 | active, pending and suspended brokerage members, the desktop-made personal org, the no-licence user and the expired invite row are unchanged; exactly four new orgs |
| k4a | a second apply raises nothing and writes nothing |
| k4b | rollback returns organizations, members, plan rows, checklist templates and items to the pre-run state; the desktop-made org is kept; bookkeeping table dropped |
| k4c | rollback refuses, writing nothing, when a recorded org's plan row gained feature_overrides |
| k4d | rollback refuses, deleting nothing, when a created org holds a user-written checklist template or a transaction submission |
| k4e | rollback refuses when a seeded checklist item was edited after seeding |
| k5a | non-empty cohort + changed function body -> the file raises before writing |
| k5b | empty cohort + changed function body -> no-op (a database reset never fails here) |
| k6 | checklist seeding fires once per new plan row; bookkeeping table has RLS and no client grants |
| k7 | any status other than `created` (here `attached`) aborts the whole file, naming user and status |
| k8 | users suspended by licence status or by user status get no membership, no org, no bookkeeping row |

Mutants (`lib/mutants.py`, each pattern must match exactly once): m01-m10 (m09a-c) on the migration,
r01-r05 on the rollback; every one must be KILLED.
Output: `CONTROLS: pass=X fail=Y error=Z`, `MUTANTS: killed=X survived=Y invalid=Z`.
