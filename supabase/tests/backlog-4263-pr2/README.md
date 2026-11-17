# BACKLOG-4263 PR-2 harness: todo server core

(PR-1's harness for list_all_deals is in `../backlog-4263/`.)

Venue: the test project through `~/.claude/bin/kt-sql` (it refuses the production ref). Every call is one
transaction that ends in RAISE, so nothing persists; each call resets `pg_stat_statements` afterwards.

| Script | What it does |
|---|---|
| `harness.py run --controls` | rollback, migration, fixtures (through the earlier one-way functions), migration again (re-run + backfill), then 34 controls, each in a subtransaction undone at its end. |
| `harness.py run --mutants=a-b` / `--only=<mode,...>` | the same setup, then mutants: an exact-string replace on one unit of the migration (stops before sending if a fragment does not match), applied in the database and checked by `md5(prosrc)`, ACL or catalogue presence before its probe runs. `want=green` = measured equivalent. |
| `harness.py check` | offline: every mutant fragment matches; every name in `supabase/contracts/cloud-todo-change-v1.json` appears in the migration. |
| `concurrency/run-c14.sh pristine \| seq_no_head \| sr7` | two writers commit out of order, a reader between their commits, a second reader from its cursor. Commits one private scratch schema (the allocator text read from the migration) and drops it in its trap, then checks it is gone. `seq_no_head` is the plan's C14 mutant; `sr7` is the allocator without its row lock. The scratch copy has one test hook: a writer can sleep between taking its numbers and its head update. |
| `rehearse.py` | catalogue facts of every function the migration creates or replaces (`catalog-facts.json`), and a rollback rehearsal (migration, fixtures, a soft-removed deal, rollback, every replaced body back at its traced md5). |
| `gen_apply.py` | writes `apply-20261118110000.sql`: migration verbatim, ledger row, post-check. |
| `gen_rollback.py`, `gen_readers.py`, `gen_gates.py` | generate `rollback-4263.sql` and the two generated sections of the migration from the earlier files. |

| `portal_fixture_check.py <out.json>` | runs PR-1's harness with this migration applied after PR-1's and writes the list_all_deals fixture from the replaced reader (for the portal suites). |

Results: `results-2026-11-17.txt`.

Not run here (need the migration committed on the test project): the two-session turn-off race on the new
writers and the 2 s `busy` answer for an AI-app change behind a held head.
