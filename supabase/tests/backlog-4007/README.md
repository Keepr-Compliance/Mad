# BACKLOG-4007 PR-1 — database controls

Migration: `supabase/migrations/20261020100000_backlog_4007_onboarding_billing_setup.sql`
Rollback: `rollback-4007-pr1.sql` (restores the three replaced bodies and checks their md5s).

## Run

```bash
python3 compose.py /tmp/x.sql base,edit_activates_draft,...            # against an applied database
python3 compose.py /tmp/x.sql base --with-migration                    # migration composed in front
~/.claude/bin/kt-sql /tmp/x.sql                                        # keepr-test only
```

One call = one transaction that ends in `RAISE 'P4007_RESULT …'`, so nothing persists. Each mode
runs in its own subtransaction; a mutation is an exact-once text replacement of
`pg_get_functiondef` (0 or 2+ matches raise) and its md5 must change, or the mode reports
`MUTATION NOT APPLIED` instead of a result.

## Results (keepr-test, 2026-10-19, migration applied) — `results-2026-10-19.txt`

- base: 48 / 48 pass.
- 25 mutants, every one applied (md5 changed), every one red. Per-mode reds are in the results file.
- `C_S5_complete_active_bump_one_sync` also reds under the two UTC-date mutants, but only in the
  evening window when the UTC and Pacific dates differ. `C_T2` / `C_T3` pin the date helper and red
  at any hour.

## Controls run outside this harness

- C-M1 (backfill): apply + rollback round trip in one rolled-back call: outbox rows 10 -> 10,
  every deal's status / version / contact columns unchanged, 2 contacts created; after rollback the
  deals are unchanged, the ledger row is gone and `org_contacts` does not exist.
- Re-run: the migration applied twice in one call succeeds (2 contacts, not 4).
- C-1 (PostgREST overloads): both argument sets of `admin_save_deal` (9 named, and 10 with
  `p_start_date`) called through PostgREST on keepr-test reach a single function (`42501`
  permission denied as anon, not `PGRST203`). Positive control: a scratch pair
  `p4007_probe(a)` / `p4007_probe(a, b DEFAULT NULL)` returned `PGRST203` for `{"a":1}`; the pair
  was dropped afterwards.

## Why C_R3 is a real control

A superseded reminder is marked with `processed_at`. The drain only claims rows with
`processed_at IS NULL` (`billing_outbox_claim`, 20261011230913_backlog_3845_billing_foundation.sql:576),
so a superseded row is never sent.
