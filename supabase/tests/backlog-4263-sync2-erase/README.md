# BACKLOG-4263 sync plan P3 harness: file-byte erase job (E1 `20261123110000`, E3 `20261123120000`)

Venue: the test project through `~/.claude/bin/kt-sql` (it refuses the production ref); `harness.py run --transport=`
and the two-session scripts take another transport as a parameter (below). Runs are arranged by the main session one at
a time, each under a before-note to the coordinator. Cap: 3 full runs per batch; `harness.py` resets
`pg_stat_statements` after each call. Every call begins with the guard (it refuses any database that is not the test
database: more than 100 tracker rows, or the test database's marker user absent).

## Staged procedure (every stage, in this order; the next stage only after the previous one is OK)

0. **Dry run first, required before any stage is requested on the test project; never cited as a result for it.** On
   a self-hosted dry-run database, through the dry-run transport wrapper (kept outside the repository), with that
   database's marker: `harness.py run --stage=<stage> --transport=<wrapper> --marker=<its marker md5>`. Each stage
   runs three times there: plain; after the standing foreign-rows prefix without log rows; and after the prefix with
   log rows (it carries run and lease rows). Expected in all three: the stage's result below, with `history_cleared`
   0/0, 0/0 and at least 1/1. The prefix's watch prints `FR4263_TOUCHED` lines for foreign rows the call changes.
   Designed touches: the clearing DELETE on run and lease rows; the claim fencing unreferenced old blobs of every
   owner (the job's purpose); rows touched inside a mutant's subtransaction. Any other touch is a finding.
1. `--stage=fixtures`: the setup alone (history cleared, both rollbacks, E1, helpers, probes) and a timing probe (one
   dry claim). Last line `fixtures: OK`. It prints `room` (`ok`, or the PRECONDITION the listing probes would give).
2. `--stage=structure`: each mechanism once, every block byte-identical to the full call's (`check` asserts it):
   `p_invoke_url`, `p_grants`, `p_rollback_refuses_history`, `p_rollback`, one function-body mutant
   (`Invoke_without_url_check`), one catalogue mutant (`Invoke_granted_service_role`) and the rollback-text mutant
   (`RB1_history_check_dropped`). Last line `controls=4 mutants=3 problems=0`.
3. `--stage=full` (or `controls` then `mutants`): last line `controls=18 mutants=27 problems=0`.
4. `--stage=history_mutant`: the call-level mutant (below). Last line `CAUGHT  M_History_not_cleared (call level) -> ...`.

Read a saved output with `harness.py report <file> --stage=<stage>`; it builds the mutants first. `report` on an empty
expectation table refuses (exit 4) instead of reading every mutant as want=red.

## Run history (cloud_blob_erase_runs, cloud_blob_erase_leases)

The E1 rollback refuses while `cloud_blob_erase_runs` holds rows, and every call runs it. So each call (after the
guard and the timeouts) deletes **every** run and lease row, records the counts as `history_cleared` (report only,
never asserted), then proceeds. The final RAISE undoes the deletion with everything else. `p_rollback_refuses_history`
then proves the refusal still fires: with one marked run row the E1 rollback must refuse with its own text, and once
that row is gone (deleted by its mark) it must run.

The call-level mutant `--stage=history_mutant` leaves the clearing out and writes one marked run row first. The
embedded E1 rollback must then refuse and the call give no result: the reporter reads that refusal as CAUGHT, and a
result (or any other error) as MISSED.

**Before a call on a database that HOLDS run history**, save it to a local file, so that a call that committed (HTTP
200) can be repaired. Neither table holds a secret, so every column is saved.

```sql
SELECT jsonb_build_object(
  'runs',   (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.started_at, r.id), '[]') FROM (SELECT id, started_at, ended_at, mode, outcome, counts FROM public.cloud_blob_erase_runs) r),
  'leases', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.run_id, l.blob_id), '[]') FROM (SELECT blob_id, run_id, leased_until FROM public.cloud_blob_erase_leases) l)) AS saved;
```

Repair, only after a call answered HTTP 200 (`<saved>` = the saved JSON):

```sql
INSERT INTO public.cloud_blob_erase_runs (id, started_at, ended_at, mode, outcome, counts)
SELECT r.id, r.started_at, r.ended_at, r.mode, r.outcome, r.counts
  FROM jsonb_to_recordset('<saved>'::jsonb -> 'runs') AS r(id uuid, started_at timestamptz, ended_at timestamptz, mode text, outcome text, counts jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.cloud_blob_erase_leases (blob_id, run_id, leased_until)
SELECT l.blob_id, l.run_id, l.leased_until
  FROM jsonb_to_recordset('<saved>'::jsonb -> 'leases') AS l(blob_id uuid, run_id uuid, leased_until timestamptz)
ON CONFLICT (blob_id) DO NOTHING;
```

Locks: the clearing first takes ACCESS EXCLUSIVE on `cloud_blob_erase_runs`, then on `cloud_blob_erase_leases`
(`LOCK TABLE`, lock_timeout 3 s), before any row lock; it is the lock the embedded E1 rollback's DROP takes moments
later, held until the call ends. Order: every E1 function touches the run table before the lease table (the claim
inserts its run row, then its leases; finish reads its run row, then deletes leases), so taking runs first cannot
deadlock with a job tick: a tick that already holds runs finishes, and this call waits (or gets 55P03). A tick that
starts during the call waits for the call's length, up to its own timeouts. The call records `history_lock` (both
tables held) in its result. In dry_run mode (E3's first deploy) no tick holds another lock while it waits on the run
table, so the job's side can wait or time out but is never part of a deadlock. In LIVE mode a live scrub can be waiting
on the run table while it holds rows this call later needs, and each of these is a possible deadlock, existing before
the clearing was added:
- the `cloud_release_switches` row (the scrub holds it FOR SHARE; a control's switch UPDATE, `lib/helpers.sql:116`);
- real file rows (the scrub holds them FOR UPDATE; the live claim inside a control takes file rows FOR UPDATE without
  SKIP LOCKED, E1 `:186`);
- real blob rows (the scrub's fence holds them FOR UPDATE, E1 `:454`; the live claim fences blobs through the same
  `_cloud_fence_unreferenced`, E1 `:193`, `:208` and the orphans at `:219`, which locks them FOR UPDATE without SKIP
  LOCKED, `20261112190000:412-414`).

PostgreSQL aborts whichever side's deadlock check fires after the cycle forms, so a `40P01` can land on the job's side
as well as on this call's. **Rule: this harness is never sent to a database whose erase job runs in LIVE mode. Every
before-note and every result note states the job's mode as read at that minute**: no `cloud-blob-erase` cron job,
or the job present and the Edge Function's `CLOUD_BLOB_ERASE_MODE` not `live` (anything else is a dry run,
`handler.ts:22-23`), with the newest run row's `mode`. The minute 15–30 rule below still applies in dry_run mode.

## STOP RULES

- Stop on any call that does not end `kt-sql: HTTP 400`. **HTTP 200 means the call committed**: stop and report. A
  committed call changes, and needs repaired, all of this:

  | What a committed call changed | Repair |
  |---|---|
  | run and lease rows deleted (the clearing, then the tables dropped and re-created empty by the rollback and E1) | the saved file (above) |
  | the `cloud-blob-erase` cron job unscheduled (E3 rollback) | not from a file: re-apply E3 with its own note (it needs the URL secret first) |
  | `cloud_blob_erase_url` deleted (E1 rollback) | not from a file: set it again per environment, as after E1 |
  | `cloud_blob_erase_secret` deleted, then a NEW one created by E1 (a different value) | not from a file: the Edge Function keeps no stored copy; it reads the secret through `rpc cloud_blob_erase_secret` and caches it in memory per warm instance (`supabase/functions/cloud-blob-erase/handler.ts:133-143`). A cold instance reads the new value; a warm one rejects until it restarts. Repair: restart or redeploy the function |
  | ledger rows `20261123120000` and `20261123110000` deleted (E1 re-created its objects, but writes no ledger row) | `apply-20261123110000.sql` (re-runnable text plus the ledger row); E3's row with E3's re-apply |
  | the six E1 functions dropped and re-created from the working tree | the same E1 text; nothing to do when the checkout is E1 as applied (`apply-20261123110000.sql` matches) |
  | `--stage=fixtures` only: one `dry_run` run row, written by the timing probe's dry claim at the top level of the call (E1 `:144`), left in the re-created table | delete that row (the saved file holds none like it) |

- Stop on SQLSTATE `57014` (statement timeout), `55P03` (lock timeout) or `40P01` (deadlock) in any output. On the
  dry-run database a `40P01` or `55P03` is a scheduling collision with another session: re-run once and say so.
- Stop on a result where a refusal is expected (`--stage=history_mutant` gave a result) and on a refusal where a result
  is expected (any other stage).
- Stop when `history_cleared` differs from the run and lease counts in the before-note (rows came or went between the
  note and the call).
- Stop when a stage is NOT OK; the next stage is not sent. No re-send of a stage on the test project without the
  coordinator's go.
- Do not start a call between minute 15 and minute 30 of the hour (E3's job fires at minute 23).

Prerequisite on the test project: S1 `20261123100000` and E1 `20261123110000` applied (every call runs the E1
rollback first, whose pre-check refuses unless E1's six functions are at the bodies E1 wrote). S1 is needed first because E1 refuses to apply without
`cloud_autosave_settings.active_install_id`, `active_since` and `cloud_release_switches.one_computer`).

Applying E1 on the test project: send `apply-20261123110000.sql` as one call (not the bare migration). It holds the
text of `supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql` unchanged, then the ledger row
(`INSERT INTO supabase_migrations.schema_migrations`, version `20261123110000`, name `backlog_4263_cloud_blob_erase`),
in one transaction. Re-run: when the ledger row already exists, the INSERT fails (duplicate version) and the whole call
rolls back, so nothing changes (inferred, not run). Then run `../backlog-4263-prod/postcheck-20261123110000.sql`.

| Script | What it does | Commits? |
|---|---|---|
| `harness.py check` | offline: every mutant fragment matches its function exactly once; `apply-20261123110000.sql` matches E1; structure of helpers, probes, the composed call and every literal text (closed strings and dollar quotes, balanced parentheses, pg_temp argument counts, no constant in GROUP/ORDER BY) | no database call |
| `harness.py selftest [--control-green-ok]` | offline: the report path on canned outputs in kt-sql's shape (CRASH, PRECONDITION, NOT APPLIED IN DB, a missed mutant and a FAIL each exit 1; no result line exits 2; zero tests exits 3; an empty expectation table exits 4; the history mutant's refusal, a result and another error; the structure call's block set). `--control-green-ok` asserts a missed mutant is ok and must make it fail | no database call |
| `harness.py report <file> [--stage=<stage>]` | offline: reads a saved output (builds the mutants first) | no database call |
| `harness.py run --stage=fixtures` / `structure` / `history_mutant` | the stages above | no: each call ends in RAISE |
| `harness.py write` | offline: writes `apply-20261123110000.sql` from E1 (checked also by `broker-portal/__tests__/migrations/apply-wrappers-4263.test.ts`) | no database call |
| `harness.py run --controls` | one call: guard, run history cleared, E3 and E1 rollback files, E1 from the working tree, helpers, 18 controls each in a subtransaction undone at its end, then RAISE | no: the call ends in RAISE |
| `harness.py run --mutants` | the same setup, then 27 mutants (exact-string replace on one E1 function, checked by `md5(prosrc)` in the database before its probe) | no |
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
- **Transport.** `SQL_TRANSPORT` names the executable that sends one call: it takes `<file.sql>` or `-c "<sql>"` and
  prints kt-sql's envelope (one JSON line; on an error a `kt-sql: HTTP <code>` line). Default: `~/.claude/bin/kt-sql`
  (the hosted test database). A self-hosted dry-run database is reached through a dry-run transport wrapper kept
  outside the repository. A transport path that does not exist or is not executable is refused before any call.
- **Guard marker.** `guard.sql` (first in every call) refuses any database without the hosted test database's marker
  user. `GUARD_MARKER_MD5` (32 hex characters) replaces that one literal in every text sent. The override is refused
  unless a non-default `SQL_TRANSPORT` is named. The script cannot know where a transport points: with an override,
  the remaining protection is the transport's own fixed target and `guard.sql`'s refusal of any database holding more
  than 100 tracker rows. Chosen over guarded copies because every repository file then stays byte-identical between
  the dry run and the hosted run; only the environment differs. The dry-run marker's value is not in the repository.
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
- **Calls that COMMIT** (everything else is read-only or ends in RAISE): the own-name copy (create, then drop),
  setup (the 8 fixture rows), `attach`'s session A (one `cloud_deal_files` row of the fixture user), the delete (the
  fixture user; its rows cascade), and the last call's `pg_stat_statements_reset()` (statistics only). Session B of
  every case and session A of `c6g_skip` / `c6g_wait` are one DO each that ends in RAISE.
- **Dry run** (self-hosted dry-run database, 2026-11-24): attach PASS, attach `single_statement_fence` CAUGHT,
  c6g_skip PASS, c6g_skip `no_skip_locked` CAUGHT, c6g_wait PASS, c6g_wait `read_before_lock` CAUGHT; session B
  started 2.89–3.00 s before A's hold ended in each; every residue check clean (`auth.users` 1 before, 1 after; no
  copy, fixture user or marked run row left; the switch row unchanged).
- **The first read-only call on the hosted test database must confirm** (the dry run could not show these): that
  one call is one transaction there (the probe's `txn = one`) and which rows the Management API returns for a
  multi-statement call; `track_activity_query_size`; that the whole call text is what `pg_stat_activity.query` shows;
  real timings (gate, holds, the live claim's runtime over real rows); whether the API cancels a query when the client
  disconnects (interrupt paths); that the session role holds EXECUTE on the four live S1 functions
  (`cloud_claim_install`, `cloud_confirm_blob`, `set_my_cloud_autosave`, `cloud_upsert_deal`); and, by reading the
  probe call's own `pg_stat_activity.query` back, whether the transport prefixes the call text, so the marker's byte
  position on that transport is measured, not assumed. The probe prints the first three as `probe:`.
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
- Every `harness.py` call deletes every run and lease row first (row locks), then runs both rollback files and then
  E1, so the call drops and recreates `cloud_blob_erase_runs` and `cloud_blob_erase_leases` and holds ACCESS
  EXCLUSIVE on them for the whole call (rolled back at its end; taken first by the clearing, see "Run history"). No
  other existing table is locked. Run it with E3's cron job not due (it fires at minute 23): an erase run that starts
  during a harness call waits up to its own timeouts on those two tables.
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
| `p_rollback_refuses_history` | the E1 rollback refuses while a run row exists (its own text; the count is not asserted), and runs once that row is gone | `RB1_history_check_dropped` (the rollback text handed to it, without its run-rows check; proven by the text's md5 in the database) |
| (call level) | the call clears the run history before the embedded E1 rollback | `M_History_not_cleared` (`--stage=history_mutant`) |

## Expected results (the controls must all PASS before the mutants are run)

- `harness.py run --controls`: **18 PASS**, problems=0.
- `harness.py run --mutants`: **27 mutants: 26 CAUGHT, 1 EQUIV** (`C6f_install_filter_select_only`: the UPDATE re-check
  stops the wrong scrub, so the fixture cannot show it; equivalent for safety only), problems=0.
- Preconditions on the shared database: fewer than 900 unreferenced blobs (`p_c6c` returns PRECONDITION otherwise);
  fewer than 900 unreferenced blobs and fewer than 900 rowless objects older than 24 h for `p_c6a`, `p_c6e` and `p_c6f`
  (`pg_temp.room('listing')`: they return PRECONDITION instead of a result, because their fixture rows would sort after
  real ones; `p_c6b` too, whose "not listed" proves nothing while the listing is full). The other bounded listings:
  fewer than 19 000 message rows and 19 000 file rows removed more than 24 h ago (`room('rows')`, batch 20 000:
  `p_c6d`, `p_dry_run`), fewer than 190 owners with an active computer (`room('owners')`, list 200: `p_c6f`,
  `p_owners`). `--stage=fixtures` prints `room`.

Counting: a mutant is caught only when its probe returns `FAIL`. `CRASH` (the mutated function or the probe raised),
`PRECONDITION` and `NOT APPLIED IN DB` are printed as such and make the run not-ok.

The concurrency fixture user id is a run argument (the coordinator's ruling: the test database is shared, so the
before-note names a fresh uuid4 first); the run id is printed at the start. See "Two-session runs" above for the precheck, the verdict and the trap.

Row shapes: see the header of `lib/helpers.sql`. Message and file rows are inserted directly in the shapes the writers
leave (cited there), not written through `cloud_upsert_*`, which need a licensed fixture account.

## Call classes

What each `.sql` file in this folder is when it is sent. `harness.py check` (through `../backlog-4263-sync2-t/call_shape.py`) and the jest pin `broker-portal/__tests__/migrations/call-shape-4263.test.ts` compare this table with the classes in `harness.py check` and with the test's own list. A class changed in one or two of the three places is red; a file not in the table is red.

| File | Class | Sent as |
|---|---|---|
| `apply-20261123110000.sql` | commits | E1's text unchanged, then its ledger row (written by `harness.py write`) |
| `rollback-20261123110000.sql` | commits | on its own to roll E1 back; inside every harness stage as a part, where the final RAISE rolls it back |
| `rollback-20261123120000.sql` | commits | on its own to roll E3 back; inside every harness stage as a part, where the final RAISE rolls it back |
