# BACKLOG-3946 harness

Controls, wrong-fix variants, mutants and rollback checks for:

| File | Change |
|---|---|
| `supabase/migrations/20261014152722_backlog_3946_staff_helpers_caller_only.sql` (A) | `has_internal_role(uuid)`, `has_permission(uuid, text)`, `has_any_permission(uuid, text[])`, `is_super_admin(uuid)`, `get_user_permissions(uuid)` answer only for the calling user (`AND check_user_id = (SELECT auth.uid())`). A service-role or NULL-uid caller gets false / no rows. Bodies are production's definitions plus that line; signatures, SECURITY DEFINER, `search_path`, volatility and grants unchanged. |
| `supabase/migrations/20261014152839_backlog_3946_identity_helpers_signed_in_only.sql` (B) | 22 policies that call a helper move from TO public to TO authenticated, then EXECUTE is removed from PUBLIC and anon on the seven helpers (the five above, `get_user_org_ids`, `is_org_admin`). |
| `supabase/migrations/20261014152904_backlog_3946_support_links_table_grants.sql` (C) | `support_ticket_backlog_links`: anon holds no privileges; authenticated holds SELECT, INSERT, DELETE. RLS unchanged. |

Rollbacks: `rollback-A.sql` (production's five definitions, verbatim), `rollback-B.sql`
(production's ACLs and policy roles), `rollback-C.sql` (production's table grants). Each runs alone.

Every run is one transaction ending in ROLLBACK; nothing is committed. Layering per control:
the BACKLOG-3917 harness (`../backlog-3917/lib/`, venue parity, fixtures, preconditions, the
3917 migration), the BACKLOG-3938 libs (`../backlog-3938/lib/prod-bodies-3938.sql`,
`fixtures-3938.sql`, `pins-3938.sql`), the 3938 and 3940 migrations, `lib/parity-3946.sql`
(venue parity for `stripe_customers_select_own`), `lib/catalog-3946.sql` (production's
catalogue state for 8 functions and 28 helper policies, read 2026-10-14), `lib/pins-3946.sql`
(venue must equal it, else ERROR), `lib/fixtures-3946.sql`, `lib/capture-3946.sql`
(per-actor, per-table visibility fingerprint before the change), the stack under test, the control.

Run sets one at a time: they share fixture ids.

```
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh precheck    # venue equals production on every pin
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh controls    # A + B + C
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh twice       # A + B + C applied twice
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh base        # none applied (production today): reds expected
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh variants    # wrong fixes: each must go red
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh mutants     # lib/mutants.py: each must go red
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh rollback    # each rollback alone, then all three
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh one <control> <stack files...>
```

`MIG_A_OVERRIDE`, `MIG_B_OVERRIDE`, `MIG_C_OVERRIDE` replace a migration file.

Recorded runs (this directory, unedited): `control-run.txt`, `twice-run.txt`, `base-run.txt`,
`variants-run.txt`, `mutant-run.txt`, `rollback-run.txt`, `rollback-negative-run.txt`.

## Controls

| Control | What it proves |
|---|---|
| e01 | No helper answers about another user: signed out; a signed-in agent about staff; staff about an agent; staff about fellow staff. Own id still answers (true and false cases). |
| e02 | Visibility fingerprint: 26 tables x {anon, agent, org admin, staff, super admin} return exactly what they returned before the change; no signed-out read errors (links excepted: grant removed by C). Two sanity checks that the fingerprint sees rows. |
| e03 | Helper-gated writes and RPCs: super admin grants an internal role, other staff and anon cannot; staff create an internal invitation, an agent cannot; org admin edits a member, an agent cannot; `admin_search_users`, `admin_get_org_plan`, `admin_list_user_devices` (three argument patterns) allow and refuse the right callers. |
| e04 | Catalogue: no TO public/anon policy calls a helper; anon (incl. PUBLIC) executes none of the 7; all 7 keep authenticated + service_role EXECUTE, SECURITY DEFINER, STABLE, `search_path=public` (aggregate and one check per helper); links grants exact. |
| e05 | Links: staff insert, read, delete; brokerage admin insert refused; anon insert and delete refused by grant; signed-in update refused. |
| e06 | Strict: a second asker/target pair per helper (org admin about staff; staff about a target who lacks the role); anon EXECUTE refused (42501) for each of the 7; service_role gets false / 0 rows from each of the 5 guarded helpers; anon SELECT on links refused. |
| r01 | `rollback-A.sql` alone after A + B + C: five bodies equal production; B's ACLs and policy roles and C's grants untouched. |
| r02 | `rollback-B.sql` alone: seven ACLs and all 28 helper policies equal production; A's bodies and C's grants untouched. |
| r03 | `rollback-C.sql` alone: links grants equal production; A and B untouched. |
| r04 | All three rollbacks, then `lib/pins-3946.sql` again: every pin equals production. |

`rollback` also runs e01-e06 after each rollback to show which checks go red; after all three
the red set equals `base`. `rollback-negative-run.txt` runs r01-r04 with no rollback applied
(each goes red).

## Variants (wrong fixes)

| Variant | Stack |
|---|---|
| v1-alt3938 | A + revoke and retarget for `get_user_org_ids` / `is_org_admin` only + C |
| v2-revoke-no-retarget | A + EXECUTE removed on all 7, policies left TO public + C |
| v3-guard-hir-only | guard on `has_internal_role` only + B + C |
| v4-noarg-is-internal | a new no-argument `is_internal()`, uuid helpers left as they are + C |
| v5-item-text-literal | A + four helpers revoked, two `organization_members` policies moved + C |
| A-only, A+C, B-without-A, C-only | partial stacks |

## Mutants (`lib/mutants.py`)

27 mutants, each an exact-string edit that must match once (else INVALID) and prints
`MUTATION APPLIED` with the diff: guard dropped per helper (mA1-mA5), guard replaced by
`auth.uid() IS NOT NULL` (mA6), parameter ignored (mA7-mA10), one revoke dropped or PUBLIC kept
(mB1, mB2, mB6), one policy not moved (mB3-mB5), links grant variants (mC1-mC4),
`has_internal_role` as SECURITY INVOKER with no guard (mS1), `get_user_permissions` without
SECURITY DEFINER (mS2), and a service-role exemption in each guarded helper (mS3-mS7).
