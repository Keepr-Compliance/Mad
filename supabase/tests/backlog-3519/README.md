# BACKLOG-3519 test harness

Proves `supabase/migrations/20260925070000_backlog_3519_commission_figures.sql`
against a real Postgres: the four `commission_*` columns, the frozen
`split_*` snapshot columns, every CHECK constraint, the FK to
`agent_split_agreements`, and the index on it.

Unlike `backlog-3503/` and `backlog-3364/`, this does not reach a shared SSH
test venue. It creates and destroys its own disposable `postgres:16-alpine`
Docker container, so there is no production-safety gate to run — there is
nothing on the container that could be production.

## Run it

Requires Docker (or a docker-compatible daemon reachable via the `docker`
CLI — this was verified against [colima](https://github.com/abiosoft/colima)
on a machine with no Docker Desktop installed).

```bash
./run.sh all       # setup + probes + teardown
```

or step by step:

```bash
./run.sh setup      # start the container, apply stub-schema.sql, then the
                     # SHIPPED 3503 migration, then the SHIPPED 3519 migration
./run.sh probes      # run probes.sql, read the output per its own header
./run.sh teardown    # remove the container
```

## What `stub-schema.sql` is, and is not

3503's and 3519's migrations reference tables this repo does not ship as a
runnable fixture outside the real Supabase project: `auth.users`,
`organizations`, `users`, `organization_members`, `transaction_submissions`.
`stub-schema.sql` creates minimal stand-ins for exactly the columns those
migrations' FKs and this harness's probes touch. It carries **no RLS** and is
**not a copy of any real migration** — this harness proves 3519's DDL
(columns, CHECK constraints, the FK, the index), not RLS policies, which
3503 already tests in its own harness (`supabase/tests/backlog-3503/`).

## Why 3503 is expected to partially fail here, and why that's fine

The stub schema has no `anon` / `authenticated` / `service_role` Postgres
roles (those are a Supabase platform default, not something a bare
`postgres:16-alpine` container has). 3503's migration hits
`REVOKE ... FROM anon, authenticated` and errors out at that point — but by
then `agent_split_agreements` (with all its columns and constraints),
its index, `organization_members.deactivated_at`, its trigger, and
`can_write_split_agreements()` / `is_active_split_member()` /
`split_agreement_in_force()` have all already been created. That is
everything 3519 needs. `setup` checks for `agent_split_agreements` and fails
loudly if it is somehow missing rather than silently continuing.

## What was actually run and found (2026-09-25)

18 probes: the acceptance case, the nullable-snapshot case (never blocks),
rate boundaries at 0/100/100.001/-0.001, a 3-decimal rate (2.375, the reason
`commission_offered_rate`/`commission_actual_rate` are `numeric(6,3)` and not
`numeric(5,2)`), the split-sum boundary at 99.99/100/100.01, an asymmetric
split fill, reason length at 0/1/2000/2001 chars, a negative gross amount, a
bogus FK, a real FK, and the index's presence.

All 18 passed on the migration as shipped. The first draft of
`transaction_submissions_split_sum_check` did **not** — probe 10 (asymmetric
split) was wrongly accepted, because `agent_pct + brokerage_pct = 100`
evaluates to `NULL` (not `FALSE`) when one side is `NULL`, and a CHECK only
rejects `FALSE`. The migration's CHECK was corrected to test
`IS NOT NULL` on both columns explicitly before the sum comparison; see that
constraint's own comment in the migration file.
