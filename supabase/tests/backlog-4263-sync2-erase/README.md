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
| `harness.py check` | offline: every mutant fragment matches its function exactly once, and `apply-20261123110000.sql` matches E1 | no database call |
| `harness.py write` | offline: writes `apply-20261123110000.sql` from E1 (checked also by `broker-portal/__tests__/migrations/apply-wrappers-4263.test.ts`) | no database call |
| `harness.py run --controls` | one call: E3 and E1 rollback files, E1 from the working tree, helpers, 17 controls each in a subtransaction undone at its end, then RAISE | no: the call ends in RAISE |
| `harness.py run --mutants` | the same setup, then 26 mutants (exact-string replace on one E1 function, checked by `md5(prosrc)` in the database before its probe) | no |
| `harness.py run --controls --mutants` | both in one call | no |
| `concurrency/run.sh attach <fixture-user-id> [single_statement_fence]` | P3 condition 1, attach versus orphan sweep, two sessions | **yes**: 8 fixture rows plus session A's attach row (9), deleted by the trap, residue checked |
| `concurrency/run.sh c6g_skip <fixture-user-id> [no_skip_locked]` | C-6g (ii): a claim holding the settings row makes the batch skip that owner | **yes**: 8 fixture rows |
| `concurrency/run.sh c6g_wait <fixture-user-id> [read_before_lock]` | C-6g (i): a move waits for a batch holding the settings row | **yes**: 8 fixture rows |
| `concurrency/run.sh cleanup <fixture-user-id>` | removes a fixture user the trap did not remove (refuses any id whose email is not a p4263c fixture address) | deletes only |
| `rollback-20261123120000.sql`, `rollback-20261123110000.sql` | remove E3, then E1 (functions, tables, both vault secrets, ledger rows) | yes, when run on their own |

The concurrency scripts need E1 applied (committed) on the test project and the coordinator's go for the committed
fixture user (the brief's rule is that harness transactions roll back; these three cannot, because two sessions
must see the same rows). Each session itself ends in RAISE except `attach`'s session A.

## Load on the shared test database

- `lock_timeout = 3s` on every statement; holds in the concurrency scripts are 2 s.
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
| `p_c6g_seq` | C-6g (i), single-session sequence only (the two-session form is `concurrency/run.sh c6g_wait`) | — |
| `p_dry_run` | the schedule is first applied in dry_run: a dry claim and scrub change nothing but add one run row | `Dry_claim_does_live_work`, `Dry_scrub_does_live_work` |
| `p_e3` | E3 refuses without the URL secret; schedules minute 23 calling invoke | — |
| `p_rollback` | both rollback files remove every object | — |

Counting: a mutant is caught only when its probe returns `FAIL`. `CRASH` (the mutated function or the probe raised),
`PRECONDITION` and `NOT APPLIED IN DB` are printed as such and make the run not-ok.

The concurrency fixture user id is an argument so the before-note can name it first. Setup refuses an id that
already exists. The verdict needs session B's `P_B` line: no line is INCONCLUSIVE (exit 1), never a pass or a catch.

Row shapes: see the header of `lib/helpers.sql`. Message and file rows are inserted directly in the shapes the writers
leave (cited there), not written through `cloud_upsert_*`, which need a licensed fixture account.
