# BACKLOG-3917 harness

Controls and mutants for `supabase/migrations/20261014002359_backlog_3917_member_status_allow_list.sql`.

Every run is one transaction ending in ROLLBACK; nothing is committed. Layering per control:
`lib/harness-3917.sql` (helpers + production fingerprint), venue parity (repo migrations
3673, 3759, 3843 and `lib/prod-bodies-3917.sql`), `lib/fixtures-3917.sql`,
`lib/preconditions-3917.sql` (every pinned object's md5 equals production's, else ERROR),
the 3917 file (or a mutant), the control. Client statements run through `pg_temp.as_user` /
`pg_temp.as_role`: `SET ROLE authenticated` (or `anon`) with `request.jwt.claims`.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh precheck   # venue equals the pre-3917 pins (historical; not production today)
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh base       # controls without the 3917 file
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants
```

Pinned (96 objects, production read 2026-10-13, before ledger 20261014002359; historical,
not production today — BACKLOG-3945): every policy, trigger and RLS flag on
organization_members, organizations, transaction_submissions, submission_comments,
submission_attachments, submission_messages, submission_attempts, submission_checklist_*,
submission_status_history, users, checklist_templates, checklist_template_items,
storage.objects, organization_identity_providers, scim_tokens, scim_sync_log, plus the
functions the changed objects call. Not compared: storage.objects triggers (storage service
version differs between venues) and the six support-attachments storage policies (bucket
`support-attachments` only; absent on the venue).

| Control | What it proves |
|---|---|
| c01 | suspended / expired / pending admin: promote, demote, remove, invite refused, `is_org_admin` false; active admin allowed; the same admin's active org2 membership grants `is_org_admin` in org2 only |
| c02 | organization settings (retention, JIT) refused for suspended / expired admin; allowed for active |
| c03 | approve, mark under review, comment refused for suspended / expired admin; allowed for active |
| c04 | reads: roster = own row, no submission / comments / attachment rows / message rows / attachment file / colleague users, reviewer check false, org template hidden; organization row still visible; active twin reads all |
| c05 | active personal owner keeps own organization, templates, template writes, reviewer check |
| c06 | template writes refused for suspended / expired admin and agent; allowed when active |
| c07 | suspended / expired agent: storage upload refused and submission row insert refused, nothing written; active agent allowed; the agent's active org2 membership allows an org2 upload; an `{org1}/…` upload into a second bucket with no policy of its own is refused for the active agent |
| c08 | identity providers, SCIM tokens, SCIM sync log: none for suspended / expired it_admin; all for active |
| c09 | catalogue: helper definition and grants; the five helpers keep production flags and grants; every changed object calls the helper; roles/commands unchanged; every other pinned object equals production |
| c10 / c11 | apply twice; `rollback-3917.sql` restores every pinned md5 to production's |
| c12 | signed-out requests: reads return nothing without error; writes refused |
| c13 | `set_submission_checklist_reviewer_check`: refused (42501) for suspended / expired admin; active admin ticks the item |

Fixture org2 is a second brokerage where the suspended admin `u_s` and the suspended agent
`u_gs` each hold an active membership (writers: `admin_invite_user` organization path and
`claim_pending_invite`, which refuse a duplicate only within the same organization). Every
org1 refusal holds with it present; m26 / m27 (status read from any membership) are killed
by it.

`base` runs the controls without the 3917 file: every deny-side check in c01-c04, c06, c07,
c13 fails there, every active-twin check passes. The c07 second-bucket check passes in base
too (production's policy already names the bucket); m28 is what it kills. `mutants` runs every control on the unmutated
file first, then each mutant in `lib/mutants.py` (each edit must match exactly once, else
INVALID). Mutants of the inline policy filters that stay closed through another table's
policy while the function changes stand are killed by c09 only; their behavioural control is
listed so the run shows it staying green. m23 is not one of them: both identity-provider
policies are permissive and the manage policy is FOR ALL, so its USING applies to SELECT and
c08 kills it as well as c09.
