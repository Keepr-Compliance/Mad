# BACKLOG-3684 harness — an invitation is accepted through its invitation link

Controls, mutants, drift, rollback for:

| File | Role |
|---|---|
| `20261016140000_backlog_3684_accept_invitation.sql` (A) | additive: `accept_invitation(text, text)`, `_invite_bind_tenant(uuid, text)`, `caller_has_pending_invite()` |
| `20261016140100_backlog_3684_email_claims_off.sql` (B) | subtractive: `auto_provision_it_admin` accepts no invitation; `claim_pending_invite()` EXECUTE withdrawn from `authenticated`; policies `users_can_accept_invite` and `users_can_view_own_invite` set to `false` |

Apply order: A, then the portal that calls it, then B. B's pre-check aborts without A.

## Venue

Every run is ONE transaction ending in ROLLBACK through `../backlog-3851/run.sh one`
(the 3851 prelude). Stack: M1, `../backlog-3851-setup/lib/pin-setup.sql`, M2,
`../backlog-3851-setup/lib/helpers-setup.sql`, `20261016054316` (production today), A, B,
`lib/helpers-3684.sql` (`pg_temp.acc(user, token[, tenant])`, `pg_temp.det(user)`).

```
SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh controls [fragment]
... run.sh twice      # A twice, B twice
... run.sh a-only     # the 3851-setup controls with A appended: all green (A changes no behaviour)
... run.sh after-b    # the 3851-setup controls with A + B: lists the reds (superseded, below)
... run.sh mutants    # lib/mutants.py: each must turn its named control red
... run.sh drift      # A / B abort on unexpected objects; B aborts without A
... run.sh rollback   # rollback-3684-b, rollback-3684-a, re-apply; negatives
```

## Controls

| Control | Proves |
|---|---|
| s01 | holder of the invited email, no token: detector true; cannot read the row or its token; accept with what they can read → `invalid_invite`; row pending |
| t01 | right token + matching auth email → claimed (user, active, token cleared, joined_at); first-time caller gets a `public.users` row with its provider (`google` kept, unknown → `unknown`); detector false after; replayed token → `invalid_invite` |
| t02 | forwarded token, other email → `email_mismatch`, row unchanged; detector false |
| t03 | wrong / empty / NULL token, matching email → `invalid_invite` |
| t04 | agent of the org reads a colleague's admin-invite token and presents it → `already_placed`; internal-role user with no brokerage → `email_mismatch` |
| t06 | expiry swept −1 s / now() / +1 s / NULL for accept (`expired`) and the detector (control 12) |
| t07 | matching on `auth.users.email` only (NULL auth email; different auth email; metadata never), trimmed and case-insensitive |
| t08 | `/setup?token=` path: `tenant_in_use` (also upper case) and `tenant_mismatch` leave the invite pending and bind nothing; 3882 identity checks raise 42501; padded upper-case tenant → claimed and bound lower case; agent never binds |
| t09 | catalog: one overload each, definer, `search_path`, return types, ACLs, anon 42501; `_invite_bind_tenant` no client role; `claim_pending_invite` withdrawn from `authenticated`, body unchanged; both policies `false` |
| t10 | active or suspended member of a brokerage → `already_placed`; other invite pending |
| t11 | an invite row in a personal organization is never accepted nor detected |
| t12 | `auto_provision_it_admin`: unplaced caller with a matching invite → `no_invite` (S3 inverted); placed admin bind, `tenant_in_use`, `tenant_mismatch`, `membership_inactive` unchanged; no organization created |
| t13 | email-only client paths closed: direct update (filtered and unfiltered) touches 0 rows; `claim_pending_invite` → 42501 (auth email and metadata) |
| t14 | personal-org owner with a pending invite: detector true; without the token nothing is accepted; with it, accepted and the personal membership retired |
| r01–r03 (`lib/`) | rollback-b restores production's body md5, ACLs and the exact `pg_policies` text; rollback-a then removes the three functions; A + B re-apply after rollback-b; rollback-a refuses while B is in force |

## Superseded by B (marked, not deleted)

With B applied, these `../backlog-3851-setup` controls go red by design, because
`auto_provision_it_admin` no longer accepts an invitation by email: s03, s04, s05, s06,
s07, s08, s09, s13 (c4 leg), s15, s16, s17 (body md5), s20. Their invitation-path
behaviour is covered here against `accept_invitation` (t01, t06, t07, t08, t12, t14).
`run.sh a-only` keeps every one of them green with A alone. Other pins of the two policies
or `claim_pending_invite` (`backlog-3538` k12/k15/k16, `backlog-3679` k07/k08,
`backlog-3851` c18, `backlog-3364/lib/gate-expected.txt`) describe production before B.
