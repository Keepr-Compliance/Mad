# BACKLOG-3849 harness

Controls for `supabase/migrations/20261013100000_backlog_3849_billing_drain.sql` (S4) and for
the `billing_outbox_claim` behaviour the drain relies on (S1-S3).

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls [fragment]   # S4, one rolled-back transaction each
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]   # S4 mutants (lib/mutants.py)
SSH_HOST=<alias> PG_CONTAINER=<container> bash concurrency/run.sh            # S1-S3, throwaway database, dropped after
```

| Control | What it proves |
|---|---|
| s4a | `billing_drain_invoke(text)`: no EXECUTE for anon, authenticated, service_role, PUBLIC. `billing_drain_secret()`: service_role only, SECURITY DEFINER. Both `search_path=''`. |
| s4b | one 64-hex secret, unchanged by a second apply; service_role reads it; anon/authenticated refused by grant; an EXECUTE holder whose JWT role is not service_role refused by the function. |
| s4c | target outside `live`/`test` -> 22023 (before any vault lookup); no URL -> 55000; with a URL the queued request is a POST with the secret header and a 60 s timeout; service_role and authenticated cannot fire it. |
| concurrency | S1 two overlapping claims take a row once (no row lock -> twice); S2 a claim inside the lease takes nothing (no lease predicate -> re-claim); S3 a live claim never takes a test row (no mode filter -> it does); a parked row (`run_after = infinity`) is never claimed; the drain's guarded late write changes nothing; the claim itself has no try cap (the drain parks at claim). Removing only `SKIP LOCKED` stays green by design: it changes waiting, not the result. |

The S4 transactions roll back, so the vault rows and the queued pg_net request are never committed
or sent. The concurrency script needs real commits, so it uses its own database and drops it
(`dropped_check=0`). Secrets are compared in SQL and never printed.
