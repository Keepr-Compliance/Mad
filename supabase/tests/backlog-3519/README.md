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

**`setup: OK` means "the table exists", not "3503 applied cleanly".**
(SR review addendum, `pm_comments` on BACKLOG-3519.) `run.sh` applies 3503
with `|| true` specifically because the role error above is expected in this
stub environment — that is correct, not a defect being hidden — but it means
a 3503 that failed for a genuinely different reason would still produce
`setup: OK` here. This harness proves 3519's DDL against whatever of 3503
got created before the expected role error; it does not re-prove 3503 itself
(`supabase/tests/backlog-3503/` does that, against the real Supabase roles).

**This harness resolves `MIGRATION_3503` by globbing the working tree**
(`ls supabase/migrations/*_backlog_3503_commission_agreements.sql`), so it
runs whatever shape of 3503 your current branch happens to have — pre-trim
or post-trim (BACKLOG-3503's fee-trim PR #2718). A result is only as current
as the branch it was run on; re-run after syncing with `develop` before
trusting it, and note which SHA you ran at (see "What was actually run"
below).

## What was actually run and found

**First run — 2026-09-25, this branch @ `979b5029d`, BEFORE the develop
sync.** 18 probes, against the branch's own (then pre-trim) copy of 3503 —
see the stamped-SHA warning above; this run's 3503 shape no longer exists on
`develop`. The first draft of `transaction_submissions_split_sum_check` did
**not** pass — probe 10 (asymmetric split) was wrongly accepted, because
`agent_pct + brokerage_pct = 100` evaluates to `NULL` (not `FALSE`) when one
side is `NULL`, and a CHECK only rejects `FALSE`. The migration's CHECK was
corrected to test `IS NOT NULL` on both columns explicitly before the sum
comparison; see that constraint's own comment in the migration file.

**Second run — 2026-09-25, this branch @ `6ab46dbb` (synced with
`origin/develop`), against develop's real POST-TRIM 3503** (confirmed:
`grep -c 'office_fee\|franchise_fee'` on the resolved `MIGRATION_3503` file
returns `1`, not the `35` the pre-sync branch had). 19 probes — the original
18 (acceptance case, the nullable-snapshot case which never blocks, rate
boundaries at 0/100/100.001/-0.001, a 3-decimal rate at 2.375 — the reason
`commission_offered_rate`/`commission_actual_rate` are `numeric(6,3)` and
not `numeric(5,2)` — the split-sum boundary at 99.99/100/100.01, the
asymmetric split fill, reason length at 0/1/2000/2001 chars, a negative
gross amount, a bogus FK, a real FK, and the index's presence) plus a new
19th (SR review addendum A5, `pm_comments` on BACKLOG-3519): the FK's
`ON DELETE` action, read from `pg_constraint.confdeltype` rather than
inferred from probes 16-17's accept/reject behaviour — confirmed `a`
(NO ACTION), the correct semantics for a frozen compliance snapshot.

All 19 passed.
