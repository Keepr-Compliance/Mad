# BACKLOG-4263 sync 2.49, P1: test-project files for migration 20261123100000 (one computer per account)

**TEST DATABASE ONLY. Never run any file here on production.** `gen.py` writes every `.sql` file in this folder
except the hand-written two-session files in `concurrency/` (`setup.sql`, `teardown.sql`, `verify.sql`, `assert.sql`,
`gate.sql`, `as-user.sql`, the `r*-*.sql` and `claim-ib-replace.sql` session files, `run.sh`).
`python3 gen.py check` fails when a generated file is stale; the jest test
`broker-portal/__tests__/migrations/one-computer-4263.test.ts` also checks that the rollback restores the head bodies
byte for byte and that the harness embeds this migration's text and the rollback verbatim.

## Order on the test project (one engineer at a time; before-note to the coordinator for each step)

1. Apply `supabase/migrations/20261123100000_backlog_4263_one_computer.sql`, then run
   `../backlog-4263-prod/postcheck-20261123100000.sql`. Expected: `postcheck = ok`; `report_only` lists only
   `table cloud_autosave_settings grants service_role` (open finding F-12b) plus any CHECK / predicate text that differs
   from the predicted text (report only; see `../backlog-4263-prod/README.md`).
2. `~/.claude/bin/kt-sql harness-s1.sql > out.txt` (one call, ends in `RAISE 'S1_RESULT …'`, nothing persists), then
   `python3 gen.py report out.txt`. Expected: every control `PASS`, every mutant `RED` with its primary control in the red
   list, `rollback: ok`. Then `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`.
   At most 3 full runs per batch.
3. Two-session controls, `concurrency/run.sh R1` and `R2` (any time after step 1); `R3`, `R4`, `R5` only after
   `one_computer` is on (the coordinator's flip, after P2 merges). These COMMIT fixture rows with random ids and remove
   them in the teardown, verified clean.

## Locks and time

- `harness-s1.sql` holds row locks on its own fixture rows and on the one `cloud_release_switches` row until its final
  `RAISE`; its last step runs the rollback file, which takes ACCESS EXCLUSIVE on `cloud_autosave_settings` (DROP COLUMN)
  and the three new tables right before the `RAISE`. `lock_timeout` 3 s throughout.
- While it runs, the coordinator's switch flip (an UPDATE of that row) waits for it.
- Each two-session case holds a transaction for 4 s.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator, `check`, `report` |
| `rollback-20261123100000.sql` | Undoes 20261123100000 (pre-check, bodies back, objects dropped, ledger row removed, post-check) |
| `harness-s1.sql` | Single-session controls and their mutants; ends in a rollback |
| `concurrency/` | Two-session controls R1–R5 (`run.sh`), their mutants and the pristine statements to put back |
