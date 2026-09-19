# Parked: directory-sync provisioning schema — BACKLOG-2241

Three files, **parked, not deleted.** All three were written, committed, and never
applied to any database:

| file | adds |
|---|---|
| `20260320_add_directory_sync_provisioning.sql` | `organizations.service_account_key_encrypted` and the provisioning columns |
| `20260320_add_directory_sync_tracking.sql` | `organizations.directory_sync_error` and the sync-state columns |
| `20260320_add_google_workspace_domain.sql` | `organizations.google_workspace_domain` |

Their consumer is a `directory-sync` edge function that is not deployed.

## Why they are out of `supabase/migrations/`

1. `supabase migration list` reports them as local migrations no environment has run.
   Reconciling that list is what BACKLOG-3126 is for: a file in `migrations/` claims it
   belongs in every database, and these three do not yet.
2. `supabase db reset` runs everything in `migrations/`, so a local reset would add
   columns to `organizations` that nothing reads.

All three moved by `git mv` and are byte-identical to what was in `migrations/`;
`git log --follow` still reaches the original commits.

## What happens to them

BACKLOG-2241 (SCIM provisioning for Google & Microsoft) starts from this schema — the
founder's call on 2026-09-05 was explicitly to keep them for that work. When 2241 starts,
they move back into `supabase/migrations/` **under fresh timestamps**, re-reviewed against
the schema as it stands then, and applied test → staging → production like anything else.
Do not move them back on their own: three unapplied 2026-03-20 stamps sitting among
today's migrations is exactly the drift BACKLOG-3126 exists to clear.
