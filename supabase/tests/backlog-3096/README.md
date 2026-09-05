# BACKLOG-3096 controls — `/setup` must not hand admin to every employee

These files execute the fix in
`supabase/migrations/20260905_backlog_3096_setup_first_user_wins.sql`.

**They have not been run yet.** See *Why nothing here has run* below.

---

## What is being proved

`public.auto_provision_it_admin` inserted every caller with a hard-coded
`'admin'`, guarded only by "this user is not already a member". The rule that
replaces it:

> A caller becomes `admin` **if and only if** the organization has **zero
> claimed members** — `organization_members` rows with `user_id IS NOT NULL`.
> Otherwise they join with `COALESCE(organizations.default_member_role,
> 'agent')`.

Plus a row lock (`SELECT … FROM organizations WHERE id = … FOR UPDATE`) taken
before the count, so two employees opening `/setup` in the same second cannot
both observe "zero claimed members".

And a third change, which is why this is not a migration-only PR: the RPC now
**returns** the role it wrote, and `broker-portal/app/auth/setup/callback/route.ts`
branches on it. Control 7 owns the returned `role` key on its own, rather than
that assertion being bolted onto every control: mutant 01 has no `role` key at
all, so a returned-role check inside controls 1–6 would red every one of them
for a reason unrelated to the role logic — including 1 and 3, which are meant to
stay green under it. One finding, one red. Before first-user-wins every caller was an admin, so sending
every fresh provision to `/setup/consent` was always right. It is not any more —
a plain agent cannot complete a tenant-wide Microsoft admin-consent grant, so
that page is a dead end for them. Every non-admin now goes to `/dashboard` —
one destination, not a role → destination table. `middleware.ts` already owns
that decision for every protected request (it admits `broker` and `it_admin`,
and bounces `agent` to `/download`), and two places deciding would drift the
moment either changed. They already would have: an earlier version of this
branch sent every non-admin to `/download`, correct for an agent and wrong for a
broker. When BACKLOG-3080 changes where agents land it changes middleware, and
this callback needs no edit.

The route reads the returned value rather than re-querying, so the callback and
the database cannot disagree about which branch was taken.

---

## The seven controls

| # | File | Fixture | Expected |
|---|------|---------|----------|
| 1 | `control-1-empty-org-first-caller-is-admin.sql` | no org for this tenant | caller → `admin` |
| 2 | `control-2-second-caller-same-org-is-not-admin.sql` | A provisions, then B arrives | A → `admin`, **B → `agent`** |
| 3 | `control-3-precreated-org-unclaimed-invites-first-caller-is-admin.sql` | org pre-created, two **unclaimed** invite rows (`user_id IS NULL`), one of them `role='admin'` | caller → `admin` |
| 4 | `control-4-existing-admin-new-caller-gets-default-role.sql` | org with a claimed admin, `default_member_role='broker'` | newcomer → `broker`; admin's row byte-identical |
| 5 | `control-5-*.sql` + `control-5-run.sh` | pre-created empty org, **two concurrent sessions** | A → `admin`, B → `agent`, and B waits ~5s |
| 6 | `control-6-claimed-agent-no-admin-new-caller-is-agent.sql` | one claimed `agent`, **no admin**, `default_member_role` NULL | newcomer → `agent`, not `admin` |
| 7 | `control-7-rpc-returns-the-role-it-wrote.sql` | insert path, **repeat call**, and second caller | returned `role` == stored role, every time |

Every assertion is on the **exact role of a named user id**. None is on a count
of admins — "one admin" is also satisfied by a run in which the wrong person got
it.

Controls 1–4 and 6 are each a single `DO` block: one statement, one
transaction, so a failing `ASSERT` rolls its own fixtures back. Each begins by
deleting its fixture ids, so it is re-runnable across mutant runs.

---

## The mutation matrix — "revert and watch it go red" is not one revert

**Reverting to the old body does not red all six, and claiming it does would be
false.** Controls 1 and 3 are green under the old body *by design*:
first-user-wins agrees with a hard-coded `'admin'` whenever the caller really is
the first claimed member. Each control therefore needs its own failing input.

| Mutant | Change | Reds | Stays green |
|---|---|---|---|
| `mutants/01-old-live-body.sql` | the production definition, verbatim (hard-coded `'admin'`, no lock, no `role` key) | **2, 4, 5, 6, 7** | 1, 3 |
| `mutants/02-no-claimed-rows-filter.sql` | shipped body minus `AND user_id IS NOT NULL` | **3** | 1, 2, 4, 5, 6, 7 |
| `mutants/03-no-row-lock.sql` | shipped body minus `FOR UPDATE` | **5** — and only two-session | 1, 2, 3, 4, 6, 7 |
| `mutants/04-never-admin.sql` | shipped body with `v_role := v_default_role` unconditionally | **1, 3, 5** | 2, 4, 6, 7 |

Every control has at least one mutant that reds it, and every mutant reds at
least one control.

**Drift:** nothing in git history ever defined `auto_provision_it_admin`.
`git log --all -S 'auto_provision_it_admin'` returns 11 commits, every one a
call site, a comment, guide copy or a planning doc;
`git log --all -S 'FUNCTION auto_provision_it_admin'` returns only the commit
that adds the migration. Production was the sole source of truth.

**Provenance of mutant 01:** it is not hand-written. It is
`pg_get_functiondef('public.auto_provision_it_admin'::regproc)` captured on
2026-09-04, and it is byte-identical to what production was running —
`md5` of the captured definition and of the file's body both come to
`0f8c87bb35f8aa31b3b245907666e892`.

Mutants 02–04 were **derived from the shipped migration by script**, each with a
single targeted edit, so they cannot differ from it in any other way. Their
diffs against the shipped body are one deleted line, one deleted line, and one
replaced `CASE` expression respectively.

---

## The one control that HAS been run

`broker-portal/__tests__/migrations/setup-first-user-wins.test.ts` parses this
migration's text. It cannot prove behaviour — it can only prove what the file
says — but it runs in CI today, and it is the tripwire on the two lines a future
edit is most likely to remove quietly.

It was made to fail on purpose before being trusted. Each mutant was written
over the migration, `npx jest --config broker-portal/jest.config.js --bail=0`
was run, and the file restored:

| Applied over the migration | Reds | Which assertion |
|---|---|---|
| `mutants/01-old-live-body.sql` | 4 of 8 | claimed-members count · hard-coded `'admin'` · row lock · returns-the-role-it-wrote |
| `mutants/02-no-claimed-rows-filter.sql` | 1 of 8 | claimed-members count |
| `mutants/03-no-row-lock.sql` | 1 of 8 | row lock |
| `mutants/04-never-admin.sql` | 2 of 8 | claimed-members count · the "`'admin'` appears exactly once" assertion, which sees zero |
| ad-hoc: `'admin'` put back into the membership `VALUES` | 1 of 8 | hard-coded `'admin'` |
| ad-hoc: `'role'` dropped from the return | 1 of 8 | returns-the-role-it-wrote |
| shipped migration restored | **0** — 8 passed | — |

Re-measured after the return shape changed; mutants 02–04 were re-derived from
the updated body first, so no count here is taken against a stale fixture.

The route's own branch is covered by
`broker-portal/__tests__/app/auth/setup/callback/route.test.ts` (11 assertions),
made to fail the same way. It asserts **both hops** — the callback's redirect,
and then what the REAL `middleware.ts` does with it, imported and invoked with a
`NextRequest` rather than restated:

| Mutation | Reds | Which assertion |
|---|---|---|
| callback hardcodes `/download` — the literal reading this ruling replaced | 5 of 11 | agent → `/dashboard` · **broker → `/dashboard`** · missing role fails closed · both hop-2 tests |
| delete the non-admin branch — i.e. the pre-fix route | 6 of 11 | the four hop-1 non-admin assertions, plus both hop-2 tests |
| invert the branch (admin → `/dashboard`) | 7 of 11 | the six above, plus admin → consent |
| narrow `canGrantAdminConsent` to drop `it_admin` | 2 of 11 | existing `it_admin` reaches consent · the enumerated consent sweep |
| **`middleware.ts` stops admitting `broker`** | 1 of 11 | "admits a provisioned broker" |
| restored | **0** — 11 passed | — |

The last row is not a defect anyone would ship — it is the control on the
control. `admits a broker` asserts a **null** location, and a middleware that
threw and fell into its catch would return exactly that. Breaking middleware's
admit list on purpose and watching that one test go red is what shows hop 2 is
executing the real routing decision rather than passing on an exception.

Counts were measured with `--bail=0`, so they are exact rather than truncated.
The 04 red on the `'admin'` assertion fires on the count-is-zero branch, not on
a literal in `VALUES`; recorded as measured rather than as the test name reads.

---

## Running them

Against a **disposable** database — a Supabase branch, or any throwaway
Postgres with this schema. **Never against production**: this is the auth path.

```bash
export DATABASE_URL='postgresql://…'   # direct connection, not the pooler

# apply the fix
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260905_backlog_3096_setup_first_user_wins.sql

# controls 1-4, 6 and 7
for f in supabase/tests/backlog-3096/control-[123467]-*.sql; do
  echo "== $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

# control 5 needs two sessions
./supabase/tests/backlog-3096/control-5-run.sh
```

Then, for each mutant:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backlog-3096/mutants/01-old-live-body.sql
#   … re-run the controls, record which failed …
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backlog-3096/mutants/restore-shipped.sql
```

### Run them as the database owner, not as `authenticated`

Do **not** `SET ROLE authenticated`. The function is `SECURITY DEFINER`, so it
runs as its owner either way; switching role only RLS-filters the asserting
`SELECT`s and fails the controls for the wrong reason. RLS is enabled but not
`FORCE`d on `organizations`, `organization_members` and `users`, so an owner
session reads the fixture rows unfiltered. The grant that actually matters is
asserted directly in control 1:

```sql
has_function_privilege('authenticated',
  'public.auto_provision_it_admin(text,text,text)', 'EXECUTE')
```

### How the caller is impersonated

`auth.uid()` reads `request.jwt.claim.sub`, so each control does
`PERFORM set_config('request.jwt.claim.sub', '<uuid>', true)` before calling the
RPC. `is_local = true` scopes it to the surrounding transaction.

Inserting into `auth.users` fires `on_auth_user_created` →
`handle_new_user()`, which creates the matching `public.users` row. It creates
no organization and no membership, so the fixtures stay exactly as written.

---

## Why nothing here has run

There is no way to execute plpgsql on the development machine, and this was
checked rather than assumed:

- no `docker`, no `psql` on PATH;
- no `supabase/config.toml`, so `supabase start` has nothing to start (and it
  needs Docker regardless);
- no pgTAP and no prior SQL test directory anywhere in the repo;
- **no Postgres driver or embedded Postgres in `node_modules`** — checked `pg`,
  `postgres`, `slonik`, `knex`, `drizzle-orm`, `prisma`, `typeorm`,
  `@electric-sql/*` (PGlite), `@neondatabase/*`, `pg-mem`, `pg-promise`. All
  absent, and adding a dependency to run a test was out of scope.

The existing `broker-portal/__tests__/migrations/*.test.ts` **parse SQL text**;
they never execute it. So does the companion test for this change.

Nothing was run against production, not even inside a transaction intended for
rollback. Everything read from production was schema metadata and
column-presence aggregates — no row values.

## Fixture identifiers are invented

No real organization name, email domain, Microsoft tenant GUID or organization
UUID appears in any file here. Tenants are the literal strings
`fixture-tenant-3096-*`; emails are under the reserved `.example.test` domain;
UUIDs occupy the `00000000-0000-4000-8000-0000003096xx` block, which no real row
uses. The unclaimed-invite row *shape* is transcribed from its real producer
(the org invite path in
`supabase/migrations/20260412_fix_cross_table_duplicate_invite_check.sql`) — the
column set and the `pending`/`invite`/NULL-`joined_at` values, not any data.

**Checked, not assumed.** Every fixture key was queried against production on
2026-09-04 and none exists there: 0 collisions on all 11 `auth.users` ids, all
11 `public.users` ids, all 4 organization ids, any org with
`microsoft_tenant_id LIKE 'fixture-tenant-3096-%'` or
`slug LIKE 'fixture-org-3096-%'`, and any membership with
`invitation_token LIKE 'fixture-token-3096-%'`. The controls open with `DELETE`
statements on those keys, so this matters: even run against the wrong database
they cannot remove a real row. That is a backstop, not a licence — run them on a
disposable database only.

Every fixture UUID carries an inline `pii-allow-uuid:` waiver with a reason.
That marker is not decoration — the repo's PII gate refuses bare UUIDs outright
and will not let one through on a baseline, because a UUID has no shape that
separates an invented id from a live customer's (BACKLOG-2871). The waiver is
the reviewer-visible claim that these are invented, and the paragraph above is
the evidence for it.
