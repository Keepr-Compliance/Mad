# BACKLOG-4263 PR-1 harness: MCP data tool list_all_deals

Venue: a test project through `~/.claude/bin/kt-sql` (it refuses the production ref). One run is one
transaction that ends in RAISE, so nothing persists.

Precondition: the test project holds `20261114110000_backlog_4244_mcp_data_tools.sql` (ledger row) and
either nine anon-callable mcp functions and none of this migration's (before the apply) or ten and both
(after it); the run stops before any change otherwise. `--simulate-applied` prepends the migration and
its ledger row inside the transaction to exercise the second state.

`C_p_rowmax` measures the largest row the reader can emit (every text at its cut in 4-byte characters,
every number at 30 characters) and requires it under 2000 bytes, so the first row of a page always fits.

| File | What it does |
|---|---|
| `harness.py run [--no-mutants] [--only=<prefix,...>] [--fixtures=<file>] [--print] [--dump <dir>]` | Composes and runs one call: catalog record (`PRE_*`), precondition stop, `rollback-4263.sql`, the migration twice, `../backlog-4244/lib/helpers.sql`, `lib/fixtures.sql`, `lib/probes.sql`, the fixtures, every control (`C_*`), the reader outputs used by the portal tests (`FX_*`), then every mutant (`M_*`). Exits non-zero on a failed control, an unexpected mutant result or zero controls. `--fixtures` writes `broker-portal/__tests__/mcp/fixtures/data-tools-4263.json` with ids replaced by `<id:n>` (numbered in id order). |
| `harness.py run --apply-trial=<apply file> [--break-md5]` | Runs the apply file (BEGIN/COMMIT removed) in a transaction that ends in RAISE and reports whether its post-check passed. `--break-md5` changes the expected reader md5 first; the post-check must then raise. |
| `gen-apply.py <out>` | Writes the apply file: the migration, the ledger row, and a post-check DO that raises unless the two functions, the anon-callable set (10), the mcp function count (41), the tool CHECK and the ledger are as stated. |
| `catalog-check.sql` | Read-only, one statement: every anon-callable mcp function with md5(prosrc), and the new objects. |
| `rollback-4263.sql` | Deletes the tool's call-log rows, restores the 4244 tool CHECK, drops both functions and the ledger row. |

Mutants: exact-string replaces on one function's text from the working tree (the script stops when a
fragment does not match its stated count), each created in a subtransaction (the reader as
`mcp_reader`) and checked by `md5(prosrc)`, ACL or a DDL condition before its probe runs. Mutants
marked `want=green` stay green because row level security is a second layer (owner term alone, RLS
alone); both together go red.

Page bound: rows in `cloud_deals.id` order while at most 500 rows and the sum of
`octet_length(row::text) + 2` is at most 85000. `C_p_bound` walks a 420-deal user (byte bound binds)
and a 600-deal user (row bound binds); `C_p_boundary` grows addresses so the rows count exactly 85000
(last row kept) and then 85001 (last row moves to the next page).

A removed deal: at this ref `cloud_delete_deal` deletes the row, so `C_p_removed` is an assertion with no
filter to mutate. The removed-deal filter arrives with PR-2 (plan section 6.2).

Every composed call starts with `SET LOCAL pg_stat_statements.track = 'none'` and calls
`extensions.pg_stat_statements_reset()`; run `kt-sql -c "select extensions.pg_stat_statements_reset()"`
after each batch as well.
