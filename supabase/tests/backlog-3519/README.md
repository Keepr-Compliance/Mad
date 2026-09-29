# BACKLOG-3519 test harness

Proves `supabase/migrations/20260925070000_backlog_3519_commission_figures.sql`
against a real Postgres: the four `commission_*` columns, their types
(`numeric(6,3)` rates, `numeric(12,2)` gross) and every CHECK boundary.
Figures only: the split columns, the FK and the split RPC are gone (founder
decision, pm_comments 4d2e15df), so the migration depends on nothing unapplied
and this harness loads no other migration.

It creates and destroys its own `postgres:16-alpine` container. Requires
Docker (or a docker-compatible daemon on the `docker` CLI).

```bash
./run.sh all       # setup + probes + teardown
```

`stub-schema.sql` creates minimal stand-ins (`auth.users`, `organizations`,
`transaction_submissions`). It has no RLS, no `auth.role()` and none of the
Supabase roles, and is not a copy of any real migration. **The Docker harness
therefore cannot exercise the commission lock (migration section 5).**

## The commission lock: `run-venue.sh` + `lock-probes.sql`

Runs the shipped migration and `lock-probes.sql` against a Supabase-shaped
Postgres inside ONE transaction that always ends in `ROLLBACK`. The runner
strips the migration's own `BEGIN;`/`COMMIT;` (exactly two, asserted) so the
inner `COMMIT` cannot commit.

```bash
PSQL_CMD='psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -f -' ./run-venue.sh [overlay.sql]
```

An optional overlay runs first in the same transaction, to bring a test
database's policies and triggers in line with production.

28 probes: the trigger's binding in `pg_trigger` and the function's security
mode; refusal (42501) of each figure for an agent, for a broker on a submitted
row, through a SECURITY DEFINER function (authenticated and anon claims) and
for client roles with no claims; success for `service_role`, for the
migration role, for a status-only finalize, for a `closed_at` edit, for a
no-change re-send, and for an agent INSERT carrying all four figures. The
last DO block raises unless all 28 ran and passed, so the psql exit code is
the verdict.

Read the probe output per `probes.sql`'s header: `REJECTED` / `ACCEPTED`
notices carry a SHOULD label; a mismatch is the bug signal.
