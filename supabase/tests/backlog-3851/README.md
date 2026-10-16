# BACKLOG-3851 harness

Controls, two-session controls, mutants and rollback checks for:

| File | Change |
|---|---|
| `supabase/migrations/20261015152446_backlog_3851_license_model.sql` (M1) | `license_status` gains `'unassigned'`; `license_assigned_at`; helpers `member_status_holds_seat`, `member_status_is_deactivated`, `member_origin_is_idp`, `member_row_holds_seat`; seat trigger `seat_limit_enforce` → `_enforce_member_seat_limit()`; expiry-aware early counts in `guard_invite_acceptance()` and `admin_invite_user(...)`; `set_member_license(uuid, text)`; `get_org_features` / `check_feature_access` require an access-granting membership. |
| `supabase/migrations/20261016100100_backlog_3851_paygo_revert.sql` (M2) | `_ensure_personal_organization_for` allows a personal organization beside a deactivated brokerage row; `_retire_personal_membership` skips deactivated rows and its trigger also fires on `license_status`; `revert_deactivated_member` trigger attaches the personal organization on deactivation (a failure there never blocks the deactivation). **Applied only after the production broker portal reads two membership rows (PR-2a on `main`).** M2 refuses to run without M1. |

Rollback: `rollback-3851.sql` (one transaction; works after M1 alone or M1 + M2). Order and what it
does NOT undo (personal rows attached by M2; `license_assigned_at` kept) are in its header.

## Venue and pins

Every run is one transaction ending in ROLLBACK (`run.sh`), except `race.sh` (below). Layering:
the BACKLOG-3946 prelude (3917 + 3938 + 3940 layers, then the three 3946 migrations), then

- `lib/prod-bodies-3851.sql` — **venue setup**, not a change under test: production's bodies of
  five functions the earlier layers leave different (`get_org_features`, `claim_pending_invite`,
  `auto_provision_it_admin`, `jit_join_organization`, `auto_provision_google_it_admin`) plus
  `_override_effective`, the `organizations.is_test` column, the two `organization_members` CHECKs
  re-created in the form whose deparse equals production's, and the removal of a venue-only grant.
- `lib/pins-3851.sql` — the venue must equal **production today** (read 2026-10-14 via Supabase
  MCP at ledger head `20261014152904`) for every row of `lib/fingerprint-3851.sql`, else ERROR.
  Unlike the 3917/3946 pins (historical), this is a current read and doubles as the pre-apply gate.
- `lib/harness-3851.sql`, `lib/fixtures-3851.sql` (before the stack, so the migrations meet existing rows).

### Pre-apply gate (run immediately before applying M1 to production)

Run `lib/fingerprint-3851.sql` read-only on production (Supabase MCP `execute_sql`). Every row must
equal `lib/pins-3851.sql` (34 rows; `md5(string_agg(k || '|' || v, E'\n' ORDER BY k))` = `407be106383f6e4fe3308fc26e0b0a82`, re-read 2026-10-14 at ledger `20261014152904`). Any difference: STOP. M1 also checks the four replaced bodies itself
(`md5(prosrc)` precondition) and aborts on drift; M2 does the same for its two.

## Running

```
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh precheck       # venue = production pins
SSH_HOST=... PG_CONTAINER=... bash run.sh controls [fragment]               # c* on M1, m* on M1 + M2
SSH_HOST=... PG_CONTAINER=... bash run.sh twice    [fragment]               # each migration applied twice
SSH_HOST=... PG_CONTAINER=... bash run.sh base     [fragment]               # nothing applied: reds expected
SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]               # lib/mutants.py, single-session
SSH_HOST=... PG_CONTAINER=... bash run.sh race [scenario]                   # two-session controls
SSH_HOST=... PG_CONTAINER=... bash run.sh race-mutants                      # lib/mutants.py, two-session
SSH_HOST=... PG_CONTAINER=... bash run.sh rollback                          # r01, r02, negative
```

`M1_OVERRIDE` / `M2_OVERRIDE` replace a migration file. Recorded runs (unedited): `control-run.txt`,
`twice-run.txt`, `base-run.txt`, `mutant-run.txt`, `race-run.txt`, `race-mutant-run.txt`,
`rollback-run.txt`.

### race.sh

Two sessions must both see committed rows, so `race.sh` clones the venue database into a throwaway
database `race3851` (pg_dump, restored as the container superuser over loopback), commits the
prelude + M1 (or a mutant) there, runs the two sessions, and drops the database on every exit
path. The venue database is never written. `SETUP|lockline|...` reads back the lock clause and
whether the count precedes the lock from the installed function (proof the mutant applied).

## Controls

| Control | Proves |
|---|---|
| c01 | `set_member_license`: 7 callers x 9 targets x 4 actions (252 cells) against an independent spec; anon refused by grant; service_role and unknown ids `not_authorized`; reactivate in a full org returns `seat_limit_reached` (Q3) and leaves the row. |
| c02 | Seat limit for every writer: client invite (guard 42501), service_role (P0001), postgres (no `current_user` exemption), `admin_invite_user`; unassign frees at once, assign takes it; `license_assigned_at` set / cleared / not forgeable; claim (pending→active) neutral in a full org; personal org and `max_seats` 0 / NULL have no limit. |
| c03 | IdP INSERT overflow → `'unassigned'` via `auto_provision_it_admin` (the live /setup join), service_role scim insert, `jit_join_organization`; free seat → `'active'`; manual / NULL-origin INSERT refused. **SUPERSEDED** once 20261016054316 is applied (/setup with no invite returns `no_invite`; /setup with an own invite claims it). Superseded by BACKLOG-3851 PR-2 piece 1 (`supabase/migrations/20261016054316_backlog_3851_setup_completes_invite.sql`, harness `supabase/tests/backlog-3851-setup/`). |
| c05 | `get_org_features` / `check_feature_access`: active answered; suspended, expired, unassigned, other-org → `not_authorized`. |
| c07 | Helper truth tables incl. NULL, unknown values, `directory_sync`, invite expiry on both sides of now(). |
| c08 | Catalogue: new-function grants (no PUBLIC/anon), definer flags, `search_path ''`, volatility; replaced functions keep production ACLs; trigger order and columns; lock clause and its position; CHECK; new column; every untouched fingerprint row = production. |
| c11 | A seat-taking UPDATE is refused, never rewritten (RPC and service_role). |
| c12 | First claimed member of an org with no access-granting claimed member gets a seat (max+1); the next is unassigned; a deactivated claimed member does not count; UPDATE obeys the same max+1. |
| c16 | Resend of an expired invite in a full org refused; live invite Resend neutral; with a free seat the expired invite's Resend takes it. |
| c16b | Q4 on the invite paths: an org full only by an expired invite accepts one portal invite and one staff invite, then refuses. |
| c18 | /setup for a user who also holds their own unclaimed invite (trace, see below). **SUPERSEDED** once 20261016054316 is applied (/setup with no invite returns `no_invite`; /setup with an own invite claims it). Superseded by BACKLOG-3851 PR-2 piece 1 (`supabase/migrations/20261016054316_backlog_3851_setup_completes_invite.sql`, harness `supabase/tests/backlog-3851-setup/`). |
| m06 | (M1 + M2) deactivation attaches a personal org; later status change keeps it; reactivation retires it; unassigned is still in the brokerage; desktop self-heal for a deactivated member; active elsewhere → no personal org; no licence → deactivation still commits. |
| m13 | (M1 + M2) a raising revert never blocks the deactivation. |
| race c04r / c04c | B blocks on the org lock; after A rolls back B succeeds; after A commits B gets `seat_limit_reached`; seats = max. |
| race c15 | An FK child insert referencing the org completes while the seat lock is held (NO KEY UPDATE). |
| race c12b | Two concurrent first-claimed IdP inserts: one active, one unassigned. |
| race c14 | Two admins unassign each other concurrently: exactly one succeeds; the loser gets `not_authorized` (its own row is already unassigned when it reads it under the lock). |
| r01 / r02 | Rollback after M1 + M2 / M1 alone: every pin back to production except the kept column; unassigned → suspended; trigger gone. Negative: r01 without the rollback is red. |

Not covered here: `directory_sync` origin rows (the `provisioned_by` CHECK refuses the value until
BACKLOG-3950); portal jest controls and mutants W5, W9–W12 (PR-2a/2b/2c).

## c18 trace (/setup and the user's own invite)

`auto_provision_it_admin` matches an existing membership by `user_id` only. An unclaimed invite has
`user_id` NULL, so the function inserts a second, `jit` row. With room, both rows hold a seat until
`claim_pending_invite` deletes the invite (`existing_membership_kept`). In a full org whose last seat
is the user's own invite, the `jit` row is written `'unassigned'`; the later claim deletes the invite
and frees a seat, but the user stays `'unassigned'` until an admin assigns it (no auto-assign, Q5).

## After 20261016054316 (BACKLOG-3851 PR-2 piece 1)

Superseded by BACKLOG-3851 PR-2 piece 1 (`supabase/migrations/20261016054316_backlog_3851_setup_completes_invite.sql`, harness `supabase/tests/backlog-3851-setup/`) changes `auto_provision_it_admin`. Once it is applied to production, `lib/pins-3851.sql` row `fn auto_provision_it_admin(text,text,text)` (`11d8619f8dc65e22f53e668e8eade957`) no longer matches production by design, and this harness's prelude must be re-pinned before it is used as a pre-apply gate again. The pin is NOT changed here: every run of the new harness loads this prelude against the pre-apply venue. Controls c03 and c18 encode the pre-apply /setup behaviour. Production after the apply (read 2026-10-16, ledger version 20261016054316): the same fingerprint expression (`md5(pg_get_functiondef(oid) || '|' || coalesce(proacl::text, ''))`) gives `b7be86df338cf4de781cd65b4f53bd02` for `auto_provision_it_admin(text,text,text)`; `md5(prosrc)` is `0ca68b8cee9820322274e1f1a4817b0a`. That value replaces `11d8619f…` only when this prelude is used as a post-apply venue; in place it makes every control of `backlog-3851-setup` stop at `PINS3851 MISMATCH`, because the pin is loaded before the new migration.

## M3 (20261016200000, BACKLOG-3851 PR-2c): SCIM INSERT into a full brokerage is refused

- Stack: c-controls run on M1 + M3, m-controls on M1 + M2 + M3 (`twice` applies each twice).
  M3 replaces the seat-trigger body; its pre-check accepts only the M1 body (md5 36378add…) or
  its own (md5 2080be6b…).
- c19: every SCIM write the edge function makes (insert, invite claim live/expired, reactivate,
  suspend, the brand-new-email shape whose membership the auth.users key refuses), plus the
  helper's corpus, grants and the trigger's md5. c03's scim leg now expects the refusal.
- r05 (in `rollback`): M1 + M3 + `rollback-3851-m3.sql` restores the M1 body and drops the
  helper; a negative run without the rollback must go red, and M3 applied over a drifted body
  (`lib/drift-seat-trigger-3851.sql`) must stop at its pre-check.
- Unwinding further: run `rollback-3851-m3.sql` before `rollback-3851-m2.sql` / `rollback-3851.sql`
  (r01–r04 are measured without M3).
- Mutants: an M1 seat-trigger mutant is carried into M3 (`mutants.py carry`: M3 without its
  pre-check, with each of the mutant's edits that occurs in M3), so the pre-check cannot "kill"
  it. `IDP_origin_any` is now seen by c07 (the trigger no longer reads `member_origin_is_idp`);
  `M3_helper_any` is its trigger-level twin. Measured 2026-10-16: killed=44 survived=0 invalid=0.
