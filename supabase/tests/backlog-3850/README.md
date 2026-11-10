# BACKLOG-3850 harness

Controls for `supabase/migrations/20261111130000_backlog_3850_cancel_agent_on_join.sql`,
`rollback-3850.sql`, and the portal handler `broker-portal/lib/billing/joinCancel.ts`.

## SQL (venue: keepr-test, `~/.claude/bin/kt-sql`)

```
bash run.sh                 # base M1 M3 M4 M5 M2c rollback
bash run.sh base            # one mode
```

Each mode is ONE kt-sql call: the migration (or a mutant) followed by `controls.sql`, sent as one
implicit transaction that always ends in `RAISE`, so nothing persists. `compose.py` appends a final
`RAISE 'P3850_END_NO_RESULT'` as a backstop. It refuses a mutant whose pattern does not match
exactly once, and prints `MUTATION APPLIED` with the changed lines. Mutants drop the POSTCHECK
block, because its md5 pins would refuse the mutated body. Fixtures are created inside the call:
an auth user, a licence row (the deactivation revert needs one), an is_test personal org and
membership, stripe_customers, and an is_test brokerage.

| Scenario | Expected (base) |
|---|---|
| S1 JIT-style insert | 1 row, personal 0, organization_id NULL, payload {brokerage_organization_id, member_id, stripe_customer_id}, key `join-cancel:test:<user>:<µs>` |
| S2 insert + two updates, one transaction | 1 |
| S3 / S3u invite then accept (licensed / unlicensed) | 1 / 1 |
| S4 join, suspend (revert recreates personal), reactivate | 2, two distinct keys |
| S5 no stripe_customers | 0, join committed |
| S6 test-mode guard raises (personal org not is_test) | 0, join committed |
| S7 join as suspended / S7b personal row update | 0, personal kept |
| S8 a customer in each mode | 2 (live, test) |
| C_catalog | no anon/authenticated EXECUTE; DEFINER; search_path '' |

| Mutant | Red scenarios (measured 2026-11-10) |
|---|---|
| M1 row-count gate removed | S2 (1 -> 3) |
| M3 enqueue before the deactivated check | S1, S2, S3, S3u, S4, S7 (0 -> 1), S7b, S8 |
| M4 dedupe key without clock_timestamp | S1 (key shape), S4 (2 -> 1) |
| M5 trigger on INSERT only | S3, S3u (1 -> 0), S4 |
| M2c both EXCEPTION levels removed | S6 (42501 raises into the join) |
| rollback | md5 back to a3201c3a, enqueue function gone, join enqueues 0 |

Results: `results-2026-11-10.txt`.

## TypeScript

`python3 supabase/tests/backlog-3850/ts_mutations.py` (from the repo root, with the fix committed):
19 mutants of joinCancel.ts, reconcile.ts, suspension.ts and the template, each restored with
`git checkout --`. A run with 0 tests counts as an ERROR. Results: `ts-mutations-2026-11-10.txt`.

## Ship gate (SR R9)

1. Portal code first: keepr-test portal, then the keepr-test migration. Before the keepr-test
   apply, confirm that the deployment behind `billing_drain_url_test` (hostname only, never the
   secret) carries `joinCancel.ts`.
2. Production migration only after the main merge that carries this handler has deployed the prod
   portal. Never in a pre-merge migration batch (2.47 applies its billing migrations before its
   main merge; 3850 must not join that batch).
3. A row that arrived before the handler parks as `unknown_kind`. Requeue it:
   `update billing_outbox set run_after = now(), attempts = 0, last_error = null where kind = 'cancel_agent_on_brokerage_join' and processed_at is null and run_after = 'infinity';`
   The handler converges: a plan already canceled only gets its mirror written.
4. `rollback-3851*.sql` (backlog-3851) replace `_retire_personal_membership` with older bodies and
   would remove this enqueue. Use `rollback-3850.sql`.
