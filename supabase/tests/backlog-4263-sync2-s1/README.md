# BACKLOG-4263 sync 2.49, P1: test-project files for migration 20261123100000 (one computer per account)

**TEST DATABASE ONLY. Never run any file here on production.** `gen.py` writes `rollback-20261123100000.sql`,
`harness-s1.sql` and, in `concurrency/`, `guard.sql`, `drop-mutants.sql` and the four `mutant-*.sql` files. Everything
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

1. Apply `supabase/migrations/20261123100000_backlog_4263_one_computer.sql`, then run
   `../backlog-4263-prod/postcheck-20261123100000.sql`. Expected: `postcheck = ok`; `report_only` lists only
   `table cloud_autosave_settings grants service_role` (open finding F-12b) plus any CHECK / predicate text that differs
   from the predicted text (report only; see `../backlog-4263-prod/README.md`).
2. `~/.claude/bin/kt-sql harness-s1.sql > out.txt` (one call, ends in `RAISE 'S1_RESULT …'`, nothing persists), then
   `python3 gen.py report out.txt`. Expected: every control `PASS`, every mutant `RED` with its primary control reading
   `FAIL:` (an `ERROR` does not count), `rollback: ok`. Then
   `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`. At most 3 full runs per batch.
   The harness refuses outright, before its rollback step, if it is not running as one transaction.
3. Two-session controls (`concurrency/run.sh`, below): `R1` and `R2` any time after step 1; `R3`–`R6` only after
   `one_computer` is on (the coordinator's flip, after P2 merges).

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
| `gen.py` | Generator, `check`, `report` |
| `rollback-20261123100000.sql` | Undoes 20261123100000 (pre-check, bodies back, objects dropped, ledger row removed, post-check) |
| `harness-s1.sql` | Single-session controls and their mutants; ends in a rollback |
| `concurrency/run.sh` | Two-session controls R1–R6, `--mutant`, `cleanup` |
| `concurrency/guard.sql`, `drop-mutants.sql`, `mutant-*.sql` | Generated: the guard every sent file starts with; the mutant drop and check; the four own-name mutants |
| `concurrency/setup.sql`, `teardown.sql`, `verify.sql`, `assert.sql`, `sweep.sql`, `gate.sql`, `as-user.sql`, `r*-*.sql`, `claim-ib-replace.sql` | Hand-written fixtures, teardown, checks and session statements |
| `concurrency/verdict.py`, `selftest.py` | Hand-written verdict of a case, and its offline self-test (26 canned outputs) |
