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
`transaction_submissions`). It has no RLS and is not a copy of any real
migration. The commission lock (migration section 5) is specified in the
migration and is built and tested separately.

Read the probe output per `probes.sql`'s header: `REJECTED` / `ACCEPTED`
notices carry a SHOULD label; a mismatch is the bug signal.
