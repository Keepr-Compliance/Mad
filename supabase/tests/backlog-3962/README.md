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
