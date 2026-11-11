# BACKLOG-4238 PR-1 harness: MCP OAuth server tables and functions

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). Each run is
one rolled-back transaction: the call ends in RAISE, so nothing persists.

| Script | What it does |
|---|---|
| `run.sh [controls file]` | Composes rollback + migration twice + `lib/helpers.sql` + the controls (`compose.py`), runs it as one call, prints `P4238_RESULT` and the wall time. |
| `controls.sql` | 48 single-session controls (D1–D18, B2, B3, N1–N3, N5, CL, C9, LOG, G1, seed and fresh-apply checks). |
| `controls-timeout.sql` | C8: a statement timeout inside the read block returns `timeout` and keeps the log row. |
| `mutate.py <mode>\|all` | Exact-string mutation of the migration (or rollback) file; each fragment must match the stated number of times. Prints `MUTATION APPLIED` and the changed lines, runs the controls and the migration-text test, restores with `git checkout --`. Commit first. |
| `rollback-4238.sql` | Drops every object, the role and the ledger row. |
| `concurrency/` | Two-session controls (D7 concurrent redemption, D13 busy, D14 40 parallel calls). They need the migration applied (committed) and parallel `kt-sql` calls; `run-concurrency.sh` lists the cases and their mutants. |

The portal secrets used by a run are random per run (`compose.py`, `run-concurrency.sh`) and every
composed SQL file is written to a private temporary directory that is removed on exit.
`run-concurrency.sh` snapshots the `mcp_settings` columns it changes, and its EXIT/INT/TERM trap
removes exactly the run's fixture rows, restores the snapshot and verifies both.

The rollback runs first in every composed call, so every function is created new and the grant
controls read the ACL that this migration sets.

Fixtures are invented and listed at the top of `controls.sql` and `lib/helpers.sql`. The PKCE pair
is RFC 7636 Appendix B. The state-function stub returns the BACKLOG-4236 state v1 shape and reads
its table through row rules only (no owner filter), so the owner-only control depends on row rules.

Behaviour notes for the interface:
- A redemption that fails its checks (verifier, client, redirect address, resource, allowlist) uses
  up the code, removes its pending connection and writes a `code_rejected` event.
- `mcp_check_access` returns `not_connected` while the kill switch is off.

Mutants marked `want green` are measured equivalent in this venue and kept so the claim stays
checked. Results: `results-2026-11-11.txt` (ends with a catalog query showing no residue).
