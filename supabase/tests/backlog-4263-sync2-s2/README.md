# BACKLOG-4263 sync 2.49, P4: test-project files for migration 20261123130000 (emails, texts and files up: server)

**TEST DATABASE ONLY. Never run any file here on production.** `gen.py` writes `apply-20261123130000.sql`,
`rollback-20261123130000.sql` and `harness-s2.sql` from the migration text. `python3 gen.py check` fails when a
generated file is stale. The jest test `broker-portal/__tests__/migrations/messages-up-server-4263.test.ts` re-derives
every replaced body from the earlier migrations (named insert templates, md5 pins), and checks that the apply file holds
the migration text unchanged plus its ledger row, that the rollback restores the earlier bodies byte for byte, that the
harness embeds the migration's md5 and the rollback verbatim, and that every mutant is proven applied by the md5 of its
body.

## What 20261123130000 changes

Five functions, no table, column, index or policy:

| Function | Change |
|---|---|
| `cloud_upsert_messages` | `feature_off` while `cloud_release_switches.messages_upload` is false; a row with `link_origin = 'review_queue'` is rejected (`review_queue_not_accepted`) before it is written |
| `cloud_upsert_files` | `feature_off` while the switch is false |
| `cloud_register_blob(uuid, uuid, text, bigint, text)` | `feature_off` while the switch is false |
| `cloud_tombstone` | kind `message` also removes that message's live file rows of the same deal, and fences their blobs no file row still uses |
| `cloud_list_install_rows` | kinds `message` and `file`; message rows carry `channel_kind` |

Not gated by the switch: `cloud_tombstone`, `cloud_list_install_rows`, `cloud_confirm_blob`, `cloud_delete_deal`, the
purge, turn-off, the erase job.

## Order on the test project (one engineer at a time; before-note to the coordinator for each step)

Plan section 11.4 step 7: after E3 (`20261123120000`) is applied, before T-S (`20261123140000`).

0. Before S2 is applied: any re-run of the S1 harness (`../backlog-4263-sync2-s1/harness-s1.sql`) happens now. Once S2
   is applied the S1 harness cannot run. Offline, any time: `python3 gen.py selftest` must print
   `selftest: all cases as expected` (and `python3 gen.py selftest --control-green-ok`, its control, must exit 1).

1. Apply by sending `apply-20261123130000.sql` as one call (not the bare migration). It holds the text of
   `supabase/migrations/20261123130000_backlog_4263_messages_up_server.sql` unchanged, then the ledger row
   (`INSERT INTO supabase_migrations.schema_migrations`, version `20261123130000`, name
   `backlog_4263_messages_up_server`), in one transaction. Re-run: when the ledger row already exists the INSERT fails
   (duplicate version) and the whole call rolls back, so nothing changes (inferred, not run). Then run
   `../backlog-4263-prod/postcheck-20261123130000.sql`. Expected: `postcheck = ok`, `report_only` empty.
2. Away from minute 23 of the hour (the erase run): `~/.claude/bin/kt-sql harness-s2.sql > out.txt` (one call, ends
   in `RAISE 'S2_RESULT …'`, nothing persists), then `python3 gen.py report out.txt`. `report` reads both kt-sql's JSON
   body (`{"message": "…"}` followed by `kt-sql: HTTP 400`) and plain text; it exits 0 only when everything below holds,
   and prints `NOT OK` for an ERROR, a crash, a missing or truncated result or any GREEN mutant (S2 has no mutant
   expected to stay green). Expected: every control `PASS`; every mutant `RED` with `applied=True` and its
   primary control reading `FAIL:` (an `ERROR` does not count as caught); `rollback: ok`. Then
   `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`. At most 3 full runs per batch.
   The harness refuses before its rollback step if it is not running as one transaction.

`messages_upload` stays false through both steps; the migration changes nothing a client sees until the coordinator's
flip (section 11.4 step 9).

## Locks and time

- **Migration**: no table lock. `CREATE OR REPLACE FUNCTION` takes the five functions' `pg_proc` rows until commit
  (only another replace of the same function waits). `lock_timeout` 3 s.
- **Harness**: row locks on its own fixture rows (one auth user and its organization, membership, plan, assignment,
  settings, two deals, a party, four messages, four files, two blobs; ids derived at run time from
  `md5('p4263:sync2-s2-harness:' || key)`) and on the ONE `cloud_release_switches` row (both switches are changed inside
  the call). Until its final `RAISE`, the coordinator's switch flip and the erase job's scrub (it reads that row
  `FOR SHARE`) wait. Each mutant's `CREATE OR REPLACE` locks that function's `pg_proc` row; other sessions keep calling
  the committed body. Last step, the rollback file: the five `pg_proc` rows and a row lock on the ledger. No lock on
  any table. Rows touched: only the rows it inserts, plus the switch row; real users' rows are not read or written.
  Not measured: run time (23 mutants x 16 controls, one control writes 500 message rows). Run it away from minute 23.
- **Rollback file run for real**: the same `pg_proc` and ledger locks, held until it commits.

## Two-session cases

None. Removing a message and attaching a file to it cannot interleave (traced from the function text, not run):
`cloud_tombstone` locks the message's deal row `FOR NO KEY UPDATE` first (`/*TOMB:lockdeals*/`), and so does
`cloud_upsert_files` (its deal lookup) before it reads the message (`/*FILE:livemessage*/`). The removal therefore runs
wholly before (the attach then answers `parent_missing`) or wholly after (the cascade sees the committed file row).
Inferred, not run: setting `cloud_message_id` also takes `FOR KEY SHARE` on the message row through
`cloud_deal_files_message_fk`, a second lock with the same effect.

## Notes for later pieces

- After 20261123130000 is applied, `../backlog-4263-sync2-s1/harness-s1.sql` no longer runs: its fixtures write messages
  and a blob through the three gated paths, and its rollback refuses (the bodies differ). Run it only between S1 and S2.
  `../backlog-4263-sync2-s1/concurrency/setup.sql` inserts its blob row directly, so the S1 two-session cases still run.
- Rollback order: this file's rollback before `../backlog-4263-sync2-s1/rollback-20261123100000.sql`.
- Flip `one_computer` away from minute 23 (traced, not run): a message tombstone from a computer that read the switch as
  off can deadlock once with an erase scrub batch for the same account (message then files against files then
  messages). Postgres aborts one; the desktop retries (and then gets `computer_not_active`), the scrub retries next run.
- For P5: `feature_off` means skip and keep the mark (not a failure). `rejected` (including `review_queue_not_accepted`)
  is terminal for that content hash; do not retry it. When tombstoning a message, mark its local file records removed in
  the same local transaction: the tombstone answer does not list the file rows it removed (the file-kind reconcile is
  the backstop). Re-sending a message does not bring its file rows back; send them again (and register and upload the
  bytes again, since their blob may have been fenced). Server keys: messages `(cloud_deal_id, channel_kind,
  local_message_id)`, files `(cloud_deal_id, local_attachment_id)`; only message rows carry `channel_kind`.
- For P6: stop the pass's byte uploads on the first `feature_off`. `cloud_confirm_blob` and the bucket upload are not
  gated by the switch, so a blob registered just before the flip to off can still be uploaded; it is never attached and
  the erase job's sweep erases it.
- Anything seeding messages, files or blobs through the API (for example P9's harness) must set `messages_upload` on
  inside its own transaction first.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator, `check`, `report`, `selftest` |
| `apply-20261123130000.sql` | The migration text unchanged + its ledger row, one transaction |
| `rollback-20261123130000.sql` | Undoes 20261123130000 (pre-check, five bodies back, ledger row removed, post-check) |
| `harness-s2.sql` | Single-session controls and their mutants; ends in the rollback and a RAISE |
