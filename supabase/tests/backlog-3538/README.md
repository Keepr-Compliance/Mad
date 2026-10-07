# BACKLOG-3538 harness

Controls and mutants for `supabase/migrations/20261007210000_backlog_3538_invite_accept_hardening.sql`:

1. `guard_invite_acceptance()` stores `joined_at = now()` on an invitee's accept.
2. `claim_pending_invite()` loses EXECUTE for PUBLIC and anon (authenticated and service_role keep it).
3. `handle_new_user_invitation_link()` is dropped.

Every run is one transaction ending in ROLLBACK; nothing is committed. Layering per control:
3679 + 3538 helpers, 3679 + 3538 fixtures, the 3679 migration, `lib/preconditions.sql`,
`fp_before`, the 3538 migration (or a mutant), the control.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh precheck   # read-only venue check
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants
```

| Control | What it proves |
|---|---|
| k11 | accept sending `joined_at='2020-01-01'` stores `now()` |
| k12 | anon executing `claim_pending_invite()` gets 42501; authenticated / service_role keep EXECUTE; exact ACL |
| k13 | `handle_new_user_invitation_link()` gone (preconditions prove it existed) |
| k14 | admin role edit and service_role update keep a 2021 `joined_at` (dates set before any guard exists) |
| k15 | applying the 3538 file twice raises nothing and keeps 1-3 |
| k16 | `rollback-3538.sql` restores the fingerprint taken before the 3538 file |
| 3679 k02-k08, k99 | run unchanged on top of the 3538 file |

Mutants (`lib/mutants.py`): n01-n07 and n10 must be KILLED by an assertion FAIL. n08 (`DROP ... CASCADE`)
and n09 (no existence check) are EXPECTED SURVIVORS: no dependent object exists on a production-shaped venue,
and the function exists there. n08 is held by review (`grep -ci cascade <migration>` = 0).
