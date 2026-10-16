# BACKLOG-3851 PR-2 piece 1 harness — `/setup` completes an invite

Controls, mutants, drift, rollback and a two-session control for
`supabase/migrations/20261016130000_backlog_3851_setup_completes_invite.sql` (NEW), which
replaces the body of `auto_provision_it_admin(text,text,text)` (same signature, grants,
SECURITY DEFINER, `search_path = public`; body md5 `a88466cc…` → `0ca68b8c…`).

## Venue

Every single-session run is ONE transaction ending in ROLLBACK, through
`../backlog-3851/run.sh one` (the 3851 prelude: venue = production pins, synthetic fixtures
`<name>-3917@example.test`). Stack, in order:

| File | Role |
|---|---|
| `20261015152446_backlog_3851_license_model.sql` (M1) | applied on production |
| `lib/pin-setup.sql` | venue fingerprint (`../backlog-3851/lib/fingerprint-3851.sql`) must equal production read 2026-10-15 (ledger head `20261016033654`): `685c78e6381c2afbbb4e05dfb4e64f07\|41`, else ERROR |
| `20261016100100_backlog_3851_paygo_revert.sql` (M2) | not yet on production; does not touch `auto_provision_it_admin` |
| `lib/helpers-setup.sql` | `pg_temp.prov(user, tenant)` calls the function as `authenticated` with JWT `{sub, role, email}` |
| NEW | the change under test |

`race.sh` (S14) clones the venue into a throwaway database `race3851s`, commits the stack and
two fixture organizations there, runs two sessions, and drops the database on every exit path.

## Running

```
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh controls [fragment]
... run.sh base       # without NEW (today's body): every control red
... run.sh twice      # NEW applied twice
... run.sh mutants    # lib/mutants.py: each must turn its named control red
... run.sh drift      # NEW aborts on an unexpected body
... run.sh rollback   # rollback-3851-setup.sql restores the 3882 body; negative without it
... run.sh race       # S14 (two sessions); race.sh <mutated NEW> for X6
```

## Controls

| Control | Proves |
|---|---|
| s01 | no invite, tenant free → `no_invite`; no organization, membership or `public.users` row |
| s02 | no invite, tenant held by another organization → `no_invite`; caller not added |
| s03 | invited admin, organization without tenant → invite claimed (active, token cleared, origin `invite`), tenant bound, no organization created |
| s04 | invited admin, tenant held elsewhere → `tenant_in_use`; invite pending, no membership |
| s05 | invited admin, organization holds another tenant → `tenant_mismatch`; nothing written |
| s06 / s07 | invited agent → claimed, tenant never bound or checked |
| s08 | expiry swept: −1 s and exactly `now()` refused, +1 s and NULL accepted; first-time caller gets a `public.users` row |
| s09 | invited email matched trimmed and case-insensitive |
| s10 | invite matched on `auth.users.email` only (NULL auth email; different auth email), never metadata |
| s11 | claimed active members: admin binds; agent does not; tenant held elsewhere → `tenant_in_use`; same tenant (upper case) → success; other tenant → `tenant_mismatch` |
| s12 | a clashing slug causes no error |
| s13 | the BACKLOG-3882 identity checks (3882 c1–c6) against this body |
| s14 (race.sh) | concurrent binds of one tenant: one success, one `tenant_in_use`, no 23505 |
| s15 | caller with a personal organization claims a brokerage invite; personal membership retired |
| s16 | organization full only by the caller's own invite → claim succeeds, seats unchanged |
| s17 | one overload, signature, definer, search_path, ACL, body md5, no organization INSERT, anon cannot execute |
| s18 | claimed admin with no email anywhere and an existing `public.users` row → success (no 23502) |
| s19 | claimed admin suspended / unassigned / NULL status, each also invited to another brokerage → `membership_inactive`; nothing written |
| s20 | another organization holds the tenant in upper case → `tenant_in_use` |
| s21 | active agent of A with an admin invite to B → target A; B invite stays pending |
| r01 | after the rollback: body md5, ACL, fingerprint row back to production's; old behaviour back |

Mutants (`lib/mutants.py`): X1 organization INSERT restored → s01; X2 bind for any role → s06;
X3 no expiry → s08; X4 metadata email → s10; X5 claim before the tenant check → s04;
X6 no unique_violation handler → s14 (race.sh); X7 no inactive check → s19; X7b `<> 'active'` →
s19; X8 case-sensitive held check → s20; X9 unconditional users INSERT → s18; X10 no
personal-organization filter → s15.

## Superseded by this change (marked, not deleted)

`backlog-3096/*` (first-user-wins), `backlog-3882` c8, `backlog-3851` c03 and c18,
`backlog-3843` k24 (organization-creating leg). `backlog-3851/lib/pins-3851.sql` row
`fn auto_provision_it_admin(text,text,text)` stops matching production after the apply (see that
README). `backlog-3364/lib/gate-expected.txt` is a historical read (2026-09-15) and is unchanged.
