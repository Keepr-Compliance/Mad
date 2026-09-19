# BACKLOG-3096 controls — `/setup` must not hand admin to every employee

These files execute the fix in
`supabase/migrations/20260905120000_backlog_3096_setup_first_user_wins.sql`.

**They have been run.** Against a disposable Postgres replica on 2026-09-05:
first against production's unfixed body, then against the fix, then against two
mutants. Results below — every one measured, none inferred.

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

## Results — measured 2026-09-05, not predicted

### Baseline: production's unfixed body

| # | Outcome | What the database actually said |
|---|---|---|
| 1 | GREEN | first caller → `admin` |
| 2 | **RED** | `SECOND caller got role 'admin', expected agent` |
| 3 | GREEN | white-glove IT admin → `admin` |
| 4 | **RED** | `newcomer got role 'admin', expected broker` |
| 5 | **RED** | B never blocked (`dblink_is_busy`=0), A=`admin` B=`admin`, **admin count 2** |
| 6 | **RED** | `caller at a headless org got role 'admin', expected agent` |
| 7 | **RED** | `the RPC returned no role key at all: {success, user_id, organization_id}` |

Controls 1 and 3 are green here **by design** — first-user-wins agrees with a
hard-coded `'admin'` whenever the caller genuinely is the first claimed member.
That is why they need their own failing input (mutant 04, run below), and why
"all seven red on the old body" would have been a false claim.

### After applying the migration

**All seven green.** Control 5 over 3 runs: `dblink_is_busy`=1 every time (B
blocked for the full 3s), B returned 3–6 ms after A committed, A=`admin`
B=`agent`, **admin count 1** each run — pre-registered as 1 before running.

### Mutants, on the fixed body

Every cell below was **executed**. The predicted matrix this replaced got one
row wrong — see the note under the table.

| Mutant | Red | Green | Evidence |
|---|---|---|---|
| `03` minus `FOR UPDATE` | **5**, 4/4 runs | 1, 2, 3, 4, 6, 7 | busy=0, both `admin`, admin count 2 every run |
| `02` minus `AND user_id IS NOT NULL` | **3** | 1, 2, 4, 6, 7 | `white-glove IT admin got 'broker', expected admin` |
| `04` `v_role := v_default_role` unconditionally | **1, 2, 3, 5, 7** | 4, 6 | C1 `got 'agent'`; C2 `caller A got 'agent'`; C3 `got 'broker'`; C5 A=`agent`, **admin count 0**; C7 `first caller stored as 'broker'` |

**Mutant 04's row was predicted as "reds 1, 3, 5 / stays green 2, 4, 6". Running
it showed reds 1, 2, 3, 5, 7.** The prediction missed control 2 and control 7
because both open with an assertion that the *first* caller is `admin` — which
this mutant breaks — and reading the controls as "the second-caller test" and
"the return-shape test" hid that from a description-based reading. The rule
holds: a claim about which members of a set fail has to be enumerated by
running them, never derived from what each one is *for*.

That correction does not weaken the matrix. Every control still has at least
one mutant that reds it, and mutants 02 and 03 still red exactly one each —
which is what makes a red attributable. The first row is the
point of control 5 being two-session: removing the lock reds *nothing* in the
six sequential controls. A sequential test cannot tell a locked implementation
from an unlocked one, and if control 5 were sequential this change would ship
with an unprotected race and a full green board.

The no-lock failure is **deterministic, not probabilistic** — 4 runs out of 4.
B is dispatched while A provably still holds an open transaction, so there is
no window to miss.

### A mutant file is not verified until it has been applied FROM THE FILE

`mutants/03-no-row-lock.sql` was generated by deleting the line `  FOR UPDATE;`
— which took the **statement terminator** with it, leaving the lock `SELECT`
running into the next `INSERT`. `ERROR: 42601: syntax error at or near "INSERT"`.
The measurement behind its row was sound (it was produced from a hand-edited
body), but **the committed artifact could not be applied at all**, so the repo
carried no runnable reproduction of the most important control here. Fixed, then
**applied from the file unedited** and re-measured: `busy=0`, both racers
`admin`, admin count **2**, two runs out of two. Mutants 02 and 04 were then
applied from their files too, and 01 is production's own body.

That is the third instance of one shape in this change — the measurement right,
the committed file wrong: the `:'conn'` interpolation in
`control-5-dblink-single-call.sql` (psql does not expand variables inside
dollar-quotes), a restore that rolled back and left a mutant installed, and this
terminator. **Generating a mutant by deleting a line is not the same as having a
mutant that runs.** Apply every one of them from the file before recording its
row.

### Provenance of the mutants

Mutant 01 is not hand-written: `md5(pg_get_functiondef(…))` from production and
the md5 of the file's body both come to `0f8c87bb35f8aa31b3b245907666e892`.
Mutants 02–04 were derived from the shipped migration **by script** (re-derived
after the return shape changed), one targeted edit each.

## The text-level test

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
`broker-portal/__tests__/app/auth/setup/callback/route.test.ts` (12 assertions),
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
control. Breaking middleware's admit list on purpose and watching that one test
go red is what shows hop 2 executes the real routing decision rather than a
mocked stand-in.

**A correction, because the mechanism was first written down wrong.** This file
used to say `toBeNull()` distinguishes an admit from a crash "because a
middleware that threw would return exactly that". It would not: the catch block
sees a protected route and redirects to `/login`. `toBeNull()` does separate the
two, but for the opposite reason. That is now pinned by a test —
`redirects a crashed session to /login` — instead of being asserted in prose.
The distinction is not academic: the two order-dependent tests the SR found
printed exactly that `/login` when run alone.

Counts were measured with `--bail=0`, so they are exact rather than truncated.
The 04 red on the `'admin'` assertion fires on the count-is-zero branch, not on
a literal in `VALUES`; recorded as measured rather than as the test name reads.

---

## How they were run — and what the run had to work around

Against a **disposable** Supabase project holding a targeted replica of
`public.users`, `public.organizations`, `public.organization_members` and
`auth.users`, reached through the Supabase MCP. Never against production.

**The installed baseline was verified to be production's function, not a
paraphrase of it.** `pg_get_functiondef` on the replica did not match
production's md5 — because the replica's copy has the comments stripped. Once
`--` lines and blank lines are removed from both, the two bodies are
**byte-identical**, md5 `5331bf0cc2a9e04c9d914defc7b5937b`. A baseline that is
only approximately the real thing makes every red below meaningless, so this
was checked before anything was run.

Three things about the environment are worth knowing before you re-run these:

1. **`auth.uid()` is driven by a GUC**, and the controls set it with
   `set_config('request.jwt.claim.sub', …, true)`. Do **not** `SET ROLE
   authenticated`: the function is `SECURITY DEFINER` and runs as its owner
   either way, and switching role only RLS-filters the asserting `SELECT`s.
   The probe that established this also checked the negative case — with no
   claim set, `auth.uid()` is `NULL` — because an impersonation that "works"
   without being set proves nothing.

2. **`ASSERT` really does surface as an error** through the MCP. Verified with
   a deliberate `ASSERT false` before trusting a single green. Every control's
   verdict rests on that, so it is not something to assume.

3. **`public.users` must be seeded explicitly for pre-seeded members.**
   `organization_members.user_id` carries a foreign key to *both* `auth.users`
   and `public.users`, and nothing in the schema populates the second from the
   first. Production happens to have an `on_auth_user_created` →
   `handle_new_user()` trigger that does — controls 4 and 6 were silently
   depending on it and broke on a replica without it. They now seed the row
   themselves. A control must not lean on a trigger it never declared.

## Running them

Against a **disposable** database — a Supabase branch, or any throwaway
Postgres with this schema. **Never against production**: this is the auth path.

```bash
export DATABASE_URL='postgresql://…'   # direct connection, not the pooler

# apply the fix
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260905120000_backlog_3096_setup_first_user_wins.sql

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

### No psql? Use `control-5-dblink-single-call.sql`

`control-5-run.sh` needs two shell-driven psql sessions. Where the only route
to the database is a stateless API (the Supabase MCP, the dashboard SQL editor
— every call its own session, no transaction spanning calls),
`control-5-dblink-single-call.sql` does the same race inside **one** statement
using `dblink`, and it is the form the 2026-09-05 results came from. Its header
carries the connection caveats: dblink refuses an unauthenticated local socket
for a non-superuser, so it needs a password-authenticated login role, and on
Supabase the pooler port answered where the direct port did not.

### VERIFY THE RESTORE. Do not assume it.

**A restore that shares a statement with anything that errors is rolled back
with it, and leaves the mutant installed.** That happened on 2026-09-05: the
`CREATE OR REPLACE` restoring the shipped body was batched with a `DROP ROLE`
that failed on dependent privileges, so the whole call rolled back and the
database was still running the no-filter mutant. It was caught only because the
next step re-read the installed definition instead of trusting the restore.

After every restore, read the definition back — with `--` comment lines
stripped, since the mutants' own comments mention the very strings you are
grepping for — and re-run the control that discriminates the mutation you just
undid:

```sql
with def as (select pg_get_functiondef('public.auto_provision_it_admin'::regproc) as d),
     lines as (select unnest(string_to_array(d, E'\n')) as ln from def),
     code as (select string_agg(ln, E'\n') as c from lines where ln !~ '^\s*--')
select position('FOR UPDATE' in (select c from code)) > 0 as lock_present,
       position('user_id IS NOT NULL' in (select c from code)) > 0 as filter_present;
```

## Deployment ordering — the migration goes first

This is no longer a migration-only change: `broker-portal/app/auth/setup/callback/route.ts`
reads the `role` key the migration adds.

**Apply the migration before, or together with, the portal deploy.** If the
portal ships first, `data.role` is `undefined` for every fresh provision,
`canGrantAdminConsent` fails closed, and a genuine first IT admin is sent to
`/dashboard` instead of the Microsoft consent page. It self-heals — their next
visit to `/setup` hits the existing-membership branch, sees role `admin` with
consent not yet granted, and forwards them to `/setup/consent` — but it is a
visible degradation for the length of the window, and it is avoidable by
ordering the two correctly.

Failing closed is the right default (nobody is handed a consent page they
should not have), but "right default" is not "no consequence".

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
