# BACKLOG-3726 harness — submission sweep

Runs `supabase/migrations/20261004232314_backlog_3726_submission_sweep.sql` (and the
schedule file `20261004232511_…`) — the shipped files — on a local Supabase stack, on top
of the applied BACKLOG-3403 file and the BACKLOG-3725 file (`abandoned_at`). Not in CI (no
database). CI tripwires: `broker-portal/__tests__/migrations/submission-sweep-3726.test.ts`
(migration text) and `tests/edge-functions/submissionSweep.test.ts` (Edge Function handler).
Nothing here can reach production: `live/live-run.mjs` and `live/run-live.sh` refuse any
API URL that is not `127.0.0.1` / `localhost`.

## Venue

```bash
supabase start                                    # a stack whose project_id no other worktree uses (see below)
bash supabase/tests/backlog-3726/run.sh venue     # 3403 prelude + 3403 file + 3725 file + pg_cron + FORCE RLS
```

`M3725` points at the 3725 migration (`20261004213050_backlog_3725_abandoned_at.sql`) when it is not yet in this tree. `PG_CONTAINER` selects
the db container. **Use a stack with its own `project_id`.** Every worktree's `config.toml`
says `keepr-test`, so a `supabase stop` or a prelude in another worktree hits the same
containers (it happened during this build). The recorded runs used a copy of `config.toml`
with `project_id = "keepr-3726"` and ports 544xx, in a workdir under `/Users` (Docker
Desktop does not mount `/private/tmp`, so `functions serve` cannot find the function there).

## Runs

```bash
H=supabase/tests/backlog-3726
bash $H/run.sh controls                 # controls/*.sql, each in one rolled-back transaction
bash $H/run.sh mutants                  # lib/mutants.py: every mutant against every control
python3 $H/lib/handler-mutants.py       # Edge Function handler mutants against the jest suite
STACK_WORKDIR=<workdir> PG_CONTAINER=<db container> WITH_TIMEOUT_MUTANT=1 bash $H/live/run-live.sh
```

Records: `control-run.txt`, `mutant-run.txt`, `handler-mutant-run.txt`,
`tripwire-mutant-run.txt`, `live/live-run.txt`, `live/live-mutants.txt` (UUIDs masked).

## Controls

| Control | What |
|---|---|
| S01 | (b) at 2 h: 1 h 50 m untouched, 2 h 10 m fenced; submitted row untouched; (a) 1 h grace |
| S17 | (b) is "no activity for 2 h": a 3 h old upload with a 30 min old file, or a 30 min old attachment row, is not claimed; a stalled one is; a new object in another org's folder is not activity (dry and live) |
| S18 | activity boundary: newest object 1 h 50 m old → not claimed, 2 h 10 m old → claimed |
| S19 | SR D1: a future-dated `submission_attachments.created_at` (the submitter can insert this row) does not count as activity — the stalled row is still listed and fenced |
| S02 | paths = attachment rows + rowless objects in the row's own `{org}/{id}/` folder only |
| S03 | files removed, then finish: row gone, children cascaded, attempt row `abandoned`, run row closed |
| S04 | an object left → row kept |
| S05 | finish deletes no submitted, unabandoned or submitted+abandoned row; claim never lists it |
| S06 | orphans: no row, no submission at segment 2, older than 7 days; a rowless object in a live folder is counted only |
| S07 | dry run fences nothing and still reports |
| S08 | floors: stall ≥ 2 h, grace ≥ 15 min, orphan ≥ 3 d; NULL dry_run refused |
| S09, S09a, S09b | client roles refused; EXECUTE grants; body guard on claim, finish and secret |
| S10 | after the fence (real 3725): finalize → `abandoned`, a 2.38 flip → 0 rows |
| S11 | a crashed run is picked up again; repeat finish is a no-op |
| S12 | a row with no timestamps is never fenced |
| S13 | run table: service_role read-only, clients nothing, 30-day retention |
| S14 | run counts keep numbers only (no path can land there) |
| S15 | invoke: URL from Vault, secret header, 150 s timeout |
| S16 | the production URL is seeded once |
| X1–X4 | SR controls: attachment row outside its folder; referenced parent (NO ACTION FK); no-arg claim is dry; future `abandoned_at` |
| G1–G3 | rollback removes everything; apply twice = once; schedule = one job at :41 |

## Live (local stack + `supabase functions serve`)

| Check | What |
|---|---|
| L1 | Storage `remove()` of a folder prefix removes nothing (exact names only) |
| L2 | service-role remove through storage-api with `protect_delete` present: object and bytes gone |
| L3a/L3b | dry run then live run through pg_net → Edge Function; a submitted submission untouched; an upload created 3 h ago that added a file 10 min ago is not fenced |
| L3c | a run of ≥ 8 s (injected local delay) records its finish row; pg_net gets the 200 |
| L3d | with the pg_net default 5 s timeout pg_net reports a timeout, and the local runtime still finishes the run |
| L4 | finalize holds the row lock 3 s; a live claim at 1 s returns in < 1 s, does not fence or list the row |
| L5 | wrong / missing secret → 401, no run row |
