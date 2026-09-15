# BACKLOG-3364 harness — personal organizations, migration 1

Executes `supabase/migrations/20260915160637_backlog_3364_personal_organizations.sql`
on a real Postgres + PostgREST + storage stack, as the role production applies
migrations with, and records what every control and every mutant did.

**It has been run.** 2026-09-15, on the NAS Supabase test stack
(`scripts/supabase-nas-stack.sh`), baseline `baseline-2026-09-05.sql`
(md5 `05e9e4b4d8707300829b3e851838c127`) plus the migrations that stack already held.
Every result below was measured, none predicted.

It is not in CI: CI has no database. The text-level tripwire that does run in CI is
`broker-portal/__tests__/migrations/personal-organizations-3364.test.ts`.

---

## What migration 1 does (summary)

1. `organizations.personal_owner_user_id` (nullable, no default) + partial unique index.
2. `public._ensure_personal_organization_for(uuid)` (internal) and
   `public.ensure_personal_organization()` (signed-in users, acts on `auth.uid()`).
3. A guard: only those functions may set or change `personal_owner_user_id`.
4. A trigger on `organization_members`: a new non-personal membership removes the
   user's personal membership (the personal organization and its plan row stay).
5. The `transaction_submissions` INSERT policy and the `submission-attachments`
   upload policy additionally require a non-personal organization.

No trigger on `auth.users`. `handle_new_user`, `create_active_individual_license` and
`admin_assign_org_plan` are untouched. One transaction; re-running changes nothing.

---

## Running it

```bash
URL='postgresql://postgres:<password>@<tailnet address>:54322/postgres'   # the stack's postgres role
H=supabase/tests/backlog-3364/run.sh

$H "$URL" gate          # venue gate (below). Stop on any MISMATCH.
$H "$URL" seed          # production's submission-attachments bucket + 4 storage policies
$H "$URL" txn           # one-transaction control      } on a venue WITHOUT migration 1
$H "$URL" txn-mutant    # its mutant (commits partially) }
$H "$URL" teardown      # takes the txn-mutant's partial state back off
$H "$URL" apply         # migration 1 + its history row
$H "$URL" twice         # apply-twice control and its mutant
$H "$URL" controls      # 14 controls, each in its own rolled-back transaction
$H "$URL" mutants       # 19 SQL mutants x 14 controls, plus the backfill mutant

# PostgREST response fixtures (pre = before apply, post = after):
psql "$URL" -f supabase/tests/backlog-3364/postgrest/seed.sql
SUPABASE_URL=http://<tailnet address>:54321 SUPABASE_JWT_SECRET=<the stack's JWT secret> \
  node supabase/tests/backlog-3364/postgrest/probe.mjs pre|post
psql "$URL" -f supabase/tests/backlog-3364/postgrest/cleanup.sql
```

`run.sh` and `probe.mjs` refuse any host that is not loopback or a Tailscale address.
`supabase migration up` refuses this repo's migration directory (BACKLOG-3126), hence psql.

After editing the migration or the backfill: `node supabase/tests/backlog-3364/mutants/generate.mjs`,
then re-run `controls` and `mutants` before recording anything.

---

## Venue gate — 2026-09-15

**Step 0 (SR addendum f213b82c), as `postgres` on the stack:**

| Check | Stack | Production (read-only) |
|---|---|---|
| connected role / `rolsuper` | `postgres` / false | `postgres` / false |
| server | 17.6 | 17.6 |
| supautils loaded | yes (`session_preload_libraries = supautils`) | yes (same) |
| `supautils.policy_grants` lists `storage.objects` for `postgres` | yes; value identical to production's | yes |
| `storage.objects` owner / `postgres` a member of it | `supabase_storage_admin` / no | same |
| RLS on `storage.objects` | on | on |
| `authenticated` holds INSERT on `storage.objects` | yes | yes |

**→ Path A (full fidelity):** seed the storage pre-state as `postgres`, apply migration 1
whole as `postgres`. No `supabase_admin`, no ssh, no stack configuration change.

**Catalog fingerprint** (`lib/gate-catalog.sql`; production's output in `lib/gate-expected.txt`):
86 rows — function bodies and ACLs, columns, policies, triggers, constraints, table ACLs,
RLS flags, supautils settings, bucket.

| Run | matched | accepted | mismatched |
|---|---|---|---|
| before seed | 79 | — | 7 (bucket and storage policies absent, + the 4 below) |
| after seed, before apply | 82 | 4 | 0 |
| after apply | 80 | 6 | 0 |

The 4 accepted differences (`lib/gate-accepted.txt`): `jit_join_organization` ACL
(production is narrower; not used by migration 1); storage table ACL grant-option flag on
the storage admin's own entry; the stack has no `on_auth_user_created` trigger on
`auth.users` (its baseline covers `public` only; not re-created because the BACKLOG-3096
controls on this stack seed `public.users` themselves). After apply, the 2 replaced
policies carry their new text (the other 2 accepted rows). Nothing else in the
fingerprint moved.

Constraint and policy text is normalised before hashing (casts to text/varchar,
parentheses and whitespace stripped): a dump-and-restore re-renders the same CHECK or
policy expression differently. This makes the fingerprint blind to a change that only
moves parentheses; the behaviour controls below are what cover the two policies.

**PostgREST (gate step 4), real `@supabase/supabase-js` 2.110.2, before apply:**
A (select names the column) 400 `42703`; B (`organizations(*)`) 200; C (`.order` on the
column) 400 `42703`; D (`.is` on the column) 400 `42703`; E (`.order("created_at")`) 200.
Same as production. Error object:
`{"code":"42703","details":null,"hint":null,"message":"column organizations_1.personal_owner_user_id does not exist"}`,
no throw.

---

## Transaction controls

| Control | Result |
|---|---|
| `txn`: copy with a failing last statement (`mutants/t1-…`) | exit 3 at `division by zero` on the last line, fingerprint (13 rows) unchanged → **GREEN**. Every statement before it ran as `postgres` without a permission error, including both policy replacements. |
| `txn-mutant`: same copy with `BEGIN`/`COMMIT` removed (`mutants/t1m-…`) | MUTATION APPLIED (2 transaction lines removed); exit 3, fingerprint **changed** → the control's condition goes red. `teardown` then restored the fingerprint exactly (diff empty). |
| `twice`: apply again | exit 0, fingerprint unchanged → **GREEN** |
| `twice` mutant: `ADD COLUMN` without `IF NOT EXISTS` (`mutants/t2m-…`) | MUTATION APPLIED; exit 3 (`column … already exists`), fingerprint unchanged (the failure rolled back everything) |

## Controls — all 14 GREEN

Each runs inside `BEGIN … ROLLBACK` after `lib/fixtures.sql`. RLS cases run as role
`authenticated` with `request.jwt.claim.sub`. A control that asserts nothing is refused.

| Control | Proves | Assertions |
|---|---|---|
| `s-a` | ensure ×2 → 1 org, 1 plan row (default individual plan), 1 membership agent/active; max_seats 1, JIT off, legacy plan `trial`; no license → nothing; NULL → nothing | 24 |
| `s-b` | active **and** suspended brokerage member → nothing | 6 |
| `s-c` | unexpired invite, and NULL-expiry invite in other case with a trailing space → nothing; expired invite → created | 7 |
| `s-d` | brokerage membership INSERT, and invite claimed by UPDATE via the real `claim_pending_invite()` as the user → personal membership removed, org and plan kept; unclaimed invite row removes nothing; a second brokerage leaves the first | 14 |
| `s-e` | leave the brokerage → ensure re-attaches the same org and plan row | 7 |
| `s-f` | submission INSERT: personal agent into own personal org denied by RLS; brokerage agent into brokerage allowed | 5 |
| `s-g` | upload INSERT on `storage.objects`: personal prefix denied by RLS; brokerage prefix allowed | 6 |
| `s-h` | personal agent: organization UPDATE 0 rows, member INSERT denied, plan row UPDATE 0 rows | 6 |
| `s-i` | internal function not executable by anon / authenticated / PUBLIC (catalog **and** a call as the user); wrapper executable by authenticated only | 8 |
| `s-j` | wrapper has no arguments; as a user creates that user's org; with no claim writes nothing | 8 |
| `s-k1` | column guard: brokerage admin setting the column (self / other user) refused while the same admin can update another column; service_role UPDATE and INSERT refused; owner role allowed | 8 |
| `s-k2` | ensure does not attach to an organization holding another membership row | 4 |
| `c9` | no trigger on `auth.users` besides production's own; `handle_new_user`, `create_active_individual_license`, `admin_assign_org_plan` md5 = production; 3364 trigger functions attached only where intended | 7 |
| `b-backfill` | parked backfill: plain user → org; expired and unexpired unclaimed invite → skipped; brokerage member untouched; second run changes nothing | 8 |

## Mutants — every one reds at least one control

Generated from the shipped files by `mutants/generate.mjs` (exact replacements that throw
when unmatched). Each prints `MUTATION APPLIED: <catalog evidence>` inside the transaction
before any control runs; `run.sh` refuses a result without it. Every mutant was run against
**all 14** controls; reds are listed with the failing assertion.

| Mutant | RED | Failing assertion |
|---|---|---|
| m01 submission policy without the personal clause | s-f | personal agent submission … denied, got allowed |
| m02 upload policy without the personal clause | s-g | upload under the personal prefix … denied, got allowed |
| m03 column guard removed | s-k1, c9 | admin setting the column to self refused, got `updated:1`; guard trigger present |
| m04 retirement trigger removed | s-d, s-e, c9 | personal membership removed on insert; precondition in s-e; trigger present |
| m05 retirement on INSERT only | s-d | personal membership removed when the invite is claimed by UPDATE |
| m06 retirement deletes the personal org | s-d, s-e | personal organization kept; re-attach returned `created` |
| m07 retirement deletes every other membership | s-d | first brokerage membership kept |
| m08 sign-up trigger on `auth.users` calling ensure | c9 | found `t3364_mutant_signup_ensure` |
| m09 ensure short-circuits on active rows only | s-b | suspended member returned `created` |
| m10 expired invite blocks | s-c | expired invite returned `pending_invite` |
| m11 exact email match | s-c | NULL-expiry invite returned `created` |
| m12 membership INSERT without ON CONFLICT | s-a | duplicate key on the second call |
| m13 JIT left at its default | s-a | jit_provisioning_enabled false, got t |
| m14 membership role admin | s-a, s-e, s-h | role agent, got admin; personal agent updates 0 org rows, got 1 |
| m15 no license check | s-a | no license returned `created` |
| m16 ensure recreates a member-less org | s-e | re-attach returned `created` |
| m17 attaches to an occupied org | s-k2 | returned `attached` |
| m18 internal function granted to authenticated | s-i | authenticated has no EXECUTE |
| m19 wrapper takes a user id | s-j, s-i, c9 | wrapper takes no arguments (s-i, c9 red on the missing zero-argument signature) |
| b01 backfill without the invite skip | b-backfill | user with an EXPIRED unclaimed invite was skipped |

## Text test (CI) — made to fail before being trusted

`npx jest --config broker-portal/jest.config.js broker-portal/__tests__/migrations/personal-organizations-3364.test.ts --bail=0`:
13 passed. Each mutation below was applied to the committed file (numstat recorded on BACKLOG-3364),
run, then restored with `git checkout --`; the restored run is 13/13.

| Mutation | Red |
|---|---|
| trigger on `auth.users` added | 1/13 — creates no trigger on auth.users |
| `SET LOCAL lock_timeout` removed | 1/13 — one transaction with a lock timeout |
| internal function granted to authenticated | 1/13 — internal function away from anon/authenticated/PUBLIC |
| backfill copied into `migrations/` | 2/13 — only 3364 migration; no migration loops calling ensure |
| membership role admin | 1/13 — one-seat, JIT-off org … membership agent |
| upload policy personal clause removed | 1/13 — non-personal condition on both policies |

## PostgREST fixtures (for PR 2 / PR 3)

`fixtures/postgrest-pre-migration.json` and `fixtures/postgrest-post-migration.json`,
captured with the real client against this stack. UUIDs are replaced by labels; everything
else is verbatim.

- **Before migration 1:** A/C/D → 400 `42703`, no throw; B/E and the ruling-7 membership
  query → 200, embedded `organizations` object with 24 keys and **no**
  `personal_owner_user_id` key; `rpc("ensure_personal_organization")` → 404 `PGRST202`.
- **After migration 1:** every variant 200; embedded object with 25 keys,
  `personal_owner_user_id: null` for a brokerage; the RPC → 200 `{"status":"created",…}`
  then `{"status":"exists",…}`; the solo user's ruling-7 query then returns the personal
  row with the key set. PostgREST reloaded its schema cache on its own after the apply.

The RPC call went through PostgREST's own connection and role switch, so it also shows
the guard admits the functions' writes in the real request shape.

---

## What the stack now holds (it is shared and persistent)

1. **Storage seed** (`lib/seed-storage.sql`): bucket `submission-attachments` and production's
   four `submission-attachments` policies on `storage.objects`.
2. **Migration 1** applied as `postgres`, plus history row `20260915160637`.
3. Nothing else: every control, mutant and probe row was rolled back or deleted
   (0 fixture users, organizations, memberships, plans, licenses or objects remain).

If migration 1 changes or BACKLOG-3364 is abandoned: `run.sh "$URL" teardown`
(restores the two policies to production's text, drops everything migration 1 adds, deletes
the history row; refuses if a personal organization exists).

## What this does NOT prove

1. **Production data** — fixtures only. The backfill's cohort query must be run read-only on
   production before any production run (see `supabase/parked/backlog-3364/README.md`).
2. **Locks under production traffic.** The policy replacements take exclusive locks on
   `transaction_submissions` and `storage.objects`; `SET LOCAL lock_timeout = '5s'` makes a
   blocked apply fail instead of queueing.
3. **Hosted-only configuration** beyond the gate. The stack's storage schema is an older
   storage version than production's (it still has prefix triggers on `storage.objects`);
   the INSERT policy is evaluated the same way, but the storage API itself was not exercised.
4. **Concurrency.** The advisory lock shared by ensure and the retirement trigger is not
   exercised by a two-session control.
5. **Old desktop builds** meeting a personal organization, and anything outside the database.

## Fixture identifiers are invented

UUIDs sit in the `00000000-0000-4000-8000-00003364xxxx` block with `pii-allow-uuid` waivers;
emails use `.example.test`; slugs and keys carry a `fixture-3364` prefix. Plans are
transcribed from production's three `plans` rows with invented ids. The probe mints
short-lived tokens locally from the stack's JWT secret, which is passed in the environment
and never written.
