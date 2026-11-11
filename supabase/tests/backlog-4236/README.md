# BACKLOG-4236 PR-1 harness: cloud auto-save tables, bucket and functions

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). Each run is one
rolled-back transaction: the call ends in RAISE, so nothing persists.

| Script | What it does |
|---|---|
| `run.sh [controls file]` | Composes rollback + M1 twice + M2 twice + `lib/helpers.sql` + `lib/fixtures.sql` + the controls (`compose.py`), runs it as one call, prints `P4236_RESULT` and the wall time. |
| `controls.sql` | Single-session controls. Each block is its own subtransaction, undone at its end. `Z0_parser_counts_a_fail` is a deliberate red: `parse.py` fails the run when it is missing and reports `real_fail` without it. |
| `mutate.py <mode>\|all\|round2` | Exact-string mutation of a migration (or the rollback) file; each fragment must match the stated number of times, else the mode counts as missed. Prints `MUTATION APPLIED`, the numstat and the changed lines, runs the controls and the migration-text test, restores with `git checkout --`. Commit first. |
| `residue.sql` | Counts every object, key row, bucket, fixture user and organization, and ledger row the harness could leave. Every count must be 0. |
| `concurrency/mutants.py list\|emit <dir>` | The two-session mutants, one function each (C1a, C1b, C2, C3, C4). `emit` writes per mode a mutant and a pristine `CREATE OR REPLACE` of that one function with its REVOKE/GRANT lines and a check that rolls the call back unless the catalog `md5(prosrc)` is the expected value, plus `md5.sql` and `expected.json`. Each fragment must match the migration at HEAD and the function exactly once. |
| `rollback-4236.sql` | Drops every object of both migrations, the bucket and its objects, the key rows and the two ledger rows. |
| `concurrency/run-concurrency.sh <case>` | Two-session cases C1a, C1b, C2, C3, C4. They need both migrations applied (committed) and parallel `kt-sql` calls; the script lists each case, its expected result and its mutant, compares the results and exits non-zero on a mismatch. |

Every fixture id is derived from a value chosen at random for each run (`__RUN__` in `compose.py`;
`openssl rand` and `uuid4` in `run-concurrency.sh`), so overlapping runs never share an id. Every
composed SQL file is written to a private temporary directory that is removed on exit. The
concurrency script's EXIT/INT/TERM trap removes exactly the run's rows and verifies that none is left.

The rollback runs first in every composed call, so each function is created fresh: `CREATE OR
REPLACE` keeps an existing function's ACL, which would hide a dropped REVOKE.

The one mutant marked `want green`, `S03_upload_without_path_pin`, is measured equivalent in this
venue and kept so the claim stays checked: the blob row's path CHECK (`<owner>/<id>`) plus the
policy's owner term make the path pin redundant.
`F02_blobs_locked_per_row` is listed but not run. It is not C4's mutant: it removes the blob lock entirely, and C4 is
predicted to stay green under it (no row is then locked FOR UPDATE in payload order, so no lock cycle forms). C4's mutant
is per-row blob locking in payload order, `S_C4_blobs_locked_per_row_payload_order` in `concurrency/mutants.py`.

Results: `results-2026-11-11.txt` (ends with a catalog query showing no residue).

Deferred items: see the tracker item.
