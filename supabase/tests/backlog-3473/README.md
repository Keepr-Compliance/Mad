# BACKLOG-3473 harness — transaction checklists cloud schema

Proves the three migrations on a real Postgres + PostgREST stack:

| File | What it does |
|---|---|
| `20260921101756_backlog_3473_feature_reads_honour_min_tier.sql` | The three feature read functions ignore an override that turns ON a feature above the plan's tier; a trigger refuses writing one. |
| `20260921101757_backlog_3473_transaction_checklists.sql` | Seven tables, RLS, grants, the seed catalogue and its copy, the `transaction_checklists` feature row, `submission_attachments.local_attachment_id`. |
| `20260921101758_backlog_3473_retire_unused_org_columns.sql` | Drops three unused `organizations` columns, behind a guard. Never committed on the venue. |

**Status: written, not run.** No control below has run against a database yet. The
results section is filled in when phase (ii) runs on the test venue.

CI runs only the text tripwire, `broker-portal/__tests__/migrations/transaction-checklists-3473.test.ts`
(control C23). Nothing in this directory runs in CI. No file here has a `.test.` or
`.spec.` infix (`scripts/ci/check-test-drift.mjs` would flag it).

## Layout

```
run.sh                  every command; refuses any host that is not loopback or Tailscale
lib/fixtures.sql        helpers + synthetic fixtures, loaded inside each control's transaction
lib/rpc-before.sql      production's three read functions, verbatim (md5 = production's)
lib/catalog-snapshot.sql  C21's S1 / S2
lib/gate-catalog.sql    venue fingerprint; gate-expected.txt is production's output (252 rows)
lib/gate-accepted.txt   accepted venue differences (empty until the first gate run)
lib/teardown.sql        takes migrations 1 and 2 back off the venue, verified by re-hash
controls/*.sql          one control per file, each in its own rolled-back transaction
mutants/generate.mjs    derives every mutant from the shipped migrations
mutants/m*.sql, f*.sql  run by `run.sh mutants` against the controls on their `targets:` line
mutants/a*.sql          whole-file mutants, run by `run.sh apply-prod-mutants`
postgrest/              committed seed, probe (C22 + C1-anon over HTTP), cleanup
```

## Run order (phase ii)

`URL` is the venue's postgres URL, connecting as `postgres`. `T3473_SCOPE` is `all`
unless the founder narrows Ruling 1 (then `narrow`, and the migration's narrowing
line is un-commented and C23's `EXPECTED_SCOPE` flipped).

1. `run.sh "$URL" gate` — stop on any MISMATCH not in `gate-accepted.txt`.
2. `run.sh "$URL" apply-prod` — C21 (K3 order): files 1→2→3, admin toggle, S1, files
   1→2→3 again, S2, S1 = S2 both ways. All in one rolled-back transaction.
3. `run.sh "$URL" apply-prod-mutants` — a01–a05: each must go RED.
4. `run.sh "$URL" controls` — every control GREEN.
5. `run.sh "$URL" mutants` — every mutant reds its targets (m39 and m48 must stay
   GREEN). `MATRIX=1` runs every mutant against every control.
6. `node mutants/generate.mjs --check` first, so no mutant is stale.
7. `run.sh "$URL" apply` — COMMITS files 1 and 2 (never 3) and reloads PostgREST.
8. `run.sh "$URL" probe-seed`, then `run.sh "$URL" probe` (needs `SUPABASE_URL` and
   `SUPABASE_JWT_SECRET` in the environment), then `run.sh "$URL" probe-mutant`.
9. `run.sh "$URL" probe-cleanup`, then `run.sh "$URL" teardown`, then `gate` again —
   it must re-match.

## What the stack must provide

- A `postgres` role with BYPASSRLS (C13 and the owner-side setup depend on it; the gate
  prints it) and DDL rights: `keepr_agent` holds DML on four tables only and cannot run
  these migrations.
- PostgreSQL ≥ 14 (`CREATE OR REPLACE TRIGGER`); production is 17.
- The production schema baseline, including `get_user_org_ids`,
  `update_updated_at_column`, `_ensure_personal_organization_for` (BACKLOG-3364) and
  `desktop_hide_from_export` (BACKLOG-3365). The gate shows what is missing.
- `admin_permissions` holding `plans.manage` (fixtures give a staff user that role).
- For the probe: PostgREST on the same database and its JWT secret.

## Controls

| # | Control | Mutant(s) that must turn it red |
|---|---|---|
| C1 | cross-org read of templates and items | m01, m02 |
| C1-anon | anon: PRIV on 7 tables, the INSERT and 4 functions | m03 |
| C2 | agent cannot write templates or items | m04 |
| C3 | editor role must be on the same org's membership | m05 |
| C4 | broker, admin, it_admin each can write | m06a/b/c |
| C5 | template writes need the entitlement | m07 |
| C6 | templates are never deleted (PRIV) | m08a, m08b |
| C7 | column grants on seed_key, created_by, organization_id | m09a, m09b |
| C8 | copy readers: submitter, broker, admin only | m10a–d |
| C9 | copy insert only by the submitter while uploading | m11, m12, m13a–c |
| C9b | copy header needs the entitlement | m14 |
| C9p | the submitter CAN insert the whole tree (K1) | m15a–d, m51a–d |
| C10 | copy rows never updated or deleted (PRIV) | m17a–d |
| C10b | observed: re-open adds rows (BACKLOG-3497) — not a gate | — |
| C11 | member targets stay in the same submission | m18a, m18b |
| C11c | member messages must be email | m19 |
| C12a | member kind / target CHECK | m20 |
| C12b | member kind = link kind (FK) | m21 |
| C13 | child submission_id = parent's (FK) | m22a–c |
| C14 | submission delete cascades the copy | m23 |
| C15 | tier-guard sweep, 11 cases × 3 functions | m24a–c, m25–m32 |
| C16 | read-function parity before / after | m24a–c, m25, m28, m50a–c |
| C17 | seed idempotency (templates and items) | m33, m34, m35 |
| C18 | seed scope; first sign-in keeps its plan row | m36, m37, m38, m49; m39 stays GREEN |
| C19 | seeding and catalogue not client-reachable | m40, m41 |
| C20 | migration 3's guard | f01 |
| C21 | apply twice is a no-op (`apply-prod`) | a01–a05 |
| C22 | desktop read over PostgREST (`probe`) | `probe-mutant` |
| C23 | text tripwire, in CI | see the test file |
| C24 | catalogue validation | m42, m43 |
| C25a | above-tier override refused at write | m44 |
| C25b | only changed entries validated | m45 |
| C25c | a downgrade is never blocked | m46 |
| C25d | first sign-in unaffected (K4) | m47, m49; m48 stays GREEN |
| C25e | an OFF override is never refused | m31 |

Scope-dependent: m26–m30, m32 and m46 run only under `all` (under `narrow` they are
behaviourally identical to the shipped code while transaction_checklists' min_tier is
team). m31 targets C25e only under `narrow`. C25c is N/A under `narrow` and asserts why.

## Design decisions (written down, not improvised)

- **Prelude order** (Addendum B R1): migration 2 → fixtures → C16's "before" snapshot →
  migration 1 → migration 3 (skipped for a control marked `harness: without-file3`) →
  mutant → control → ROLLBACK. The snapshot is taken for every control; only C16 reads it.
- **C20 runs migration 3 as one unit** through `pg_temp.try_exec`, which EXECUTEs the
  whole file text inside a subtransaction — the same all-or-nothing a migration
  transaction gives. psql's `ON_ERROR_STOP` would otherwise abort at the guard's RAISE.
  This relies on plpgsql `EXECUTE` accepting a multi-statement string with no
  parameters; phase (ii) is the first run that exercises it.
- **`lib/rpc-before.sql` is committed**, not captured at gate time: it is production's
  `pg_get_functiondef` text, byte-for-byte (its md5s equal production's). The gate
  refuses a venue whose three read functions differ from production — never accepted —
  so restoring from the file restores the venue's own bodies, and `teardown.sql`
  re-hashes and raises on any difference.
- **Scope is declared, never detected.** A control that detected the scope from the
  migration would change what it expects when the migration is wrong.

## Results

Not run. Phase (ii) records here, with the SHA: the gate output, `apply-prod`, every
control, every mutant with its `MUTATION APPLIED` line and what went red, the probe,
teardown and the re-gate.
