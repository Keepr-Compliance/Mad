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
   SELECT pg_has_role(current_user, 'mcp_reader', 'SET') AS can_set,
          pg_has_role(current_user, 'mcp_reader', 'USAGE') AS acts_as_owner,
          (SELECT array_agg(DISTINCT pg_get_userbyid(p.proowner)) FROM pg_proc p
            WHERE p.proname IN ('_mcp_r_get_message', '_mcp_r_list_deal_messages')) AS reader_owners,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public;
   SELECT count(*) FROM public.mcp_message_reads;                                                -- expect 0
   SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('list_deal_messages', 'get_message');  -- expect 0
   SELECT one_computer, messages_upload FROM public.cloud_release_switches WHERE id;
   SELECT schedule FROM cron.job WHERE jobname IN ('cloud-blob-erase', 'mcp-message-reads-prune');
   SHOW default_toast_compression;
   SELECT attcompression, attstorage FROM pg_attribute
    WHERE attrelid = 'public.cloud_deal_messages'::regclass AND attname = 'thread_key';
   SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle' AND backend_type = 'client backend';
   ```
   Stop and ask if `can_set` is false, if `reader_owners` is not `{mcp_reader}`, or if either count is not 0. The
   harness changes the two reader functions only under `SET LOCAL ROLE mcp_reader` (`pg_temp.as_reader`); `roles.py`
   checks that statically for every file listed in its report (`roles-report.txt`).
5. Fixtures first: `~/.claude/bin/kt-sql harness-t-fixtures.sql > fx.txt; python3 gen.py report-fixtures fx.txt`. It
   prints the counts, the timings it measured (the fixtures, one `_mcp_strip` and one get_message of the
   1,000,000-character body, the frame size and part count) and one decision line:
   - `NOT OK` / `decision: STOP` (exit 1): the fixtures failed, a count differs, the timing probe failed or a value is
     missing, the part count is outside 55 to 70, or no call fits the rule. Do not run the harness; report the output.
   - `decision: FULL`: the full call's estimate is at most 45 s → step 6a.
   - `decision: SPLIT`: the full estimate is over 45 s and the controls and mutants estimates are both at most 200 s →
     step 6b.
6a. Full call: `~/.claude/bin/kt-sql harness-t.sql > out.txt; python3 gen.py report out.txt full`.
6b. Split: `harness-t-controls.sql > c.txt` and check `python3 gen.py report c.txt controls`. If that report is NOT OK
    for any reason (a control, the rollback step, the transport shape, a timeout), stop: no mutants call. Otherwise, at least 2 minutes later and outside minutes 15 to 30,
    `harness-t-mutants.sql > m.txt`, then `python3 gen.py report-split c.txt m.txt`. Each split call has its own
    fixtures and its own rollback step; together they run what the full call runs. Combined OK only when both are OK.
   Expected last line of `report`: full call
   `controls=20 mutant_entries=58 (real=57 + negative_control_required_not_applied=1) problems=0`; controls call
   `controls=20 mutant_entries=0 (real=0 + negative_control_required_not_applied=0) problems=0`; mutants call
   `controls=0 mutant_entries=58 (real=57 + negative_control_required_not_applied=1) problems=0`. `report-split` prints
   both reports, then `combined: OK (controls ok, mutants ok)` only when both are OK.
7. After every call: `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`, then re-run the step-4
   counts and switch values and expect them unchanged.

Rules: never start a call between minute 15 and minute 30 of the hour (each call holds the `cloud_release_switches`
row until it ends; the erase job's scrub takes that row `FOR SHARE` at minute 23). **The cap for this harness is ONE
run**: the full call, or the split pair (controls and mutants) together. The fixtures-only call does not count. **No
re-send**: a call is not sent again, whatever its output. Stop on SQLSTATE `57014` or `55P03` anywhere in any output
(the reporters also refuse both). `gen.py check` must pass first; it also checks every key and code the harness
reads from a product answer (`answers.py`, result in `answers-report.txt`; its limits are listed below).

Executions of the 100,001-row loop (`c_prune_loop`) per call: harness-t.sql 2 (the controls pass and the mutant
`prune_single_batch`), harness-t-controls.sql 1, harness-t-mutants.sql 1, harness-t-fixtures.sql 0. The rollback step
runs in harness-t.sql, harness-t-controls.sql and harness-t-mutants.sql (last, before the RAISE), not in the fixtures
call.

## Compare by eye, for every call

The raw output wins over the reporter: if what you read disagrees with `report`, the call is NOT OK.
- The output ends with exactly one `kt-sql: HTTP 400` line. **HTTP 200 with rows means the transaction COMMITTED: that
  is an incident; stop and report it.**
- Exactly one `ERROR:` in the message, and its SQLSTATE is `P0001` (the harness's own RAISE). Any other code, and
  `57014` or `55P03` in particular, is a stop.
- The message reads `ERROR:  P0001: T4263_RESULT {...}` (`T4263_FIXTURES_OK {...}` for the fixtures call) and the JSON
  closes right before `\nCONTEXT:`.
- `MUTANT NOT RESTORED <id>` instead of a result: the catalogue differed from the one recorded after the fixtures once
  that mutant's block ended; the call is NOT OK.
- The reporters enforce each of these (`transport` in `gen.py`); the selftest has a canned output for each violation.

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
- The negative control `noop_probe` applies `SELECT 1` and checks it with `reader_granted_anon`'s proof. It must record
  `applied: false` with the error `MUTATION NOT APPLIED IN DB` (`NEG_OK`); anything else, or its absence in a full or
  mutants call, is NOT OK.
- After the fixtures the harness records a catalogue fingerprint (`pg_temp.fingerprint()`: the nine functions' body
  md5, ACL, volatility, security definer and owner; the read log's ACL; the constraint names of `mcp_message_reads` and
  `mcp_call_log`) and compares it after every mutant block; a difference raises `MUTANT NOT RESTORED <id>`.
- `report-fixtures`: every timing and `big1_frame_bytes` must be a finite number above 0 and `big1_parts` a whole
  number from 55 to 70, else `decision: STOP`. Timings are recorded rounded up (`ceil`) and the estimates print to the
  millisecond.

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
| `harness-t-mutants.sql` | The same call without the plain controls pass (its own fixtures, the 57 mutants and the negative control, the rollback step) |
| `harness-t-fixtures.sql` | The fixture section alone, then RAISE with the rows it made |
| `answers.py`, `answers-report.txt` | Answer check of the harness against the migrations, and its pinned result |
| `roles.py`, `roles-report.txt` | Role check: every statement on an object another role owns, in every .sql file of the hosted-MCP and Keepr Cloud test folders, with the role in force; pinned result |
