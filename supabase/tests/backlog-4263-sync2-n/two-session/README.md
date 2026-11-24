# Two-session control for T-N: an approve whose transaction began before T-N's (dry-run database only)

**DRY-RUN DATABASE ONLY. Never on the test project or production: the script refuses there.** Unlike the harness, this
control COMMITS: T-N itself has to be committed while a second session waits on its lock. It commits the fixture rows,
`mcp_settings.enabled` = true, T-N, then the rollback file, then a teardown that deletes the fixture rows by exact id and
puts `mcp_settings.enabled` and `updated_at` back. It then proves the database is back at the precheck's baseline.

How the refusal is enforced:
- **No default marker.** The dry-run database's marker md5 must be given as `T4263N_MARKER_MD5`; nothing in the
  repository supplies one. `run.sh` and `compose.py` each refuse when it is missing, and each refuses the test
  project's marker.
- **The guard of every call refuses** when the test project's marker row exists. That marker is written in two pieces
  in these files, so a one-match substitution can neither find it nor satisfy it, and `offline_check.py` asserts no file
  here holds it whole.
- **The transport must be explicit.** `T4263N_RUNNER` has to be set, and `run.sh` refuses the hosted transport by its
  name, also through a symlink.
- Each refusal has a stub case in `offline_check.py`, and a mutation that removes it and turns the case red.

Run on a dry-run database on 2026-11-24 (before these refusals were added; the SQL of the run is unchanged):
pristine PASS, mutant RED.

## What it shows

Session 2 starts its transaction first. It waits server-side until session 1 is sleeping inside T-N's transaction,
holding the EXCLUSIVE lock on `mcp_authorization_requests` after the bump. Session 2 then approves a request that was
viewed at approval page version 1. Its approve waits for the lock, and continues once session 1 commits.

- **Fixed T-N (`run.sh <run-id> <user-id>`):** the trigger set that request's `expires_at` to `'-infinity'`, so the
  approve answers `{"ok": false, "error": "request_invalid"}` (`mcp_authorize_approve`, 20261118130000:839, :843-845)
  and no connection exists. Verdict `PASS`.
- **T-N as it was before the expiry fix (`--mutant`):**
  - The trigger wrote `now()`, T-N's transaction-start time, which is later than session 2's.
  - So session 2's `expires_at > now()` still holds, the approve succeeds, and the connection it creates reads
    `mcp_settings.notice_version` = 2.
  - Verdict `RED` (the hole: shown version 1, stamped 2).
  - The mutant text is built by exact-string replaces that must each match once (`MUTATION APPLIED`), together with the
    matching rollback (its trigger body md5 and its post-check).
- The verdict is `INCONCLUSIVE` unless all of these hold:
  - session 2's transaction started before session 1's (both report `now()` and `clock_timestamp()`);
  - session 1 held the lock when session 2 passed its gate;
  - the approve ended after session 1's hold ended;
  - T-N was committed.

Session 2 ends in a RAISE, so its approve, and any connection it made, are rolled back. The rollback file can then run.

## Order of one run

| Step | Call | Commits? |
|---|---|---|
| 1 | precheck (one call = one transaction, read committed, ledger head 20261123140000, version 1, no T-N object, no pending request, no version-2 connection, no fixture user or client; records `mcp_settings.enabled` and `updated_at` and the baseline) | no |
| 2 | setup: one fixture user `p4263n2s-<run-id>@example.test` with organization, membership, assignment, Keepr Cloud on; `mcp_settings.enabled` true; one client; one request in the shape `mcp_authorize_begin` writes; the view (must answer version 1) | **yes** |
| 3 | session 2 (started first), then session 1 one second later: T-N's apply file text, then 6 s holding its locks | session 1 **yes**; session 2 no |
| 4 | state | no |
| 5 | the rollback file matching the T-N that was committed (chosen by the trigger body md5) | **yes** |
| 6 | teardown: the client by id (requests, codes, connections go with it); the user's rows by exact id, email and slug; `mcp_settings.enabled` and `updated_at` back to the precheck's values | **yes** |
| 7 | verify: the baseline compared with the precheck's (ledger head and rows, the `mcp_settings` row md5, T-N objects, the md5 of every `mcp_` / `_mcp_` / `ai_app_` function, the triggers on the three tables, `auth.users`, the mcp and organization table counts, rows referencing the fixture id) | no |

The trap runs steps 5-7 on every exit. Any difference prints `TEARDOWN NOT CLEAN` with the ids, and nothing further is
deleted.

## While it runs (for the before-note)

- **MCP is on.** `mcp_settings.enabled` is true from the setup to the teardown (about 15 s); it is put back afterwards.
- **Locks.** Session 1 holds, for about 6 s:
  - EXCLUSIVE on `mcp_authorization_requests`;
  - SHARE ROW EXCLUSIVE on `mcp_settings` and `mcp_connections`.
  While it does, every other session's begin, view, approve, deny and `last_used_at` write waits; reads do not.
- **Deadlock.** T-N takes `mcp_authorization_requests`, then `mcp_settings`, then `mcp_connections`. A concurrent turn-off
  or "Disconnect all AI apps" takes them in the other order, and one side can end with 40P01. Nothing of that call is
  applied; the trap still runs; run again later.
- **One run at a time.** No other harness may run on the database meanwhile: they read `mcp_settings` and take the same locks.

## Commands

`T4263N_MARKER_MD5` is the md5 of the dry-run database's marker id. `T4263N_RUNNER` names the dry-run transport
wrapper, kept outside the repository. `T4263N_REPO` optionally names the checkout the migration is read from.

```bash
T4263N_MARKER_MD5=<md5> T4263N_RUNNER=<wrapper> bash run.sh <run-id> <fixture-user-id>             # expect: pristine: PASS
T4263N_MARKER_MD5=<md5> T4263N_RUNNER=<wrapper> bash run.sh <run-id-2> <fixture-user-id-2> --mutant # expect: mutant: RED
```

After a killed run:
`T4263N_ENABLED=<true|false> T4263N_UPDATED_AT='<value>' T4263N_MARKER_MD5=... T4263N_RUNNER=... bash run.sh cleanup <run-id> <fixture-user-id>`,
with the values printed by that run's precheck.

## Offline check (no database)

`python3 -I offline_check.py <python with pglast>` runs:
- `bash -n` under `/bin/bash`;
- both modes composed, with every mutant replacement matched once;
- every composed text parsed by pglast;
- `run.sh` end to end against a stub transport: PASS, RED, a pristine hole, a dirty verify, a refused precheck, a late
  session 2, and each refusal (test project marker present, transport unset, transport named kt-sql directly or through
  a symlink, marker missing, marker the test project's);
- each refusal removed by a mutation (proven applied): its case goes red, and where a second layer still stops the run
  the check says so.

`python3 -I verdict.py selftest` checks the verdict on canned outputs; with `--control-green-ok` it must fail.
