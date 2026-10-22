# BACKLOG-4012 — database controls

Migration: `supabase/migrations/20261020160000_backlog_4012_idp_join_guard.sql`
Rollback: `rollback-4012.sql` (run it before any BACKLOG-4007 rollback).

## Run

```bash
python3 compose.py /tmp/x.sql base,no_zero_bypass,...          # against an applied database
python3 compose.py /tmp/x.sql base --with-migration            # migration composed in front
~/.claude/bin/kt-sql /tmp/x.sql                                # keepr-test only
~/.claude/bin/kt-sql c14.sql                                   # C14 in a fresh transaction
```

One call = one transaction that ends in `RAISE 'P4012_RESULT …'`, so nothing persists. Each mode
runs in its own subtransaction; a mutation is an exact-once text replacement of
`pg_get_functiondef` (0 or 2+ matches raise) and its md5 must change, or the mode reports
`MUTATION NOT APPLIED`.

`baseline.sql` records the pre-migration behaviour (B1-B5) and is also the R1 check: apply,
roll back (rollback file without its BEGIN/COMMIT), run baseline, and B1-B5 read as before.

## Results

`results-2026-10-20.txt`: base 36/36; 21 mutants, every one applied; 20 red as expected and
`guard_uses_member_origin_is_idp` green by design (that function's body is the same literal set).

## Fixture notes

- Every honest JIT caller gets an `auth.sessions` row and a fresh `oauth` `auth.mfa_amr_claims`
  row; `as_user` puts the newest session id in the JWT claims, as a real token carries it.
- J11 is the SR probe: a password session and a tenant identity last written 90 days ago.
  J11b-e cover an OAuth sign-in older than 15 minutes, a fresh sign-in with another provider
  while the tenant identity is old, no session, and a password session with a fresh identity.
- C14 inside the harness accepts P0001 as well as 42501: plpgsql caches the trigger's helper
  call after the owner ran it earlier in the same transaction, which skips the EXECUTE check.
  `c14.sql` runs it first in a fresh transaction and gets 42501.
