# BACKLOG-4238 PR-1 harness: MCP OAuth server tables and functions

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). Each run is
one rolled-back transaction: the call ends in RAISE, so nothing persists.

| Script | What it does |
|---|---|
| `run.sh [controls file]` | Composes rollback + migration twice + `lib/helpers.sql` + the controls (`compose.py`), runs it as one call, prints `P4238_RESULT` and the wall time. |
| `controls.sql` | 55 single-session controls (D1–D18, B2, B3, N1–N3, N5, R1–R4, W3, CL, C9, LOG, G1, seed and fresh-apply checks). |
| `mutate.py <mode>\|all` | Exact-string mutation of the migration (or rollback) file; each fragment must match the stated number of times. Prints `MUTATION APPLIED` and the changed lines, runs the controls and the migration-text test, restores with `git checkout --`. Commit first. |
| `concurrency/mutants.py list\|emit <dir>` | The two-session mutants, one function each (D7c `M18_code_reusable` on `mcp_exchange_code`, D13b and D14 on `_mcp_bump`). `emit` writes per mode a mutant and a pristine `CREATE OR REPLACE` of that one function with its REVOKE line and a check that rolls the call back unless the catalog `md5(prosrc)` is the expected value, plus `md5.sql` and `expected.json`. Each fragment must match the migration at HEAD and the function exactly once. |
| `rollback-4238.sql` | Drops every object, the role and the ledger row. |
| `concurrency/` | Two-session controls (D7c, D13b, D14). They need the migration applied (committed) and parallel `kt-sql` calls; `run-concurrency.sh <case>` prints `<case> PASS\|FAIL <observed> expected <expected>` and exits non-zero on FAIL or an unclean teardown. |

The portal secrets used by a run are random per run (`compose.py`, `run-concurrency.sh`) and every
composed SQL file is written to a private temporary directory that is removed on exit.
`run-concurrency.sh` snapshots the `mcp_settings` columns it changes, and its EXIT/INT/TERM trap
removes the run's rows from the mcp_* tables by the run's ids, deletes the fixture user and the
`public.users` row its insert trigger creates, restores the snapshot, and checks all nine mcp_* tables,
both user rows and the settings row.

The rollback runs first in every composed call, so every function is created new and the grant
controls read the ACL that this migration sets.

Fixtures are invented and listed at the top of `controls.sql` and `lib/helpers.sql`. The PKCE pair
is RFC 7636 Appendix B. The state-function stub returns the BACKLOG-4236 state v1 shape and reads
its table through row rules only (no owner filter), so the owner-only control depends on row rules.

NOT RUN / not covered:
- The two-session cases in `concurrency/` (D7c, D13b, D14) until the migration is applied.
- Prune without SKIP LOCKED: not covered by any control.

Mutants marked `want green` are measured equivalent in this venue and kept so the claim stays
checked. Results: `results-2026-11-11.txt` (full mutant run) and `results-2026-11-12-round.txt` (this round: full controls, the new and changed mutants); each ends with a catalog query showing no residue.

Every composed call starts with `SET LOCAL pg_stat_statements.track = 'none';` so a run adds no statement entries
(measured 2026-11-12: one migration send added 110 entries without it, 2 with it). The two-session scripts do
not read pg_stat_statements.
