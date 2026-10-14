# BACKLOG-3938 / BACKLOG-3940 harness

Controls, wrong-fix variants, mutants and rollback checks for:

| File | Change |
|---|---|
| `supabase/migrations/20261014120000_backlog_3938_membership_helper_oracle.sql` | `get_user_org_ids(uuid)` and `is_org_admin(uuid, uuid)` answer only for the calling user (`AND user_uuid = (SELECT auth.uid())`). `broker_get_org_features(uuid)` returns `error: 'not_member'` with no features unless the caller holds a membership row in the organization (any status) or has submitted to it. Signatures, SECURITY DEFINER, `search_path`, volatility and grants unchanged. |
| `supabase/migrations/20261014120100_backlog_3940_support_links_internal_only.sql` | `support_ticket_backlog_links`: one policy `FOR ALL TO authenticated` with `has_internal_role((SELECT auth.uid()))` in USING and WITH CHECK, replacing the two previous policies. |

Rollbacks: `rollback-3938.sql` (production's three function bodies, read 2026-10-14) and
`rollback-3940.sql` (production's two policies, verbatim). Each runs alone.

Every run is one transaction ending in ROLLBACK; nothing is committed. Layering per control:
the BACKLOG-3917 harness (`../backlog-3917/lib/harness-3917.sql`, venue parity, fixtures,
preconditions, the 3917 migration), `lib/prod-bodies-3938.sql` (production's
`_override_effective` and `broker_get_org_features`), `lib/fixtures-3938.sql`,
`lib/pins-3938.sql` (21 objects — 8 function md5s, 4 ACLs, 8 policy role+md5s, the
invite-guard trigger — must equal production, else ERROR), `lib/rollback-checks-3938.sql`,
the stack under test, the control.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh precheck    # venue equals production on every pin
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls    # both migrations
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh twice       # both migrations applied twice
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh base        # neither migration (production today): reds expected
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh variants    # wrong fixes in variants/: each must go red
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants     # lib/mutants.py: each must go red
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh rollback    # each rollback alone, then both
```

Recorded runs (this directory, unedited): `control-run.txt`, `variants-run.txt`,
`mutant-run.txt`, `rollback-run.txt`.

## Controls

| Control | What it proves |
|---|---|
| d01 | Neither helper answers about another user: signed out, signed in from another org, and **same-org pairs** (admin asks about an agent, agent asks about an admin, admin and it_admin ask about each other). Own id still answers, still active-only. |
| d02 | Every policy / trigger caller still works: signed-out roster read returns 0 rows without error, signed-out write refused, admin and agent read the roster, admin edits a member (policy + invite trigger), agent cannot, org and personal templates readable. |
| d03 | `broker_get_org_features`: outsider gets `not_member` and no features; active agent, active agent with no submission, suspended member, and a submitter with no membership row get features; signed-out gets `not_authenticated`. |
| d04 | Links: brokerage admin insert / update / delete refused; non-internal and signed-out reads return 0 rows; signed-out insert refused; internal staff with no organization membership insert, delete and read. |
| d05 | Catalogue: helper flags kept; links table has exactly one policy, FOR ALL, TO authenticated, `has_internal_role` in USING and WITH CHECK. |
| d06 | Grants pin: the three functions keep production's ACL (PUBLIC included); both `organization_members` policies still TO public; the links policy TO authenticated FOR ALL; SECURITY DEFINER / `search_path=public` / STABLE kept. |
| r01 | `rollback-3938.sql` alone with 3940 applied: the three functions' md5 + ACL equal production; the 3940 policy is unchanged. |
| r02 | `rollback-3940.sql` alone with 3938 applied: the links policies equal production; the 3938 functions are unchanged and are not production's. |
| r03 | Both rollbacks: every pin in `lib/pins-3938.sql` equals production again. |

`rollback` also runs d01-d06 after r01 and r02 to show behaviour: after r01 the 3938
checks (d01, d03) go red and the 3940 checks stay green; after r02 the reverse.

## Variants (`variants/`, each a plausible wrong fix)

| Variant | Stack |
|---|---|
| w1 | 3940 + `REVOKE … FROM anon` on the two helpers, no body guard |
| w2 | 3940 + `REVOKE … FROM PUBLIC, anon`, no body guard, policies left TO public |
| alt | both migrations + revoke PUBLIC/anon + both `organization_members` policies moved TO authenticated |
| x1 | 3938 + the internal policy added, old policies kept |
| x2 | 3938 + `ALTER POLICY … USING` only (old WITH CHECK stays) |
| x3 | 3938 + write policy replaced, read policy left |
| x4 | 3938 + INSERT and SELECT policies only (no DELETE / UPDATE) |

## Mutants (`lib/mutants.py`)

Each is a list of exact-string edits on one migration file; `apply` raises unless every
pattern matches exactly once, and `run.sh` prints `MUTATION APPLIED` with the changed line
before any control runs. 3938: guard dropped (m1, m2), guard written as
`auth.uid() IS NOT NULL` (m3, m3b), parameter ignored in favour of `auth.uid()` (s1, s4),
`broker_get_org_features` member-only (m4), active-only (m5), via `is_org_admin` (m6), check
disabled (m7), membership check without the org predicate (s2), submitter branch without
`submitted_by` (s3). 3940: old WITH CHECK kept (n1), `internal OR org admin` (n2), read
policy kept (n3), policy TO public (n4).

## Why `broker_get_org_features` admits any membership row or a submitter

The function is an entitlement lookup, not an access gate. "Any membership row in the
organization, or a submitter to it" is a superset of what the caller can already see: their
own organization, and the organizations of the submissions row-level security lets them
read (`transaction_submissions_select_public` = own submission OR `can_review_submission`).
Member status is checked app-side by every consumer before it calls this function. A
narrower rule would make the submitter's organization list fail as a whole.

## Regression runs on the other harnesses (with the 3938 file layered)

- `../backlog-3917`: `MIG_OVERRIDE` = 3917 migration + 3938 file, 13/13 controls. The same
  run with a trailing `RAISE` that fires only when the guarded bodies are present errors,
  proving the override was consumed.
- `../backlog-3503`, `../backlog-3618`, `../backlog-3473`: same verdicts with and without the
  3938 file, except backlog-3473 C16, whose assertion that a non-member's
  `broker_get_org_features` cell carries no `error` now fails by design (its mutant m50a,
  "broker gains a membership check", is this change). Historical harnesses are not edited.
