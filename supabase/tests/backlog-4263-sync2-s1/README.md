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
   only when the result below holds). Expected: all **29** controls `PASS`, all **22** mutants `RED` with their primary
   control reading `FAIL:` (an `ERROR` does not count), `rollback: ok`, last line `controls 29 mutants 22: OK`. No mutant
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
sub-case that turns `M_backfill_least_recent` red (bf_1 to bf_6 have one deal per install, where max = min). bf_2's two
installs share one save time, so only the id term decides: `M_backfill_tie_highest` (`source_install_id DESC`) picks
the higher id and turns `tie_lowest` red. No mutant targets the `removed_at` / scope conditions; those sub-cases are
checked only by the controls themselves.

## Writes the c1 controls can see

- `c1_push` sends one `create_checklist` op on the caller's own deal; without the gate the inactive call adds a
  checklist, a todo op and a history row, all inside `pg_temp.fp()`. `M_push_gate_after_write` (the push answers
  `computer_not_active` only after applying its ops) is caught by that fingerprint alone.
- `c1_confirm` first inserts the storage object of blob bA (right size, no file behind it, undone with the case), so
  without the gate the inactive confirm sets bA's `uploaded_at`, which `pg_temp.fp()` covers.
- `c2_same` sets `active_since` to 2026-01-01 before the repeated claim, so "unchanged" can fail inside the one
  transaction (`now()` does not move within it).

## Locks and time

- **Migration** (its header): SHARE ROW EXCLUSIVE on `auth.users` from the new tables' foreign keys, held to commit;
  ACCESS EXCLUSIVE on `cloud_autosave_settings` for the ADD COLUMN (placed last); one row lock per settings row the
  existing-rows rule writes. `lock_timeout` 3 s; a lock not granted in 3 s fails the whole migration.
- **Harness**: row locks on its own fixture rows (including one `storage.objects` row inside `c1_confirm`) and on the
  one `cloud_release_switches` row until its final `RAISE`
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
run.sh R<n> <run-id> <fixture-user-id> [--mutant]   # both chosen before the run so the before-note names them
run.sh cleanup <run-id> <fixture-user-id>           # one fixture user's leftovers (only if its email is that run's)
```

- **Order:** argument checks; the probe (`precheck.sql`, one read-only call); nothing is created unless it is clean;
  then the mutant (`--mutant`), setup, the two sessions, the state call, the verdict, the trap.
- **The fixture id is a run argument** (the coordinator's ruling: the test database is shared, so the before-note
  names a fresh uuid4 before the run). It must be one lowercase uuid as a whole string; the nil id and any id of one
  repeated digit are refused; anything else sends no call at all. Create and delete use only that id.
- **First call = the probe** (read-only, printed as `probe:` for the before-note): a transaction-local setting set
  and read back in one call (must come back as exactly one row with `txn = one`, which proves one call = one
  transaction and that only the last statement's rows return), `transaction_isolation` (must be read committed),
  `track_activity_query_size`, `rolbypassrls` of the role, `one_computer`, the per-table counts for the fixture id
  (must be readable and all 0), the fixture checks below, and a count of unreferenced blobs older than 24 h. If one
  call = one transaction is not proven, the run stops with nothing created. A refusal names what it found: fixture
  addresses (fixture pattern only) and `_m4263` function names.
- **The probe** also refuses when an auth user has the fixture id, any `p4263s1cc-*@example.test` user
  exists, any `public.*_m4263` function exists, or (R3–R6) `one_computer` is not already true. R3–R6 therefore refuse
  before any fixture is committed while the switch is off. The switch is never flipped here (shared row; the
  coordinator flips it). R1, R2 and R2 `--mutant` run with the switch either way.
- **One run at a time.** A second run started alongside would have its mutant dropped by the first run's trap; the
  precheck and `setup.sql` refuse while any fixture user or `_m4263` function exists. Two starts within the same
  second can both pass these checks; do not start two.
- **Transport.** `SQL_TRANSPORT` names the executable that sends one call: it takes `<file.sql>` or `-c "<sql>"` and
  prints kt-sql's envelope (one JSON line; on an error a `kt-sql: HTTP <code>` line). Default: `~/.claude/bin/kt-sql`
  (the hosted test database). A self-hosted dry-run database is reached through a dry-run transport wrapper kept
  outside the repository. A transport path that does not exist or is not executable is refused before any call.
- **Guard marker.** `guard.sql` (first in every call) refuses any database without the hosted test database's marker
  user. `GUARD_MARKER_MD5` (32 hex characters) replaces that one literal in every text sent, and is accepted only
  together with a non-default `SQL_TRANSPORT`, so a run against the hosted test database always checks the hosted
  marker. Chosen over guarded copies because every repository file then stays byte-identical between the dry run and
  the hosted run; only the environment differs. The dry-run marker's value is not in the repository.
- **Answers.** Every call that does not end in RAISE answers with ONE final `SELECT json_build_object('tag', …) AS a`.
  `verdict.py` reads the last tagged answer of the call, from either row shape: the final SELECT's column (a
  transport that returns the last statement's rows) or every statement's output line (a transport that returns every
  line, including command tags). No reader depends on which statements' rows come back. Raising sessions carry their
  answer in the RAISE text, which both transports return the same way.
- **Gate and the activity text.** The holding statement itself starts with `/*p_hold:<run>*/`, and the call starts
  with it too (`hold-marker.sql`, before `guard.sql`). What `pg_stat_activity.query` shows while the hold runs:
  - a transport that submits the whole call as one text (the hosted API): the call text, cut at
    `track_activity_query_size` (1 kB on the hosted test database, `../backlog-4236/concurrency/c3-marker.sql`); the
    marker ends at byte 27. Not measured on the hosted database by this change.
  - a transport that submits statement by statement inside one transaction (the dry run): the current statement only,
    which starts with the marker. Measured on the dry-run database during a run: `/*p_hold:<run>*/ SELECT pg_sleep(4);`
    (S1 session 1, erase attach A), and `/*p_hold:<run>*/\n-- The holding statement …\nDO $a$ …` (erase c6g A).
  Session 2's gate text holds the marker split (`'%p_hold:' || '<run>' || '*/%'`), so it never matches itself on
  either transport. `offline_check.py` checks both views of every holder call.
- **Calls that COMMIT** (everything else is read-only or ends in RAISE): mutant create (`--mutant`: one function
  `public.*_m4263`), setup (the fixture rows below), session 1 and session 2 (each writes only through the case's
  function, on the fixture user's rows: R1 one deal and the take-over; R2 the take-over; R3 IA's claim; R4 the
  take-over with its move and notice; R5 the turn-off, which deletes the fixture user's deals and todo rows; R6 the
  take-over; mutants as their red shape says), mutant drop, teardown (deletes the fixture rows), and the last call's
  `pg_stat_statements_reset()` (statistics only). Read-only: the probe, md5, state, verify, per-table counts,
  `auth.users` total, cleanup's ownership check.
- **Dry run** (self-hosted dry-run database, 2026-11-24): R1 PASS, R2 PASS, R2 `--mutant` RED, each with session 2
  starting about 3 s before the hold ended (2.97–3.02 s) and every teardown clean (`auth.users` 1 before, 1 after; no
  `_m4263` function left); a SIGTERM during the hold waited 8 s, dropped the mutant and tore down clean. R3–R6 and
  their mutants were not run there: `one_computer` is off on that database and the scripts never flip it.
- **The first read-only call on the hosted test database must confirm** (the dry run could not show these): that
  one call is one transaction there (the probe's `txn = one`) and which rows the Management API returns for a
  multi-statement call; `track_activity_query_size`; that the whole call text is what `pg_stat_activity.query` shows;
  real timings (gate, holds, the live claim's runtime over real rows); whether the API cancels a query when the client
  disconnects (interrupt paths). The probe prints the first three as `probe:`.
- **Overlap and timing:** session 1 records `t_start`, `t_hold` (after its call) and `t_end` (after its 4 s hold, before
  its locks are released); session 2 records `t_start` (after the gate) and `t_end`, all from the database clock.
  Launch offset 1 s, hold 4 s: session 2 starts about 3 s before session 1's hold ends; the verdict needs at least
  1.5 s (the expected 3 s is twice that) and session 2's start after session 1's call. Without that the run is
  `INCONCLUSIVE`. "Waited" = session 2 ended after session 1's `t_end`. Every pristine case needs waited; R2's mutant
  needs not waited.
- **Verdict** (`concurrency/verdict.py`; offline self-test against canned outputs in kt-sql's real shape:
  `python3 -I concurrency/selftest.py`). It starts as `ERROR`. A pristine run prints `PASS` only on the case's passing
  shape with measured overlap; a `--mutant` run prints `RED` only on the case's own red shape with measured overlap
  (R2: confirm `object_missing`, claim ok, no wait; R3: both claims ok; R4: claim ok, turn-off success, 0 deals; R6:
  the write `applied`, 1 r6 deal). A session error, gate timeout, missing function, deadlock or state call with no
  row prints `ERROR`; no measured overlap or an unreadable time prints `INCONCLUSIVE`. Exit 0 only for PASS / RED.
  A mutant run also prints `MUTATION APPLIED <name> md5 <x>` right after the create (no body → ERROR, stop) and checks
  the mutant still exists after the sessions.
- **Which cases are evidence of the race.** R3–R6 pristine give the same outcome serially; the overlap measurement
  plus the waited requirement are what make them evidence of the race. R4's mutant is now
  `mutant-off-check-before-lock.sql`: the turn-off's active check is read before the settings lock. Serially it
  still refuses a computer that is not active; it lets IA's turn-off through only when the check reads the old state
  while IB's take-over holds the row, so its red shape needs the race. (The earlier mutant removed the refusal and
  was red serially too.)
- **Rows a case commits, and removes in its teardown:** 1 `auth.users`, 1 `public.users`, 1 `organizations` (slug
  `p4263s1cc-<run-id>`), 1 `organization_members`, 1 `organization_plans`, 1 `member_addons`, 1
  `cloud_autosave_settings`, 2 `cloud_deals` (3 after R1), 1 `cloud_blobs` (no storage object), 1
  `cloud_todo_feed_head`; with the switch on, a take-over adds 1 `cloud_computer_moves` and 1
  `cloud_computer_move_notices` row (they go with the auth user).
- **Trap:** drops the mutant first and checks that no `public.*_m4263` function is left; prints the fixture user's row
  count in every table that references `auth.users` (`fk-counts.sql`: catalogue query at run time, counts only; rows
  reached only through a second table are not counted there); runs `teardown.sql`, keyed on the fixture user id (it
  does nothing unless an auth user with that id AND this run's email exists); then `verify.sql`, the counts again
  (must total 0) and the `auth.users` total (must equal the precheck's). Any failure prints `TEARDOWN NOT CLEAN`
  with the user id, the run id and the counts left, and deletes nothing further (a mutant that was not dropped
  leaves the fixture rows in place too). Last call: `pg_stat_statements_reset()`.
- **lock_timeout** on every call that writes: 3 s for mutant create, mutant drop, setup, teardown and session 1; 8 s for
  session 2, which has to outwait session 1's hold (4 s hold − 1 s offset = about 3 s of waiting expected; 8 s is
  more than twice that). No table-level lock.
- **No role switch:** the sessions set the fixture user's JWT claims (so `auth.uid()` answers the fixture user) and
  call the function as the owner. The four functions, live and copies, are SECURITY DEFINER, so they run as their
  owner either way; the copies are REVOKEd from PUBLIC, anon, authenticated and service_role and granted to none.
- **Signals:** INT, TERM and HUP wait for the sessions and 8 s more, then run the trap. kill -9 runs nothing; the
  next run's probe then refuses and names the leftovers.
- **Per-table counts** also report rows in ON DELETE SET NULL / SET DEFAULT columns before the delete: they would stay
  with the id cleared, so they count as left behind (TEARDOWN NOT CLEAN).
- **`--mutant`** (R2, R3, R4, R6) creates exactly one function:

  | Case | File | Function created (REVOKEd from every API role, granted to none) |
  |---|---|---|
  | R2 | `mutant-confirm-nolock.sql` | `public.cloud_confirm_blob_m4263(uuid, uuid, uuid)` |
  | R3 | `mutant-claim-nolock.sql` | `public.cloud_claim_install_m4263(uuid, uuid, boolean)` |
  | R4 | `mutant-off-check-before-lock.sql` | `public.set_my_cloud_autosave_m4263(uuid, boolean, integer, uuid)` |
  | R6 | `mutant-deal-gate-before-lock.sql` | `public.cloud_upsert_deal_m4263(uuid, jsonb)` |

  The live functions are never replaced; only the session files of that case call the `_m4263` name. R1 has no
  claim-side mutant: without FOR UPDATE the claim still waits at its UPDATE (it conflicts with the writer's FOR SHARE);
  R3 carries `mutant-claim-nolock.sql`. R5 has no mutant.
- **`cleanup`** removes one fixture user's leftovers: it refuses unless the user with that id has that run's fixture
  email, drops any `_m4263` function, then runs the same teardown and checks. There is no pattern-keyed sweep.
- **Offline check:** `python3 -I concurrency/offline_check.py` drives `run.sh` against a local stub that records every
  text it would send (no database call) and checks the points above.

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
| `concurrency/offline_check.py`, `concurrency/selftest.py`, `concurrency/verdict.py` | Offline check of `run.sh` against a stub; verdict self-test; the verdict, precheck and per-table count readers |
| `concurrency/guard.sql`, `drop-mutants.sql`, `mutant-*.sql` | Generated: the guard every sent file starts with; the mutant drop and check; the four own-name mutants |
| `concurrency/setup.sql`, `teardown.sql`, `verify.sql`, `assert.sql`, `precheck.sql`, `fk-counts.sql`, `auth-count.sql`, `gate.sql`, `hold-marker.sql`, `lock-timeout.sql`, `lock-timeout-b.sql`, `as-user.sql`, `r*-*.sql`, `claim-ib-replace.sql`, `end.sql`, `end-hold.sql` | Hand-written fixtures, teardown, checks and session statements |
| `concurrency/verdict.py`, `selftest.py` | Hand-written verdict of a case, and its offline self-test (26 canned outputs) |
