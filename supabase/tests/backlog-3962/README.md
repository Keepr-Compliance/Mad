# BACKLOG-3962 PR1 harness

Controls for `supabase/migrations/20261112100000_backlog_3962_domain_claims.sql` and the portal code
in `broker-portal/lib/domain/`, `broker-portal/lib/actions/domainClaim.ts`.

## SQL (venue: keepr-test, `~/.claude/bin/kt-sql`)

```
bash run.sh                 # base, every mutant, rollback
bash run.sh base            # one mode
```

Each mode is ONE kt-sql call: the migration (or a mutant of it) followed by `controls.sql`, sent as
one implicit transaction that always ends in `RAISE`, so nothing persists. `compose.py` refuses a
mutant whose pattern does not match exactly once and prints `MUTATION APPLIED` with the changed
lines. Run it BEFORE the migration is applied to the venue (the base text runs `CREATE TABLE`).
Once applied, run it on a venue without the table, or drop it inside the composed text first.

Results: `results-2026-11-10.txt` (base 63/63; every mutant red; rollback removes every object).

## Portal

```
python3 supabase/tests/backlog-3962/ts_mutations.py [name ...]
```

Needs a committed tree. Results: `ts-mutations-2026-11-10.txt`.

## PR2 (`20261112110000_backlog_3962_recheck_lapse_cutoff.sql`)

```
bash run.sh pr2 P2_no_null_guard P2_cutoff_any_status P2_cutoff_on_last_checked P2_no_cutoff P2_pin_wrong_md5
bash run.sh pr2_live        # controls-pr2.sql against the body applied on the venue
```

`pr2` modes need the PR1 table on the venue. Each composes `rollback-3962-pr2.sql` (the PR1 body),
the PR2 migration or a mutant of it, and `controls-pr2.sql`, in one transaction that ends in RAISE.
Results: `results-pr2-2026-11-10.txt`.

## PR3a (`20261112113000_backlog_3962_domain_capture.sql`)

```
bash run.sh pr3 C_always_unassigned C_always_active C_ignore_notice ...   # see MUTANTS3 in compose.py
bash run.sh pr3_rollback
KEEPR_3962_APPLIED=1 bash run.sh pr3     # once applied: the composed text runs rollback-3962-pr3.sql first
bash run.sh pr3_live                     # controls-pr3.sql against the objects applied on the venue
bash concurrency-pr3.sh [base|C_no_lock|C_no_lock_no_fallback]
```

`concurrency-pr3.sh` COMMITS a small fixture (two sessions cannot see each other's uncommitted rows),
runs two overlapping switch calls, prints the result, and deletes the fixture. A mutant mode installs
the mutated `_domain_capture_switch` for the run and restores the migration's body (md5 printed).
Results: `results-pr3-2026-11-10.txt`.

## PR3b additions (same migration, 20261112113000)

`domain_capture_history(uuid)`, the final opt-out (`no:opted_out` in `_domain_capture_eval`), the
`name` and `last_defer_reason` fields, and the `last_defer_reason` column with its clearing trigger.
New cases: K07, Q01-Q02, W10-W11, B06-B08, Y01-Y04. New mutants: `C_no_opt_out_skip`,
`C_no_defer_reason`, `C_defer_not_cleared`, `C_history_no_admin_check`, `C_history_grant_anon`.
Results: `results-pr3b-2026-11-11.txt`.
