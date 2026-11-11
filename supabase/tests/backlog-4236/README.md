# BACKLOG-4236 PR-1 harness: cloud auto-save tables, bucket and functions

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). Each run is one
rolled-back transaction: the call ends in RAISE, so nothing persists.

| Script | What it does |
|---|---|
| `run.sh [controls file]` | Composes rollback + M1 twice + M2 twice + `lib/helpers.sql` + `lib/fixtures.sql` + the controls (`compose.py`), runs it as one call, prints `P4236_RESULT` and the wall time. |
| `controls.sql` | Single-session controls. Each block is its own subtransaction, undone at its end. `Z0_parser_counts_a_fail` is a deliberate red: `parse.py` fails the run when it is missing and reports `real_fail` without it. |
| `mutate.py <mode>\|all` | Exact-string mutation of a migration (or the rollback) file; each fragment must match the stated number of times, else the mode counts as missed. Prints `MUTATION APPLIED`, the numstat and the changed lines, runs the controls and the migration-text test, restores with `git checkout --`. Commit first. |
| `rollback-4236.sql` | Drops every object of both migrations, the bucket and its objects, the key rows and the two ledger rows. |
| `concurrency/run-concurrency.sh <case>` | Two-session cases C1a, C1b, C2, C3. They need both migrations applied (committed) and parallel `kt-sql` calls; the script lists each case, what it expects and its mutant. |

Every fixture id is derived from a value chosen at random for each run (`__RUN__` in `compose.py`;
`openssl rand` and `uuid4` in `run-concurrency.sh`), so overlapping runs never share an id. Every
composed SQL file is written to a private temporary directory that is removed on exit. The
concurrency script's EXIT/INT/TERM trap removes exactly the run's rows and verifies that none is left.

The rollback runs first in every composed call, so each function is created fresh: `CREATE OR
REPLACE` keeps an existing function's ACL, which would hide a dropped REVOKE.

The one mutant marked `want green`, `S03_upload_without_path_pin`, is measured equivalent in this
venue and kept so the claim stays checked: the blob row's path CHECK (`<owner>/<id>`) plus the
policy's owner term make the path pin redundant.

Results: `results-2026-11-11.txt` (ends with a catalog query showing no residue).

## Not covered here (PR-2 and later)

- The erase sweep: deletes stored objects of fenced blobs, then the blob rows.
- Objects under a user prefix with no blob row (for example after account deletion, which cascades the
  blob rows): the sweep also lists and deletes objects in `cloud-deal-files` whose path has no
  `cloud_blobs` row and whose first segment is not a live user, limited to this bucket.
- Blobs registered and never confirmed: the sweep fences and deletes blobs with `uploaded_at IS NULL`
  older than a time limit.
- Content check: `cloud_confirm_blob` compares the stored size only. The sweep re-hashes confirmed
  objects and fences a blob whose content does not match its `sha256`, or the item records that this
  is accepted.
- Signed links: issued with an expiry of 60 seconds or less by the desktop and the portal; a link
  issued before a turn-off keeps working until it expires. A storage test issues a link, fences the
  blob and fetches again to measure it.
- Storage API behaviour (overwrite with `upsert: true`, the 50 MB limit) needs the API and is not
  provable in SQL.
- The lapse purge, quota and assignment quantity (after the MVP).
