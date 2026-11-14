# BACKLOG-4244 harness: MCP data tools list_deals, get_deal, get_deal_checklists

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). One run is one
transaction that ends in RAISE, so nothing persists.

Precondition: the test project already holds `20261112190000_backlog_4236_cloud_autosave_schema.sql`
as edited for BACKLOG-4243 (the 13 cloud writes take `p_expected_user_id` first) and
`20261112170000_backlog_4238_mcp_oauth_server.sql`. The run reads the catalog first and stops before
any change when the 13 writes are not at the new signature.

| Script | What it does |
|---|---|
| `harness.py run [--fixtures=<file>] [--only=<mutant prefix,...>] [--no-mutants] [--print] [--dump <dir>]` | Composes and runs one call: catalog record (`PRE_*`), signature stop, `rollback-4244.sql`, the migration twice, `lib/helpers.sql`, `lib/fixtures.sql`, `lib/probes.sql`, the fixtures, every probe on the migration as written (`C_*`), the reader outputs used by the portal tests (`FX_*`), then every mutant (`M_*`). Exits non-zero on a failed control, an unexpected mutant result or zero controls. `--fixtures` writes the `FX_*` outputs with ids and run instants replaced by fixed values (the portal test fixture `broker-portal/__tests__/mcp/fixtures/data-tools-4244.json`). |
| `lib/helpers.sql` | Calls as a role, the cloud writes as the user, AI-app connections written as the database owner, the three tools called as anon. Rate counters for calls are cleared before each tool call inside the transaction. |
| `lib/fixtures.sql` | Five users in one brokerage, their deals, people, checklists and items, written through the real cloud write functions; see the header for who holds what. |
| `lib/probes.sql` | One probe per control; each returns `PASS` or `FAIL: <detail>`. |
| `rollback-4244.sql` | Deletes the log rows the earlier CHECKs would refuse, restores both `mcp_call_log` CHECKs, drops the eleven functions and the ledger row. |
| `portal-mutate.py [mode ...]` | Mutants of the portal code, each run against the jest suites that should catch it; restores each file from the text it read. Commit first. |

Mutants: each is an exact-string replace on one function's text from the working tree (the script stops
when a fragment does not match exactly once). In the database each is created in a subtransaction
(readers as `mcp_reader`) and checked by `md5(prosrc)`, ACL, `relrowsecurity` or `rolbypassrls` before
its probe runs; the subtransaction is then undone. Mutants marked `want=green` are expected to stay
green because another layer makes them equivalent (row level security, the composite key
`(cloud_deal_id, owner_user_id)` under an owned deal, or `_mcp_txt` stripping control characters
again); they are kept so the claim stays checked.

Every composed call starts with `SET LOCAL pg_stat_statements.track = 'none';` and ends with
`select extensions.pg_stat_statements_reset()`.

Results: `results-2026-11-14.txt` (ids replaced by fixed values).

NOT RUN: two-session timing (a reader under a concurrent write). The single-snapshot property rests on
the readers being STABLE (checked in the catalog by `p_grants`), not on a two-session run.
