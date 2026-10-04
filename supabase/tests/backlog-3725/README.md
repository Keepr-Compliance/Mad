# BACKLOG-3725 harness — transaction_submissions.abandoned_at

Runs `supabase/migrations/20261004220000_backlog_3725_abandoned_at.sql` — the
shipped file — on a local Supabase stack, on top of the applied BACKLOG-3403
file `20261004192647_backlog_3403_finalize_submission.sql`. It reuses the
backlog-3403 venue prelude and fixtures. Recorded runs: `control-run.txt`,
`mutant-run.txt`, `live/*.txt` (UUIDs masked). `rollback-3725.sql` restores
the 3403 text verbatim. Not in CI (no database); the CI tripwire is
`broker-portal/__tests__/migrations/abandoned-at-3725.test.ts`. Nothing here can
reach production.

```bash
supabase start
bash supabase/tests/backlog-3725/run.sh prelude    # the backlog-3403 prelude
bash supabase/tests/backlog-3725/run.sh controls
bash supabase/tests/backlog-3725/run.sh mutants
```

```
BEGIN
  3403 fixtures -> 20261004192647 file -> fixtures-3725 -> fingerprint (t3725_before)
  -> the 3725 file (or a mutant) -> [G2: again] -> [G1: rollback-3725.sql] -> the control
ROLLBACK
```

## Controls

Every backlog-3403 control is carried over. The eight that set the old
`submission_metadata.abandoned` flag (F1, P6, P7, P8, P10, P11, R3, SR3) now set
`abandoned_at`; the fence is
`UPDATE … SET abandoned_at = now() WHERE id = $1 AND status = 'uploading' AND abandoned_at IS NULL`.

| Control | What |
|---|---|
| AB1 | the fence sets it once: 1 row, then 0 rows |
| AB2, AB3 | a set value cannot be cleared or changed (0 rows or refused; value unchanged) |
| AB4 | a peer agent matches no row; a broker is refused on a submission it can update |
| AB5 | after the fence a 2.38-shaped status flip by the submitter matches 0 rows |
| AB6 | a client cannot insert a row with it set |
| AB7 | setting it and leaving `uploading` in one statement is refused |
| AB8 | the old metadata flag no longer fences (no delete, finalize succeeds) |
| SV1 | the service role, and a SECURITY DEFINER function owned by postgres (a server sweep), can set it |
| G0–G3 | before = production (the 3403 post-apply fingerprint, 39 rows); rollback = before; twice = once; after = `lib/fp-after-3725.txt` (42 rows) |

## Mutants

`lib/mutants.py` (same contract as backlog-3403). The 3725 file re-creates
`finalize_submission`, so the 3403 mutants on its body re-run here against the
copy. Mutants with `want green` are measured EQUIVALENT and kept in the run:

- A41: the guard's "only from NULL" term. Extra protection only: the USING
  term keeps every client statement off a row whose `abandoned_at` is set.
  Kept because it is one term.
- A42: the guard's submitter term. RLS USING already limits uploading rows to
  the submitter.
- A47: the guard's OLD status term. The NEW status term catches every case a
  client can reach.
- EQ15: the finalize REVOKE term. `CREATE OR REPLACE` keeps the ACL the 3403 file set.

Load-bearing: U1 (submitter USING without `abandoned_at IS NULL` → AB5 red, and
live L7d: a 2.38 flip turns an abandoned upload into `submitted`,
`live/live-mutant-u1.txt`), A13, A17/A17b, A37, A40, A43, A45, A48.
