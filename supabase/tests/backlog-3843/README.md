# BACKLOG-3843 harness

Controls and mutants for `supabase/migrations/20261010100000_backlog_3843_org_member_client_write_lockdown.sql`.

Every run is one transaction ending in ROLLBACK; nothing is committed. Layering per control:
3679 + 3538 + 3843 helpers and fixtures, the 3679 migration, 3538 preconditions, the 3538 migration,
`lib/preconditions-3843.sql` (the guard definition equals production's), `fp_before`, the 3843
migration (or a mutant), the control. Client-path statements run through `pg_temp.as_role` /
`pg_temp.as_user`: `SET ROLE authenticated` (or `anon`) with `request.jwt.claims` carrying `sub`,
`role` and `email`.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh precheck   # read-only venue check
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants
```

| Control | What it proves |
|---|---|
| k21 | org admin UPDATE of `organizations.max_seats` (alone, and mixed with an allowed column) refused by the guard; row unchanged |
| k22 | every `organizations` column not on the allow-list, read from the catalogue at run time (17), refused by the guard |
| k23 | retention, JIT, admin-consent and `updated_at` writes succeed as `authenticated` and are stored |
| k24 | service_role / postgres updates, service-role deactivate and insert, `auto_provision_it_admin()` and `jit_join_organization()` still work |
| k25 | internal staff who is also an org admin gets no exemption (org update, member licence status, member insert) |
| k26 | org admin can no longer change `license_status` (incl. reactivation over the seat limit) or other locked member columns |
| k27 | role edit, bulk role, resend invite, remove still work |
| k28 | invitee claim of a pending invite works (joined_at = now()); claim of an unclaimed suspended row refused |
| k29 | client INSERT limited to the invite shape, within the seat limit (both sides of the boundary) |
| k30 / k31 | apply twice; `rollback-3843.sql` restores the pre-3843 fingerprint and behaviour |
| K10 | backlog-3679 k03-k08, k99 and backlog-3538 k11-k14 run unchanged on top. 3679 k02 is not re-run: its "admin Deactivate succeeds" check is the behaviour this change removes (k26/k27 cover it). |

`mutants` runs every control on the unmutated file first, then each mutant in `lib/mutants.py`
(each edit must match exactly once, else `apply` raises). Exit 0 only when every mutant is KILLED.
