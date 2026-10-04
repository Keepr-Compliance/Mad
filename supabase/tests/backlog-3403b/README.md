# BACKLOG-3403 PR-B — live run of the desktop submit path

`live-run.txt` is the recorded output of
`electron/services/__tests__/submissionAtomic-3403.live.test.ts` (UUIDs masked
as `<id>`). That test runs the REAL `submissionService`,
`supabaseStorageService` and `submissionAbandon`, with supabase-js signed in as
an invented agent, against a LOCAL Supabase stack. Local SQLite reads and the
files on disk are fixtures. It is skipped unless `LIVE_3403B=1`, and it refuses
any API URL that is not `127.0.0.1` / `localhost`. Nothing here can reach
production.

## Venue (2026-10-04)

- `supabase start` with its own `project_id` (`keepr-3403b`) and ports, so it
  did not touch another stack running on the default ports.
- Service versions pinned to the linked project's: Postgres 17.6.1.044,
  PostgREST v14.5, storage-api v1.71.0, GoTrue v2.196.0.
- `supabase/tests/backlog-3403/run.sh prelude` (PR-A's production transcription),
  then `supabase/migrations/20261004192647_backlog_3403_finalize_submission.sql`,
  then BACKLOG-3725's `20261004220000_backlog_3725_abandoned_at.sql` from PR #2795
  at head `54e711c16` (file md5 `d92c51abbebf4c579bb1fc9d95f4a6fe`).
- One venue addition, made by the test: `organization_members.created_at`. PR-A's
  prelude transcribed only what its migration touches; the desktop's membership
  read orders on `created_at`, which production has.

## Command

```bash
LIVE_3403B=1 API_URL=… ANON_KEY=… SERVICE_ROLE_KEY=… PG_CONTAINER=supabase_db_keepr-3403b \
ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
  electron/services/__tests__/submissionAtomic-3403.live.test.ts
```

## Cases

| | What |
|---|---|
| L1 | normal submit: finalize flips it; counts, files and each attachment's `message_id` are the manifest's; attempt row `committed` |
| L2 | a file over 50 MB, confirmed: sent without it; `excluded_files` recorded; finalize does not count it |
| L3 | message writes fail on the network: fence → files → rows; nothing left; attempt `failed / messages / retries_exhausted` |
| L4 | refused twice after the uploads: uploaded files removed through the Storage API |
| L5 | refused once (a message row went missing), re-sent, finalized on the second call |
| L6 | finalize's answer lost: the read-back sees the commit; nothing deleted |
| L7 | Cancel during the uploads: nothing left; attempt `cancelled` |
| L8 | the race: a second session holds the row as finalize does; the desktop's fence waits (≥ 2 s), finds it committed, deletes nothing |

Live mutant: with the fence result ignored (`if (false)` in
`submissionAbandon.ts`), L8 reported `abandon=abandoned` on a submission that
had committed — the desktop would have told the agent it failed — while the
database's own policies still kept its files and rows (`objects=2 rows=2`).
