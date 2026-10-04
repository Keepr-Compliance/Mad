# BACKLOG-3403 harness — finalize_submission, submission_attempts, upload-time rules

Runs `supabase/migrations/20261004200000_backlog_3403_finalize_submission.sql`
— **the shipped file itself** — on a local Supabase stack (`supabase start` in
this repo: real `auth` and `storage` schemas, real PostgREST, storage-api and
GoTrue). `control-run.txt`, `mutant-run.txt` and the files under `live/` are the
recorded runs' own output (UUIDs masked as `<id>`). `rollback-3403.sql` is the
tested rollback.

It is not in CI: CI has no database. The CI tripwire is
`broker-portal/__tests__/migrations/finalize-submission-3403.test.ts`.
No file here has a `.test.` or `.spec.` infix. **Nothing here can reach production**
(`live/live-run.mjs` refuses any API URL that is not `127.0.0.1`/`localhost`).

## Venue

```bash
supabase start                       # the stack applies no repo migrations (config.toml)
bash supabase/tests/backlog-3403/run.sh prelude
```

`lib/parity-prelude.sql` is the production state of every object the migration
touches or reads, transcribed read-only from the production catalogue on
2026-10-04. **G0** proves the venue equals production before the file (27-row
fingerprint, `lib/fp-3403.sql`; the production result is pinned in
`lib/fixtures-3403.sql`). Service versions were pinned to the ones the linked
project reports (`supabase/.temp/{storage,rest,gotrue}-version`, git-ignored):
storage-api v1.71.0, PostgREST v14.5, GoTrue v2.196.0, Postgres 17.6.
Known residual: production's `storage.migrations` is at 72, the venue's at 64
(the later three are index changes).

## Running it

```bash
H=supabase/tests/backlog-3403/run.sh
bash $H controls      # controls/*.sql, each in its own rolled-back transaction
bash $H mutants       # lib/mutants.py against their target controls
```

Run under `bash`. `PG_CONTAINER` (default `supabase_db_keepr-test`) and
`SSH_HOST` select another venue. The controls need the venue in its
pre-migration state (G0); after the live run, apply `rollback-3403.sql` first.

```
BEGIN
  lib/fixtures-3403.sql -> fingerprint (t3403_before)
  -> the 3403 file (or a mutant) -> [G2: the file again] -> [G1: rollback-3403.sql]
  -> the control
ROLLBACK
```

## Controls

| Group | What |
|---|---|
| C1–C17 | `finalize_submission`: each refusal (counts only), success, idempotence, resubmit, nothing written on refusal |
| R3, F1 | abandon fence: fence first → `abandoned`; after finalize the fence matches 0 rows |
| E1 | `submission_metadata.excluded_files` is kept by finalize and not counted |
| P1–P11 | RLS: retried inserts, rows only while `uploading`, the 2.38 path still works, storage DELETE |
| H1, H1b, H2, X1 | attachment rows only inside their own `{org}/{submission}/` folder |
| X2, X2b, X5 | a reviewer cannot write `uploading`; other reviewer moves still work |
| X3, X4 | EXECUTE grants (anon refused) |
| T1–T9 | `submission_attempts` + `record_submission_attempt` |
| K1 | checklist header inserts unchanged |
| G0–G3 | venue = production before; rollback returns to it; apply twice = once; after = pinned (`lib/fp-after-3403.txt`) |

## Mutants

`lib/mutants.py`: every edit is an exact-string replace matched exactly once, or
the run aborts; the runner refuses a mutant whose diff is empty and prints
`MUTATION APPLIED` with the first changed line. M01–M12 keep the plan
pre-run's numbering. Most likely wrong implementations: M02 (message COUNT
instead of the id set), M17 (finalize ignores the fence), M19 (free-text
reason), M13 (the storage DELETE policy without the `abandoned` term).

## Live run (`live/`)

`node live/live-run.mjs pre|post` with `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`
from `supabase status -o env`.

- `pre` (function absent): `pgrst202.json` is the exact PostgREST answer for a
  missing RPC, through raw `fetch` and through supabase-js. Match on `code`
  only: the `hint` names whichever function the catalogue has that is closest.
- `post` (migration applied): retried `upsert(..., {ignoreDuplicates: true})`,
  `rpc('finalize_submission')` as the agent / a peer / the anon key, real
  `storage.remove()` as broker, as submitter before and after the fence and
  after finalize, the finalize-vs-abandon race in two sessions (psql holding
  finalize open while PostgREST and storage-api act), and `submission_attempts`
  reads per role.
- `live-mutant-m13.txt`: the same run with the storage DELETE policy minus its
  `abandoned` term; the race then removes a finalized submission's file.
- `apply-run.txt`: the migration applied with `psql -1 -f` on the venue.
