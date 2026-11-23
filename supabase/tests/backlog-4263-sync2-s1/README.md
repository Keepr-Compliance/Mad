# BACKLOG-4263 sync 2.49, P1: test-project files for migration 20261123100000 (one computer per account)

**TEST DATABASE ONLY. Never run any file here on production.** `gen.py` writes `apply-20261123100000.sql`,
`rollback-20261123100000.sql`, `harness-s1.sql` and, in `concurrency/`, `guard.sql`, `drop-mutants.sql` and the four `mutant-*.sql` files. Everything
else in `concurrency/` is hand-written. `python3 gen.py check` fails when a generated file is stale; the jest test
`broker-portal/__tests__/migrations/one-computer-4263.test.ts` also checks that the rollback restores the head bodies
byte for byte, that the harness embeds this migration's text and the rollback verbatim, and that every two-session
mutant is a new function under its own name.

## Order on the test project (one engineer at a time; before-note to the coordinator for each step)

Conditions (senior review of PR #3632):
- The harness runs in the **same coordinator window as the apply**.
- On **any** red control, `one_computer` stays off and the coordinator chooses rollback or fix-forward.
- The apply before-note names both locked tables, `cloud_autosave_settings` and `auth.users`, and the number of rows the
  existing-rows rule will write. Count, run read-only before the apply:
  `SELECT count(*) FROM public.cloud_autosave_settings s WHERE s.enabled AND EXISTS (SELECT 1 FROM public.cloud_deals d WHERE d.owner_user_id = s.user_id AND d.removed_at IS NULL);`
- No mutant runs on the shared database except through the own-name mechanism below (`run.sh … --mutant`).

1. Apply by sending `apply-20261123100000.sql` as one call (not the bare migration): it holds the text of
   `supabase/migrations/20261123100000_backlog_4263_one_computer.sql` unchanged, then the ledger row
   (`INSERT INTO supabase_migrations.schema_migrations`, version `20261123100000`, name `backlog_4263_one_computer`),
   in one transaction. Re-run: when the ledger row already exists, the INSERT fails (duplicate version) and the whole
   call rolls back, so nothing changes (inferred, not run). Then run
   `../backlog-4263-prod/postcheck-20261123100000.sql`. Expected: `postcheck = ok`; `report_only` lists only
   `table cloud_autosave_settings grants service_role` (open finding F-12b) plus any CHECK / predicate text that differs
   from the predicted text (report only; see `../backlog-4263-prod/README.md`).
2. `~/.claude/bin/kt-sql harness-s1.sql > out.txt` (one call, ends in `RAISE 'S1_RESULT …'`, nothing persists), then
   `python3 gen.py report out.txt` (reads kt-sql's JSON error body with its `kt-sql: HTTP 400` line, or plain text; exit 0
   only when the result below holds). Expected: all **29** controls `PASS`, all **20** mutants `RED` with their primary
   control reading `FAIL:` (an `ERROR` does not count), `rollback: ok`, last line `controls 29 mutants 20: OK`. No mutant
   is listed as equivalent. Offline self-test of the report reader: `python3 gen.py selftest` (canned outputs in both
   shapes; no database). Then
   `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`. At most 3 full runs per batch.
   The harness refuses outright, before its rollback step, if it is not running as one transaction.
3. Two-session controls (`concurrency/run.sh`, below): `R1` and `R2` any time after step 1; `R3`–`R6` only after
   `one_computer` is on (the coordinator's flip, after P2 merges).

## The existing-rows rule in `c2b_backfill`

The rule (`/*BACKFILL:latest*/`): per account, `ORDER BY max(last_synced_at) DESC, source_install_id` over live deals,
first row wins, so the install with the most recent save becomes active and a tie on that save goes to the lowest
install id. Sub-cases: `latest` (bf_1), `tie_lowest` (bf_2), `removed_ignored` (bf_3), `disabled_null` (bf_4),
`no_deal_null` (bf_5), `set_kept` (bf_6), `max_not_min` (bf_7). bf_7 gives one install two deals (36 h and 1 h old)
against one deal 24 h old and one 48 h old, so greatest max and greatest min pick different installs: it is the
sub-case that turns `M_backfill_least_recent` red (bf_1 to bf_6 have one deal per install, where max = min). No mutant
targets the tie term `source_install_id` or the `removed_at` / scope conditions; those sub-cases are checked only by
the controls themselves.

## Locks and time

- **Migration** (its header): SHARE ROW EXCLUSIVE on `auth.users` from the new tables' foreign keys, held to commit;
  ACCESS EXCLUSIVE on `cloud_autosave_settings` for the ADD COLUMN (placed last); one row lock per settings row the
  existing-rows rule writes. `lock_timeout` 3 s; a lock not granted in 3 s fails the whole migration.
- **Harness**: row locks on its own fixture rows and on the one `cloud_release_switches` row until its final `RAISE`
  (the coordinator's switch flip waits for it); the mutants lock their pg_proc rows. Last step only, right before the
  `RAISE`, the rollback file: ACCESS EXCLUSIVE on `cloud_autosave_settings`, `cloud_release_switches`,
  `cloud_computer_moves`, `cloud_computer_move_notices`, and — **not measured** — very likely ACCESS EXCLUSIVE on
  `auth.users` (dropping the two tables removes their foreign-key triggers on it), so every `auth.users` reader and
  writer waits (up to 3 s for the lock, then milliseconds); ROW EXCLUSIVE and a row lock on
  `supabase_migrations.schema_migrations`.
- **Rollback file run for real**: the same locks, held until it commits.
- **Two-session cases**: each holds a transaction for 4 s, with the row locks its functions take.

## Two-session controls: `concurrency/run.sh`

```
run.sh R<n> <run-id> [--mutant]   # <run-id> = 16 hex characters, chosen before the run so the before-note names it
run.sh cleanup <run-id>|all       # leftovers of one run, or of every run, and any *_m4263 function
```

- **One run at a time.** A second run started alongside would have its mutant dropped by the first run's trap. Covered:
  every run refuses to start while any `public.*_m4263` function exists (mutant runs), and `setup.sql` refuses while
  any `p4263s1cc-*@example.test` fixture user exists (pristine and mutant runs; also catches leftovers — run `cleanup`).
  Two starts within the same second can both pass these checks; do not start two.
- **Verdict** (`concurrency/verdict.py`; offline self-test against canned outputs in kt-sql's real shape:
  `python3 -I concurrency/selftest.py`). It starts as `ERROR`. A pristine run prints `PASS` only on the case's passing
  shape; a `--mutant` run prints `RED` only on the case's own red shape (R2: confirm `object_missing`, claim ok, no wait;
  R3: both claims ok; R4: claim ok, turn-off success, 0 deals; R6: the write `applied`, 1 r6 deal). Anything else —
  a gate timeout, a missing function, a deadlock, a state call with no row — prints `ERROR`. Exit 0 only for PASS / RED.
  A mutant run also prints `MUTATION APPLIED <name> md5 <x>` right after the create (no body → ERROR, stop) and checks
  the mutant still exists after the sessions.
- At start it prints the run id and the fixture pattern `p4263s1cc-<run-id>@example.test`, and refuses to start while
  any `public.*_m4263` function exists. Every file it sends begins with `guard.sql` (refuses any database that is not
  the test database).
- **Rows a case commits, and removes in its teardown** (EXIT/INT trap, then `verify.sql` must answer `clean`):
  1 `auth.users`, 1 `public.users`, 1 `organizations` (slug `p4263s1cc-<run-id>`), 1 `organization_members`,
  1 `organization_plans`, 1 `member_addons`, 1 `cloud_autosave_settings`, 2 `cloud_deals` (3 after R1), 1 `cloud_blobs`
  (no storage object), 1 `cloud_todo_feed_head`; with the switch on, a take-over adds 1 `cloud_computer_moves` and
  1 `cloud_computer_move_notices` row (they go with the auth user).
- **`--mutant`** (R2, R3, R4, R6) additionally creates exactly one function and removes it in the trap, then checks no
  `public.*_m4263` function is left:

  | Case | File | Function created (granted to authenticated only) |
  |---|---|---|
  | R2 | `mutant-confirm-nolock.sql` | `public.cloud_confirm_blob_m4263(uuid, uuid, uuid)` |
  | R3 | `mutant-claim-nolock.sql` | `public.cloud_claim_install_m4263(uuid, uuid, boolean)` |
  | R4 | `mutant-off-no-active-check.sql` | `public.set_my_cloud_autosave_m4263(uuid, boolean, integer, uuid)` |
  | R6 | `mutant-deal-gate-before-lock.sql` | `public.cloud_upsert_deal_m4263(uuid, jsonb)` |

  The live functions are never replaced; only the session files of that case call the `_m4263` name. R1 has no
  claim-side mutant: without FOR UPDATE the claim still waits at its UPDATE (it conflicts with the writer's FOR SHARE);
  R3 carries `mutant-claim-nolock.sql`. R5 has no mutant.
- **`cleanup`** deletes, for every auth user whose email matches the pattern, the rows listed above, then drops the four
  `_m4263` functions, and checks that no matching user, organization or `_m4263` function is left.

## Notes for later pieces

- **For P2:** the desktop must not offer "Delete them" (`cloud_delete_install`) from a refused computer: called there
  with the active install id it registers the active computer as removed (restorable for 30 days; reclaim undoes it).
- The one-computer rule is not tamper-proof against the account's own owner: install ids are asserted by the client, and
  the state answer returns the active one. It protects honest clients and races, not against the owner's own computers;
  do not describe it as a server guarantee.
- At the merge-forward into the write branch, `../backlog-4263-prod/gen.py`'s rule for later lane migrations also picks up
  that branch's `20261119100000`, so `postcheck-final-249.sql` (and `postcheck-final-write.sql` there) must be regenerated
  at that merge.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator, `check`, `report`, `selftest` |
| `apply-20261123100000.sql` | The migration text unchanged + its ledger row, one transaction (checked by `broker-portal/__tests__/migrations/apply-wrappers-4263.test.ts`) |
| `rollback-20261123100000.sql` | Undoes 20261123100000 (pre-check, bodies back, objects dropped, ledger row removed, post-check) |
| `harness-s1.sql` | Single-session controls and their mutants; ends in a rollback |
| `concurrency/run.sh` | Two-session controls R1–R6, `--mutant`, `cleanup` |
| `concurrency/guard.sql`, `drop-mutants.sql`, `mutant-*.sql` | Generated: the guard every sent file starts with; the mutant drop and check; the four own-name mutants |
| `concurrency/setup.sql`, `teardown.sql`, `verify.sql`, `assert.sql`, `sweep.sql`, `gate.sql`, `as-user.sql`, `r*-*.sql`, `claim-ib-replace.sql` | Hand-written fixtures, teardown, checks and session statements |
| `concurrency/verdict.py`, `selftest.py` | Hand-written verdict of a case, and its offline self-test (26 canned outputs) |
