# BACKLOG-3860 PR-1 harness (solo free trial, database layer)

Files under test: `supabase/migrations/20261031140000_backlog_3860_solo_trial.sql` and
`rollback-3860.sql`.

Venue: keepr-test through `~/.claude/bin/kt-sql`. Every call is ONE transaction that ends in
RAISE, so nothing persists (the 4036 pattern). The 3845 NAS container was not used.

```
python3 run.py controls     # 34 function-level checks, unmutated
python3 run.py scenarios    # 9 apply-level scenarios: apply once/twice, 4 drift pins, 3 rollback
python3 run.py mutants      # baseline + scenarios, then every mutant: KILLED / SURVIVED / INVALID
```

- Function mutants (`controls.sql`, `apply_mode`): exact-once replace on `pg_get_functiondef`,
  md5 must change, else `MUTATION NOT APPLIED` (INVALID). Catalog mutants (m05, m05b) print the
  privilege before and after.
- Text mutants (`run.py`, `TEXT_MUTANTS`): exact-once replace on the migration or rollback text,
  then the named scenario or the control set.
- Fixtures: users made in the run (`p3860-*@example.test`), personal organizations made by the
  real functions (the signed-in wrapper, or the internal function as the service role).

| Control | What it proves |
|---|---|
| T1 | a second start for the same user answers `refused / already_used` (the ledger primary key alone would raise instead); one ledger row; no new override |
| T2 | override is `{"enabled": true, "paid_through": started_at + days, "source": "trial"}`; ledger row matches; `_override_effective` true |
| T3 | setter as super-admin changes 14 → 7: running trial unchanged, next trial 7 days; audit row holds old and new |
| T4 | active brokerage member: `has_membership`, no trial; deactivation trigger attaches a personal org, no trial; later sign-in no trial; direct start refused for a member and a suspended licence |
| T5 | setter refuses sales and non-staff (42501) and bad input; reader is staff-only with `can_edit`; start and ledger refused to signed-in users; catalog grants |
| T6 | existing personal org → `exists` → no trial |
| T7 | switch off → `created` without a trial; direct start `off`; solo_trial row absent → `off` |
| T8 | Stripe grant replaces a live and an ended trial; refuses sourceless (3845 k07 shape), `support`, any other source; still replaces Stripe; a trial never replaces a support grant |
| T12 (S3-S6) | a drifted wrapper / grant / internal function / key check stops the migration |
| T12b (S1) | the key check not widened → apply fails at the seed |
| T12c | `days` null / 0 / 91 and an unknown key are refused by the table |
| T13 | trial write fails after the ledger row: ensure still answers `created`, org and membership exist, no ledger row, no override |
| T14 | null / 0 / -1 / 91 length (range check removed inside the run): `bad_length`, nothing written |
| S7-S9 | rollback restores the pre-3860 md5s and key check; stops while a trial override exists; flag removes them |

T14 mechanism (SR C2): the range check is dropped inside the rolled-back run, because the table
forbids a bad length. No mutant is listed for the `no_end_date` refusal (unreachable once the
length check exists).
