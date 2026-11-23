# BACKLOG-4263 sync 2.49, P9: test-project files for migration 20261123140000 (AI read tools for emails and texts)

**TEST DATABASE ONLY. Never run `harness-t.sql` on production.** `gen.py` writes `apply-20261123140000.sql`,
`rollback-20261123140000.sql` and `harness-t.sql` from the migration and `lib/*.sql`. `python3 gen.py check` fails when a
written file is stale or a mutant fragment does not match exactly once; it prints `MUTATION APPLIED` for each mutant.
`broker-portal/__tests__/migrations/mcp-message-tools-4263.test.ts` checks the files' text in CI (no database there).

Status: WRITTEN, NOT RUN. Nothing here has been run on any database.

## Order on the test project (one engineer at a time; a before-note to the coordinator for each apply)

1. `20261123100000` (S1) and `20261123130000` (S2) are applied. T-S refuses to apply without S1's columns and state
   keys; apply S2 first because version order is apply order.
2. Apply: send `apply-20261123140000.sql` as one call (the migration text unchanged, then its ledger row). Re-run: the
   ledger INSERT fails (duplicate version) and the whole call rolls back (inferred, not run). The last statement swaps the
   call-log tool CHECK under `lock_timeout = '3s'` (ACCESS EXCLUSIVE on `mcp_call_log` until commit).
3. Post-check (read-only): `../backlog-4263-prod/postcheck-20261123140000.sql`. Expected `postcheck = ok`.
4. Harness, first the controls only: `~/.claude/bin/kt-sql harness-t-controls.sql > out.txt; python3 gen.py report out.txt`;
   when every control passes, the full call `harness-t.sql` (controls and the 57 mutants). Do not start a call between
   minute 15 and minute 30 of the hour: the call holds the `cloud_release_switches` row, and the erase job's scrub
   (minute 23) takes that row `FOR SHARE` and would wait. After each call run
   `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`. At most 3 full runs per batch.
   The call ends in RAISE (nothing persists). Its last step runs the rollback file and its post-check inside the
   same transaction (so the rollback is proven, then undone with everything else).

## What `report` counts

- A control passes only on `PASS`.
- A mutant counts as caught only when one of its primary controls returns `FAIL` and none returns `ERROR`; `ERROR`
  (the mutated function or the control raised) is `CRASH`, a proof that did not hold is `NOT_APPLIED`. Mutants marked
  `want=green` are expected to be equivalent and must pass.
- Zero controls or zero mutants is a failure.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator, `check`, `report` |
| `lib/helpers.sql` | Temp tables, call-as-role, tool calls as the portal makes them, fixture writers |
| `lib/fixtures.sql` | Two licensed users, deals and messages from the real writers, three connections |
| `lib/controls.sql` | The controls (C-9a ... C-9h, read log survives, read log view, marks, paging, retention, catalogue) |
| `apply-20261123140000.sql` | The migration text unchanged + its ledger row |
| `rollback-20261123140000.sql` | Undoes 20261123140000; refuses while the read log holds rows |
| `harness-t.sql` | Guard, applied check, fixtures, controls, mutants, rollback, RAISE |
| `harness-t-controls.sql` | The same call without the mutants (cheaper first run) |
