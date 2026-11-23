# BACKLOG-4263 sync 2.49, P9: test-project files for migration 20261123140000 (AI read tools for emails and texts)

**TEST DATABASE ONLY. Never run `harness-t.sql` on production.** `gen.py` writes `apply-20261123140000.sql`,
`rollback-20261123140000.sql` and `harness-t.sql` from the migration and `lib/*.sql`. `python3 gen.py check` fails when a
written file is stale or a mutant fragment does not match exactly once; it prints `MUTATION APPLIED` for each mutant.
`broker-portal/__tests__/migrations/mcp-message-tools-4263.test.ts` checks the files' text in CI (no database there).

Status: T-S is applied on the test project and its post-check passed. Harness run 1 stopped in the fixture (a
fixture literal, fixed since). The fixtures-only call and the full or split run have not yet passed on any database.

## Order on the test project (one engineer at a time; a before-note to the coordinator for each apply)

1. `20261123100000` (S1) and `20261123130000` (S2) are applied. T-S refuses to apply without S1's columns and state
   keys; apply S2 first because version order is apply order.
2. Apply: send `apply-20261123140000.sql` as one call (the migration text unchanged, then its ledger row). Re-run: the
   ledger INSERT fails (duplicate version) and the whole call rolls back (inferred, not run).
3. Post-check (read-only): `../backlog-4263-prod/postcheck-20261123140000.sql`. Expected `postcheck = ok`.
4. Pre-run probes, one read-only call, outside minutes 15 to 30 of the hour:
   ```sql
   SELECT current_user, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user;
   SELECT m.inherit_option, m.set_option, m.admin_option FROM pg_auth_members m
     JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'mcp_reader' AND m.member = 'postgres'::regrole;
   SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname IN ('_mcp_r_get_message', '_mcp_r_list_deal_messages');
   SELECT count(*) FROM public.mcp_message_reads;                                                -- expect 0
   SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('list_deal_messages', 'get_message');  -- expect 0
   SELECT one_computer, messages_upload FROM public.cloud_release_switches WHERE id;
   SELECT schedule FROM cron.job WHERE jobname IN ('cloud-blob-erase', 'mcp-message-reads-prune');
   SHOW default_toast_compression;
   SELECT attcompression, attstorage FROM pg_attribute
    WHERE attrelid = 'public.cloud_deal_messages'::regclass AND attname = 'thread_key';
   SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle' AND backend_type = 'client backend';
   ```
   Stop and ask if `rolsuper` is false and `inherit_option` is false, or if either count is not 0.
5. Fixtures first: `~/.claude/bin/kt-sql harness-t-fixtures.sql > fx.txt; python3 gen.py report-fixtures fx.txt`. It
   prints the counts, the timings it measured (the fixtures, one `_mcp_strip` and one get_message of the
   1,000,000-character body, the frame size and part count) and one decision line:
   - `NOT OK` / `decision: STOP` (exit 1): the fixtures failed, a count differs, the timing probe failed or a value is
     missing, the part count is outside 55 to 70, or no call fits the rule. Do not run the harness; report the output.
   - `decision: FULL`: the full call's estimate is at most 45 s → step 6a.
   - `decision: SPLIT`: the full estimate is over 45 s and the controls and mutants estimates are both at most 200 s →
     step 6b.
6a. Full call: `~/.claude/bin/kt-sql harness-t.sql > out.txt; python3 gen.py report out.txt full`.
6b. Split: `harness-t-controls.sql > c.txt` and check `python3 gen.py report c.txt controls`; on a transport error or a
    timeout, stop and do not send the mutants call. Otherwise, at least 2 minutes later and outside minutes 15 to 30,
    `harness-t-mutants.sql > m.txt`, then `python3 gen.py report-split c.txt m.txt`. Each split call has its own
    fixtures and its own rollback step; together they run what the full call runs. Combined OK only when both are OK.
7. After every call: `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`, then re-run the step-4
   counts and switch values and expect them unchanged.

Rules: never start a call between minute 15 and minute 30 of the hour (each call holds the `cloud_release_switches`
row until it ends; the erase job's scrub takes that row `FOR SHARE` at minute 23). **The cap for this harness is ONE
run**: the full call, or the split pair (controls and mutants) together. The fixtures-only call does not count. A
second run needs the coordinator's go. `gen.py check` must pass first; it also checks every key and code the harness
reads from a product answer (`answers.py`, result in `answers-report.txt`; its limits are listed below).

Executions of the 100,001-row loop (`c_prune_loop`) per call: harness-t.sql 2 (the controls pass and the mutant
`prune_single_batch`), harness-t-controls.sql 1, harness-t-mutants.sql 1, harness-t-fixtures.sql 0. The rollback step
runs in harness-t.sql, harness-t-controls.sql and harness-t-mutants.sql (last, before the RAISE), not in the fixtures
call.

## Limits of the answer check (`answers.py`)

A finding means a literal the product functions cannot emit; "0 findings" means only that, not that the harness is
right. The desk run recorded on BACKLOG-4263 covers what the check cannot. Not checked:
- a literal the harness also passes in as data (for example a status that is also a file's `not_saved_reason`);
- path sensitivity: a literal is accepted when the function or any function it calls emits it anywhere, not only on the
  path the call takes (for example `'unchanged'` from `cloud_tombstone` for a live row);
- `@>`, `jsonb_path_*`, `?|`, `?&`, LIKE, `~`, `ANY(...)`, and compares wrapped in a function other than lower, upper,
  trim or btrim, or in a cast;
- values the check cannot trace to a product function: such key reads and compares are listed as "not checkable".
Checked since the review: `#>` / `#>>` paths, IN lists, lower()/upper()/trim() compares, a jsonb path compared with a
JSON text literal, and expected answers kept in jsonb variables.

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
| `harness-t-controls.sql` | The same call without the mutants |
| `harness-t-mutants.sql` | The same call without the plain controls pass (its own fixtures, the 57 mutants, the rollback step) |
| `harness-t-fixtures.sql` | The fixture section alone, then RAISE with the rows it made |
| `answers.py`, `answers-report.txt` | Answer check of the harness against the migrations, and its pinned result |
