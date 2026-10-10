# BACKLOG-3856 harness

Controls and mutants for `supabase/migrations/20261010110000_backlog_3856_suspended_user_licence.sql`:
`create_active_individual_license` creates the licence row with status `suspended` when
`public.users.status = 'suspended'`; existing rows, the identity guard and the grants are unchanged.

Every run is one transaction ending in ROLLBACK; nothing is committed. Order per control:
`lib/harness.sql`, `lib/fixtures.sql` (synthetic users; asserts the venue holds the pre-3856 body),
the migration (or a mutant), the control.

```
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash run.sh controls
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test bash run.sh mutants
```

`SSH_HOST=local` runs `docker exec` on this machine (a stand-in; not NAS results).

| Control | What it proves |
|---|---|
| k1 | suspended user, no row, calls for self as authenticated -> row `suspended`, `individual`, 2 devices, 99999 |
| k2 | active user, no row -> `active` (unchanged) |
| k3 | service_role, direct and via `create_trial_license` -> `suspended` |
| k4 | suspended user with an existing `active` row -> same row returned, stored row byte-identical |
| k5 | other user's id -> 42501, no row; anon -> 42501; exact ACL; SECURITY DEFINER, search_path, return type |
| k6 | the row from k1 is restored to `active` by `admin_unsuspend_user` |
| k7a | applying the file twice raises nothing; behaviour and ACL hold |
| k7b | `rollback-3856.sql` restores the pre-3856 prosrc fingerprint and behaviour |

Mutants (`lib/mutants.py`, each pattern must match exactly once): m01-m11, every one must be KILLED.
Output: `CONTROLS: pass=X fail=Y error=Z`, `MUTANTS: killed=X survived=Y invalid=Z`.
