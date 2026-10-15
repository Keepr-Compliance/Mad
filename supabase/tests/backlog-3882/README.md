# BACKLOG-3882 database controls

Runs `20261010165424_backlog_3882_tenant_from_identity.sql` against a test
database (the NAS `supabase_db_keepr-test` container, production schema, ledger
head `20261004232511`). One transaction per control, always ending in
`ROLLBACK`. Fixtures are synthetic users, `auth.identities` rows and
organizations created inside each run; their key shapes are transcribed from
production (keys only, see `lib/fixtures.sql`), their values are invented.

```bash
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash supabase/tests/backlog-3882/run.sh controls
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash supabase/tests/backlog-3882/race.sh
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash supabase/tests/backlog-3882/run.sh mutants
```

Callers run as `authenticated` (or `anon`) with `request.jwt.claims` set the
way PostgREST sets it.

| Control | Checks |
|---|---|
| c0 | before the migration: both bodies' md5 and EXECUTE grants equal production; body behaviour equals production's (success and role for a caller whose tenant differs from the org's) |
| c1 | caller's identity tenant differs from `p_tenant_id`, org exists: 42501, no membership, no `public.users` row |
| c2 | same, no org exists: 42501, no org created |
| c3 | user metadata tenant altered to the requested one, identity unchanged: 42501 |
| c4 | upper-case / padded tenant matches; org stored under the identity's value; colleague joins the same org |
| c5 | an azure `provider_id` or a google `sub` passed as tenant: 42501, no org |
| c6 | personal-Microsoft-account tenant with a matching identity: 42501 |
| c7 | second apply succeeds; new body md5; PUBLIC/anon lose EXECUTE, authenticated/service_role keep it; anon call 42501; definer/config unchanged |
| c8 | first-user-wins with matching identities: first caller admin, next colleague default role, unclaimed invites not counted, existing admin unchanged |
| c9 | `auto_provision_google_it_admin`: body unchanged, only service_role may execute; authenticated call 42501 |
| c10 | `rollback-3882.sql` restores the production body and grants |
| c11 | a body that is neither production's nor the migration's makes the migration abort |
| race | `race.sh`: while a provisioning transaction is open, a second session cannot `FOR SHARE NOWAIT` the org row (the FOR UPDATE row lock is held). Commits ONE fixture org row before the run and deletes it on exit |

`mutants` first runs every control and `race.sh` against the unmutated
migration and runs no mutant unless all pass. Each mutant is a set of
exact-string replacements that must each match exactly once
(`lib/mutants.py`); its applied diff is printed after `MUTATION APPLIED:`.
Verdicts: `KILLED`, `SURVIVED`, `INVALID`.

Not mutated, and why: lower-casing the identity side of the compare, and the
`provider = 'azure'` filter. Production stores every azure tid lower-case and
no non-azure identity carries a `tid` claim, so no production-shaped fixture can
tell either change apart; both are kept as defence in depth.

`control-run.txt` and `mutant-run.txt` are the recorded runs (generated org ids
replaced with `<generated>`).
