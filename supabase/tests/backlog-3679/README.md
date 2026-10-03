# BACKLOG-3679 harness — invite acceptance on organization_members

Migration: `supabase/migrations/20261003100000_backlog_3679_invite_accept_policy.sql`
Rollback:  `rollback-3679.sql`

```bash
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
```

Each control runs in one transaction ending in `ROLLBACK`: `lib/harness.sql`,
`lib/fixtures.sql`, a catalogue fingerprint, the migration (or a mutant of it),
then the control. Client calls run as `authenticated` / `anon` / `service_role`
with `request.jwt.claims` set. Fixture ids are derived from names
(`pg_temp.id('<name>')`, or `{<name>}` inside a statement passed to
`pg_temp.as_role`), so no id literal is committed. The run exits 1 on any `FAIL`, and on a control
that produced zero checks.

| control | what it proves |
|---|---|
| k01 | baseline (migration NOT applied): admin Edit role and Resend invite, and the sign-in callback's acceptance, fail for signed-in users |
| k02 | broker-portal admin actions with their exact column sets work: Edit role, Bulk role (with RETURNING), Deactivate, Resend invite; an admin of another org is refused |
| k03 | the sign-in callback's exact statements accept the invite: the lookup finds it, the UPDATE links it, role/org unchanged, token cleared, personal membership retired by the existing trigger |
| k04 | an invitee cannot change role, organization, license status (other than to active), token (other than to NULL), expiry, invited_by, metadata or invited_email, nor link another user; cross-policy cases for a user who is admin of another org |
| k05 | a user whose email does not match sees and changes nothing; anon changes nothing |
| k06 | expired invites are neither visible nor acceptable (including by an UPDATE with no WHERE); email match ignores case and surrounding spaces |
| k07 | `claim_pending_invite()`, service_role and postgres writes are unaffected |
| k08 | no client role reads `auth.users`, no policy on the table reads it, the guard function is not client-executable, and the guard still refuses with `auth.users` opened to the caller |
| k09 | applying the migration twice leaves one trigger and four policies |
| k10 | after `rollback-3679.sql` the catalogue fingerprint equals the pre-migration one and pre-migration behaviour is back |
| k99, k99b | client-role updates keep `organization_id` unchanged |

## Mutants (`lib/mutants.py`)

Exact-string replacements; `apply` exits non-zero when the pattern does not
occur exactly once, and `run.sh` prints `MUTATION APPLIED` with the changed line.

Single mutants: 13 of 20 killed; compound mutants: 3 of 3 killed. Each single
survivor is a check that another layer also enforces. Where both layers are in
this migration's guard or policies, a compound mutant removes them together and
is killed, so the controls do see the property:

| survivor | other layer | compound, killed by |
|---|---|---|
| `m12-no-link-self-check` | accept policy WITH CHECK `user_id = auth.uid()` | — (policy layer; not a guard-only property) |
| `m13-guard-allows-claimed-rows` | no UPDATE policy reaches a claimed row for a non-admin | — (policy layer) |
| `m16-no-org-lock` | admin branch requires an unchanged organization; column diff | `c18` → k99 |
| `m17-admin-org-condition-dropped` | organization lock | `c18` → k99 |
| `mA-guard-uses-NEW-org` | organization lock (OLD and NEW organization are equal on every row that reaches the admin check, so this is equivalent while the lock exists) | `c19` → k99b |
| `mB-withcheck-no-email` | guard keeps `invited_email` unchanged | `c20` → k04 |
| `m21-guard-frees-invited-email` | accept policy WITH CHECK email match | `c20` → k04 |

Recorded runs: `controls-run.txt`, `mutant-run.txt`.
