# BACKLOG-3845 harness

Controls and mutants for `supabase/migrations/20261011100000_backlog_3845_billing_foundation.sql`
and `rollback-3845.sql`.

Every run is one transaction ending in ROLLBACK; nothing is committed. Order: PG 16+ check,
helpers (`lib/harness.sql`), the paid_through corpus and the migration's object list as settings,
fixtures (`lib/fixtures.sql`, personal orgs made by `_ensure_personal_organization_for`), an optional
`pre-apply` hook, fingerprint `pre`, the migration (or a mutant; nothing for `baseline`),
`lib/post-apply.sql` (flags the is_test fixtures), optional second apply / rollback, the control.

```
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh baseline [fragment]   # pre-3845 code: report only
SSH_HOST=<alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
```

`mutants` runs every control on the unmutated files first, then each mutant in `lib/mutants.py`
(each edit must match its exact count, else `apply` raises and the mutant is INVALID). Exit 0 only
when every mutant is KILLED.

| Control | What it proves |
|---|---|
| k01 | `{"enabled":true}` and `paid_through: null` stay enabled in all three resolvers |
| k02 | past `paid_through` → plan answer in all three; future → override |
| k03 | every corpus entry (`corpus/paid_through.json`, shared with `tests/offline-pass/paidThroughParity-3845.test.ts`) in all three resolvers and `_override_effective`; no exception |
| k04 | boundary: `paid_through = now()` expired, `now() + 1 s` effective |
| k05 | Team plan's plan-sourced Unlimited is never date-cut (no / expired / malformed override) |
| k06 | `submission_checklists_insert` (RLS) with a malformed override → 42501, not 22007/22008; valid override → allowed |
| k07 | grant RPC: value shape, refusals (NULL paid_through, mode/is_test, no personal org, invalid mode, suspended licence, support override) |
| k08 | revoke RPC removes only a `source:"stripe"` override; mode refusals |
| k09 | stripe_mode trigger on all four tables; NULL is_test refused; row org beats personal org |
| k10 | RC7 catalog, from the migration's own object list: EXECUTE / table grants / RLS / policies / defaults |
| k11 | client select sees only the live `stripe_customers` row (desktop `maybeSingle()` reader) |
| k12 | `billing_outbox_claim`: mode, due, leased, limit, dedupe |
| k13 | one open subscription per user per mode; clients read own rows, write nothing |
| k14 | existing rows read `live`; old-code inserts (no stripe_mode) still succeed |
| k15 | apply twice: no change |
| k16 | rollback restores the pre-3845 fingerprint (production resolver md5s) |
| k17 / k18 | rollback refuses while a paid_through override or a test-mode row exists |
| k19 | a drifted resolver body stops the migration before anything is replaced |

Venue: NAS `keepr-test`, PostgreSQL 17.6, ledger head 20261004232511 (behind production by
3843/3856/3857/3862/3882 and the 3858 data step). None of those touch the objects this migration
changes: the three resolver md5s, `stripe_customers` / `payment_intents` constraints and policies,
and `has_internal_role` were compared with production on 2026-10-11 and match. The venue has no
`plans` rows and no `unlimited_transactions` definition; the fixtures add them.
