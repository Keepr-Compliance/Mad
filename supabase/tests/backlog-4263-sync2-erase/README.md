# BACKLOG-4263 sync plan P3 harness: file-byte erase job (E1 `20261123110000`, E3 `20261123120000`)

Venue: the test project through `~/.claude/bin/kt-sql` (it refuses the production ref). **Nothing here has been run
yet.** Runs are arranged by the main session one at a time, each under a before-note to the coordinator. Cap: 3 full
runs per batch; `harness.py` resets `pg_stat_statements` after each call.

Prerequisite on the test project: S1 `20261123100000` applied (E1 refuses to apply without
`cloud_autosave_settings.active_install_id`, `active_since` and `cloud_release_switches.one_computer`).

Applying E1 on the test project: send `apply-20261123110000.sql` as one call (not the bare migration). It holds the
text of `supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql` unchanged, then the ledger row
(`INSERT INTO supabase_migrations.schema_migrations`, version `20261123110000`, name `backlog_4263_cloud_blob_erase`),
in one transaction. Re-run: when the ledger row already exists, the INSERT fails (duplicate version) and the whole call
rolls back, so nothing changes (inferred, not run). Then run `../backlog-4263-prod/postcheck-20261123110000.sql`.

| Script | What it does | Commits? |
|---|---|---|
| `harness.py check` | offline: every mutant fragment matches its function exactly once; `apply-20261123110000.sql` matches E1; structure of helpers, probes, the composed call and every literal text (closed strings and dollar quotes, balanced parentheses, pg_temp argument counts, no constant in GROUP/ORDER BY) | no database call |
| `harness.py selftest` | offline: the report path on canned outputs in kt-sql's shape (CRASH, PRECONDITION, NOT APPLIED IN DB, a missed mutant and a FAIL each exit 1; no result line exits 2; zero tests exits 3) | no database call |
| `harness.py write` | offline: writes `apply-20261123110000.sql` from E1 (checked also by `broker-portal/__tests__/migrations/apply-wrappers-4263.test.ts`) | no database call |
| `harness.py run --controls` | one call: E3 and E1 rollback files, E1 from the working tree, helpers, 17 controls each in a subtransaction undone at its end, then RAISE | no: the call ends in RAISE |
| `harness.py run --mutants` | the same setup, then 26 mutants (exact-string replace on one E1 function, checked by `md5(prosrc)` in the database before its probe) | no |
| `harness.py run --controls --mutants` | both in one call | no |
| `concurrency/run.sh attach <fixture-user-id> [single_statement_fence]` | P3 condition 1, attach versus orphan sweep, two sessions | **yes**: 8 fixture rows plus session A's attach row (9), deleted by the trap, residue checked |
| `concurrency/run.sh c6g_skip <fixture-user-id> [no_skip_locked]` | C-6g (ii): a claim holding the settings row makes the batch skip that owner | **yes**: 8 fixture rows |
| `concurrency/run.sh c6g_wait <fixture-user-id> [read_before_lock]` | C-6g (i): a move waits for a batch holding the settings row | **yes**: 8 fixture rows |
| `concurrency/run.sh cleanup <fixture-user-id> <run-id>` | removes a fixture user the trap did not remove: by its id and that run's exact email only (refuses any other user); drops any own-name copy first | deletes only |
| `concurrency/offline_check.py` | offline: drives `run.sh` against a local stub that records every text it would send (bash 3.2 parse, the hold marker within the first 900 bytes, argument shapes refused with no call, the probe first, own-name copies revoked and never granted, lock_timeout on writes and sessions, switch writes only in raising DOs, delete by id, counts right before and after, no row values in the output, signals, TEARDOWN NOT CLEAN paths) | no database call |
| `concurrency/selftest.py` | offline: `verdict.py` on canned outputs in kt-sql's shape (transcribed), including session A error, session B error, gate timeout and both ok without overlap | no database call |
| `rollback-20261123120000.sql`, `rollback-20261123110000.sql` | remove E3, then E1 (functions, tables, both vault secrets, ledger rows). Both set lock_timeout first and end in a post-check that RAISEs `ROLLBACK POST-CHECK … FAILED, nothing changed` unless the objects are gone and nothing else changed. E1's refuses while the cron job exists, while a function is not at E1's body, and while `cloud_blob_erase_runs` holds rows (keep a copy of the run history, then delete it); it is not re-runnable. E3's is re-runnable (the test project has no E3) | yes, when run on their own |

The concurrency scripts need E1 applied (committed) on the test project and the coordinator's go for the committed
fixture user (the brief's rule is that harness transactions roll back; these three cannot, because two sessions
must see the same rows). Each session is one DO block that ends in RAISE, except `attach`'s session A.

### Two-session runs (`concurrency/run.sh`)

- **Order:** argument checks; the probe (`precheck.sql`, one read-only call: no user with the fixture id, no
  `p4263c-*@example.test` user, no `public.*_m4263` function, no `cloud_blob_erase_runs` row marked `p4263c`, and for
  `attach` fewer than 900 unreferenced blobs older than 24 h); nothing is created unless it is clean. Written and
  checked offline only; never run against a database. Then the own-name copy, setup (one DO block, so the replica
  setting covers only the user insert), the two sessions, the verdict and the trap.
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
- **Live functions are never replaced.** `copyfn.py` builds `public.cloud_blob_erase_claim_m4263` or
  `public.cloud_blob_erase_scrub_m4263` from the E1 text with one exact-string change (`CREATE FUNCTION`, never
  `CREATE OR REPLACE`), REVOKEd from PUBLIC, anon, authenticated and service_role in the same call and granted to none.
  The made flag is set before the create, so the trap drops it even when the md5 proof fails. It is committed in its own call, proven by `md5(prosrc)`, and
  dropped first in the trap, which then checks that no `*_m4263` function is left. The pristine `c6g_wait` also uses
  a copy: the live scrub with a 4 s sleep after its settings lock, so it is an instrumented copy of the live code,
  not the live function itself.
- **Gate marker:** the first line of session A's call is `/*p_hold:<run>*/`. `pg_stat_activity.query` keeps only
  the first `track_activity_query_size` bytes of a call (1 kB on the test project, `../backlog-4236/concurrency/c3-marker.sql`);
  the marker ends at byte 27, and `offline_check.py` fails when it ends past byte 900.
- **Timing arithmetic:** launch offset 1 s, hold 4 s, so session B starts about 4 − 1 = 3 s before A's hold ends.
  The verdict needs at least 1.5 s of A's hold left when B starts (the expected 3 s is twice that) and B's start
  after A's hold began; both sessions report start and end from the database clock. "Waited" = B ended after A's
  hold ended, i.e. after A's locks. With overlap measured, waited or not is decided by the locks, not by the
  offset; when overlap cannot be shown the verdict is INCONCLUSIVE, never PASS, FAIL or CAUGHT. One exception is
  handled: `c6g_skip` B writes the switch row before its scrub, so if someone else held that row B would wait for a
  reason that is not the case's; B records the time right before its scrub and the verdict is INCONCLUSIVE when that
  write took more than 0.5 s. Session B's lock_timeout is 8 s (it must outwait the 4 s hold); every call that
  writes (setup, copy, drop, delete) and session A use 3 s.
- **Verdict** (`verdict.py`): needs session A's own marker (attach: a row answered from one transaction; c6g: its
  `P_A` RAISE) and session B's `P_B`. Any error, gate or lock timeout, missing time or missing overlap is
  INCONCLUSIVE and exits 1. **A pristine `attach` PASS is evidence only together with `attach single_statement_fence:
  CAUGHT` in the same window:** B's claim works through other arms over real rows before it reaches blob X, so if
  those take longer than A's remaining hold, B reaches X after A committed and reads PASS without contention (its
  mutant would then read NOT_CAUGHT). The verdict line says so.
- **Output:** a session's answer is printed only as a summary that never carries row values: an error prints its
  SQLSTATE, plus the message only for a gate, lock or deadlock timeout (the live claim in `attach` B works over real
  rows, so a `DETAIL` could carry one).
- **Shared rows:** `attach`'s session B runs the live claim across the whole database (row locks on eligible real
  rows until its RAISE, about 3 s; rolled back). `c6g_skip` B and `c6g_wait` A set `cloud_release_switches.one_computer`
  on only when it is off, inside their DO that ends in RAISE (rolled back; a writer to that row waits meanwhile).
- **Trap:** after an interrupt (INT, TERM or HUP) it waits for the sessions and 8 s first (a session may still hold
  rows); drops the copy; prints the fixture user's row count in every table that references `auth.users`
  (catalogue query at run time, counts only); deletes `auth.users` by the exact id and this run's exact email
  (rows cascade); checks residue (direct and second-level rows, marked run rows) and that the `auth.users` total
  equals the probe's. Rows in ON DELETE SET NULL / SET DEFAULT columns before the delete count as left behind. Any failure prints `TEARDOWN NOT CLEAN` with the user id, the run id and the counts left,
  and deletes nothing further. Last call: `pg_stat_statements_reset()`.

## Load on the shared test database

- `lock_timeout = 3s` on every harness statement; the concurrency scripts: 3 s on every call that writes and in session A, 8 s in session B; holds 4 s.
- Every `harness.py` call runs both rollback files and then E1, so once E1 is applied on the test project the call
  drops and recreates `cloud_blob_erase_runs` and `cloud_blob_erase_leases` and holds ACCESS EXCLUSIVE on them for
  the whole call (rolled back at its end). No other existing table is locked. Run the harness before E1 is applied,
  or with E3's cron job not due (it fires at minute 23): an erase run that starts during a harness call waits up to
  its own timeouts on those two tables.
- A control that runs the live claim takes row locks (`FOR UPDATE SKIP LOCKED`) on any eligible row in the
  database for the length of that control (its subtransaction is rolled back, and the locks released, at its end),
  real rows included (message and file rows removed more than 24 h ago, unreferenced blobs older than
  24 h, fenced blobs), for the length of the call, and rolls them back. Assertions read the fixture's own rows only.

## Controls (harness.py)

| Control | Plan reference | Mutants that must turn it red |
|---|---|---|
| `p_grants` | P3 condition 3 (invoke not granted to service_role), revoke by default | `Invoke_granted_service_role`, `Claim_granted_authenticated` |
| `p_invoke_url` | P3 condition 3 (invoke refuses without the URL; empty counts as absent; positive control with a URL) | `Invoke_without_url_check` |
| `p_secrets` | ruling 1 (no URL seed), re-run keeps the secret | — |
| `p_c6a` | C-6a (crash between claim and finish heals; row deleted only after the object is gone; dry finish deletes nothing) | `C6a_finish_ignores_object`, `C6a_finish_on_dry_run` |
| `p_c6b` | C-6b (fenced but referenced blob never listed or deleted) | `C6b_claim_lists_referenced`, `C6b_finish_deletes_referenced` |
| `p_c6c` | C-6c (orphan sweep: 25 h vs 23 h, referenced, recently uploaded, never uploaded) | `C6c_orphan_age_registration_only`, `C6c_orphan_no_age`, `Erase_lists_unfenced` (returns PRECONDITION instead of a result when 900 or more unreferenced blobs, in any state, exist in the database) |
| `p_c6d` | C-6d and P3 condition 4 (hard delete at 24 h; a live file of a deleted message removed first, blob fenced) | `C6d_hard_delete_without_age`, `P3c4_message_files_left_live` |
| `p_c6e` | C-6e / P3 condition 2 (object whose blob row cascaded with its user) | `C6e_rowless_arm_dropped`, `C6e_rowless_no_age` |
| `p_c6f` | C-6f / P3 condition 6 (batch cap, files first, scrub fields, shared blob kept, rows_scrubbed in the run row, next run lists the fenced blob) | `C6f_install_filter_both`, `C6f_batch_cap_raised`, `C6f_blobs_not_fenced`; `C6f_install_filter_select_only` is expected green (the UPDATE re-check masks it) |
| `p_capped` | D4: the run row records `listing_capped` when a listing reaches its limit | `Listing_cap_not_recorded` |
| `p_note` | R1: the scrub counts reach the run row after finish; only new keys; ok moves to partial, failed stays | `Note_overwrites_counts`, `Note_sets_any_outcome` |
| `p_scrub_off` | switch off, no active computer, unknown owner | `C6f_switch_ignored`, `C6f_null_active_scrubs` |
| `p_owners` | D3 oldest move first | `Owners_newest_first` |
| `p_c6g_seq` | batch limit and the re-check under the settings lock, single session (two-session form: `concurrency/run.sh c6g_wait`): a limit-1 batch scrubs exactly one row, the lower id (E1 orders by id), answers more = true and leaves the active computer's row; after the move back, nothing of the now-active computer is scrubbed and the now-inactive one is. It names which case it saw: no row scrubbed (an E1 fault), two rows, or the higher id. | — (no mutant; primary for none) |
| `p_dry_run` | the schedule is first applied in dry_run: a dry claim and scrub change nothing but add one run row | `Dry_claim_does_live_work`, `Dry_scrub_does_live_work` |
| `p_e3` | E3 refuses without the URL secret; schedules minute 23 calling invoke | — |
| `p_rollback` | both rollback files remove every object | — |

## Expected results (the controls must all PASS before the mutants are run)

- `harness.py run --controls`: **17 PASS**, problems=0.
- `harness.py run --mutants`: **26 mutants: 25 CAUGHT, 1 EQUIV** (`C6f_install_filter_select_only`: the UPDATE re-check
  stops the wrong scrub, so the fixture cannot show it; equivalent for safety only), problems=0.
- Preconditions on the shared database: fewer than 900 unreferenced blobs (`p_c6c` returns PRECONDITION otherwise);
  fewer than 1000 fenced blobs and fewer than 1000 rowless objects older than 3 days (`p_c6a` and `p_c6e` would
  otherwise FAIL with "not listed", because their fixture rows sort after real ones; not checked inside the probes).

Counting: a mutant is caught only when its probe returns `FAIL`. `CRASH` (the mutated function or the probe raised),
`PRECONDITION` and `NOT APPLIED IN DB` are printed as such and make the run not-ok.

The concurrency fixture user id is a run argument (the coordinator's ruling: the test database is shared, so the
before-note names a fresh uuid4 first); the run id is printed at the start. See "Two-session runs" above for the precheck, the verdict and the trap.

Row shapes: see the header of `lib/helpers.sql`. Message and file rows are inserted directly in the shapes the writers
leave (cited there), not written through `cloud_upsert_*`, which need a licensed fixture account.
