# BACKLOG-3503 harness — split agreements, migration 1

Executes `supabase/migrations/20260922220719_backlog_3503_commission_agreements.sql`
— **the shipped file itself, not a copy** — on a real Postgres 17.6, and records
what every control and every mutant did.

**It has been run.** Seven times, on 2026-09-22, 2026-09-23 and 2026-09-24, every
time on the same Postgres 17.6 test venue (the venue is named on the backlog
item, not in this repository): as first written; again after the agent's own-row
read was gated on active membership; again after that gate was extended to the
broker and the admin; again after SR's implementation review; again after the
founder ruled that an agreement may only be written FOR an active member; again
after he **refined** that rule to admit a backdated agreement inside the agent's
active period (see *The reversal*, *The ruling extended*, *The SR round* and *The
subject*); and again after the table, both RLS helpers and the agreement read
helper were renamed to replace "commission" with "split" throughout their
identifiers — `agent_split_agreements`, `split_agreement_in_force`,
`can_write_split_agreements`, `is_active_split_member` — plus every derived
constraint, index and policy name (BACKLOG-3503, the founder's terminology
correction: a deal pays a *commission*; the brokerage/agent division of it is a
*split*). The recorded run is the seventh: **30 controls, 210 assertions, all
green; 41 mutants × 30 controls = 1,230 runs, 3:43.90 wall clock (`time`,
real).** Every `RED:`/`green:` line is identical to the pre-rename round with
zero exceptions — the rename changed no behaviour. (One `CONTROL FAILED` detail
message, C26's, differs only in its `now()` timestamp; that is message text, not
a RED set.) Every mutant reddens at least one control and every control is
reddened by at least one mutant. Every result below was measured; none was
predicted. `control-run.txt`
and `mutant-run.txt` in this directory are the runs' own output, unedited.

It is not in CI: CI has no database. The text-level tripwire that does run in CI
is `broker-portal/__tests__/migrations/commission-agreements-3503.test.ts`, and
its table is at the bottom of this file.

**Nothing has been applied to production, and nothing here can reach it.**

---

## The transport, stated plainly

`supabase/tests/backlog-3364/run.sh` and `backlog-3096/`'s scripts take a
`postgresql://…` URL and run `psql` here, as a client. **That does not work from
the developer machine:** the venue's database port does not answer it. The venue
is reachable over SSH and the database is healthy inside its container; only the
direct client path is closed.

So `run.sh` pipes SQL *to* psql running **on the venue, inside the container**:

```bash
ssh -o BatchMode=yes "$SSH_HOST" \
  "docker exec -i $PG_CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"
```

Four consequences, all handled in `run.sh` and all worth knowing before editing it:

1. **`\i <path>` cannot be used.** A path would resolve *inside the container*,
   where this repository does not exist. Every file — the migration, the mutant,
   the fixtures, the control — is concatenated **on the client** into one stream.
2. **The URL host gate has nothing to check.** 3364's runner refuses any host
   that is not loopback or a Tailscale address; there is no host here. It is
   replaced by a **caller-supplied container name** plus a **refusal unless
   `public.users` is empty**. Production can never satisfy the second, so the
   worst outcome of a mistyped `SSH_HOST` is a refusal.
3. **The migration must not open its own transaction.** Every control runs
   inside one `BEGIN … ROLLBACK` that `run.sh` writes. A top-level `COMMIT;`
   inside the migration would commit the two tables onto the shared venue and
   the gate would then refuse every later run. `strip_txn` removes top-level
   `BEGIN;`/`COMMIT;`/`END;` lines from the stream, the migration deliberately
   carries none, and the tripwire's *opens no transaction of its own* assertion
   guards that. **`strip_txn` is line-based** and would also strip a bare
   `COMMIT;` on its own line inside a dollar-quoted body; the migration has
   none, and re-running `gate` after a run is the backstop.
4. **There is no PostgREST.** Role switching is simulated with
   `set_config('role', …)` plus `request.jwt.claim.sub`, which is the shape
   PostgREST itself produces. The real request path is not exercised — see
   *What this does not prove*.

## Running it

```bash
H=supabase/tests/backlog-3503/run.sh

bash $H gate       # venue gate. Stop on any GATE FAIL.
bash $H controls   # 30 controls, each in its own rolled-back transaction
bash $H mutants    # 41 mutants x 30 controls
bash $H mutants m24   # one mutant, by name fragment
```

**`SSH_HOST` and `PG_CONTAINER` have no defaults and the script refuses to start
without them.** The venue is not named in this repository — `backlog-3364/run.sh`
set that precedent by taking its target as input and validating it rather than
publishing it. Both values are recorded on the backlog item.

A full `mutants` run took **170 s**, and **175 s** on the round after it;
`controls` takes about 5 s. An *implausibly fast* green is a broken harness — if
`controls` returns instantly with no assertion counts, the stream never reached
psql.

**Re-run `gate` after any run.** `target_tables_absent=true` is the proof that
nothing leaked out of a transaction.

## Venue gate — re-run 2026-09-23, after 1,260 transactions

| Check | Value |
|---|---|
| database / connected role / server | `postgres` / `postgres` / 17.6 |
| `public.users` rows | **0** |
| `public.organizations` rows | **0** |
| `agent_split_agreements` / `organization_franchise_fees` exist | **no** |

The gate refuses unless all four hold. The empty-`users` check is the one that
makes production unreachable by construction.

Two facts about production were measured **read-only over MCP**, never written,
and both are why the migration is shaped as it is:

- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated,
  service_role` is in force (`pg_default_acl`, grantor `postgres`, privileges
  `arwdDxtm`) — on production **and** on this venue. Hence `REVOKE ALL`.
- `service_role` has `rolbypassrls = true`. Append-only binds `authenticated`
  only.

---

## Controls — all 30 GREEN, 210 assertions

Each runs inside `BEGIN … ROLLBACK` after `fixtures.sql`. Role cases run as
`authenticated` with `request.jwt.claim.sub`. `pg_temp.check` counts every
assertion and `run.sh` refuses a GREEN with zero assertions, so a control that
matched nothing cannot pass.

| Control | Proves | Assertions |
|---|---|---|
| `c01` | a broker of org B sees none of org A's agreements or franchise fees | 4 |
| `c02` | an agent sees their own agreement rows and no colleague's | 2 |
| `c03` | an agent cannot insert an agreement, not even their own | 1 |
| `c04` | `it_admin` can neither write nor read either table (founder ruling) | 4 |
| `c04b` | broker **and** admin can insert on both tables — the pair that makes an `is_org_admin` write rule turn both C4 and C4b red | 4 |
| `c05` | no UPDATE: **42501 specifically**, and the row unchanged. A grant without a policy would be a silent 0-row no-op instead | 3 |
| `c06` | no DELETE, and nothing disappears | 3 |
| `c07` | signed out, nothing is reachable — not the tables, not the helpers | 4 |
| `c08` | a client cannot name `set_by`; a plain broker INSERT lands `set_by = auth.uid()`, `set_at = now()` | 4 |
| `c09` | a broker of A cannot write into org B, on **either** table (the franchise half has no member clause, so the org check is all that stops it) | 4 |
| `c10` | the helper answers "in force ON DATE D", not "today", and never returns a row dated after D | 4 |
| `c11` | two rows share `effective_from`; the one written LAST wins although its `set_at` is EARLIER | 4 |
| `c12` | absent is ZERO ROWS, never a row of zeros | 2 |
| `c13` | the read helpers are SECURITY INVOKER — an agent asking about a colleague gets the correct non-answer | 4 |
| `c14` | the franchise fee is effective-dated the same way, **resolves a same-day tie the same way** (the correction wins, not the row with the later `set_at`), and an agent cannot read it in M1 | 6 |
| `c15` | the constraints that encode the fee model: the split sums to 100, cadence is constrained, no fee is negative | 5 |
| `c16` | the founder's worked example, computed from what the helpers return | 7 |
| `c17` | catalog: **both** RLS helpers are DEFINER with `SET search_path = public`; neither read helper is DEFINER; the member check names the NEW ROW's org; the own-row policy carries both of its terms; **and a sweep of every policy for a self-comparison** | 16 |
| `c18` | **privilege level**: UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER absent for `anon` and `authenticated` on both tables; `set_by` and `set_at` not INSERT-grantable; plus the behavioural half — the weakest signed-in role's TRUNCATE is refused and all twelve rows survive | 34 |
| `c19` | a user holding agreements cannot be deleted, **asserted by constraint name**, with memberships cleared first; the same for the organization; the broker who *set* the rows is held too; and a user holding nothing IS deletable | 7 |
| `c20` | catalog: all five foreign keys exist and every one is ON DELETE NO ACTION | 6 |
| `c21` | a **deactivated** agent (`license_status = 'suspended'`, membership row intact) reads none of their own rows — table and helper — while their broker still reads all of them | 6 |
| `c22` | a **removed** agent (membership row DELETEd) reads none of their own rows — table and helper — while their broker still reads all of them. They are still an active member of the *other* org, which is what makes an org-blind rule visible | 7 |
| `c23` | a **deactivated broker** and a **deactivated admin** read 0 from **both** tables, by table and by helper, while the active broker of the same org reads all 7 agreements and all three franchise fees in the same transaction | 18 |
| `c24` | neither of them can INSERT into either table — **42501 specifically** — nothing lands, and the active broker of the same org still writes both | 8 |
| `c25` | the INSERT policy's **subject** clause, four shapes over the same rows: a **deactivated** agent dated **inside** their active period is **admitted** (the founder's refinement), the same agent dated **after** they left is refused, a **removed** agent is refused by the EXISTS finding no row at all, and an **active** agent is admitted at any date — two admissions so a write rule stuck at false cannot satisfy it | 13 |
| `c26` | the deactivation trigger records the **transition**: an active member has no date; deactivating stamps one; a write that does not name `license_status` leaves it; **re-deactivating** an already-suspended row does not move it; an unrelated column bump does not move it; reactivating **clears** it; deactivating again re-stamps; expiring leaves it | 8 |
| `c27` | the date boundary **swept, not sampled**: the day before (allowed), the day **of** (allowed — inclusive), the day after (refused `42501`), rows landed to match, a suspended row with **no recorded date** (refused — fail closed), and the comparison resolving against **UTC** under an explicit `America/Los_Angeles` session | 11 |
| `c28` | the founder's own case end to end: the agent has already left, the broker records an agreement dated to the March closing, and `split_agreement_in_force` **resolves it on the day of the closing** instead of returning zero rows — with the refusal that still stands (dated after they left) asserted beside it | 6 |
| `c29` | the date arm's **status gate**: a subject at `'expired'` still carrying a deactivation date is refused even inside their recorded period, no row survives, and a **suspended** subject at the same offset is admitted | 5 |

**Why C18 exists, and why it is late.** C05 and C06 assert a SQLSTATE at the
moment of a write. They cannot see a privilege that is *granted but never
exercised*. TRUNCATE is exactly that: a table-level operation that row-level
security never evaluates. Measured on this venue during plan review — with
TRUNCATE left granted to `authenticated`, **all eighteen of the then-existing
controls stayed green** while the lowest-privilege signed-in fixture role
emptied both tables across every organisation. `REVOKE ALL` is what removes it
(the `D` in `arwdDxtm`); a narrower revoke does not. C18 is what proves the
revoke was wide enough, and `m24` is its red.

**Why C19 asserts names and clears memberships.** Every fixture subject also has
an `organization_members` row, and that table carries its own foreign keys to
`users(id)` and `organizations(id)`. With memberships in place, deleting the
agent raises `23503` whether or not this migration's own key exists — so a
control asserting only the SQLSTATE would have gone green off a neighbouring
table forever, and would have stayed green if 3503's key were later rewritten
`ON DELETE CASCADE`.

**Why C20 is a separate file, stated honestly.** It began as C19's last
assertion. Measured: under every FK mutant it fired *first* and C19's named
assertions — the reason C19 exists — never ran. Split, both have their own red.
C20 cannot be given an *isolated* red: Postgres cannot change an existing key's
delete action in place, so every mutation must DROP and re-ADD the constraint,
which also moves its referential-integrity trigger to the end of the firing
order — and C19's named assertions see that. Every FK mutant therefore reddens
both. C20 is kept because it states the rule directly rather than leaving a
reader to infer it from which error a delete raises.

### The C11 fixture is CONSTRUCTED, not transcribed

`fixtures.sql` gives one same-day pair an **earlier `set_at` and a later `seq`**.
That pair was built from two measured semantics — `now()` is transaction-start
time (measured on production), and `seq` is `nextval` order allocated at INSERT
execution — **not** from observing a producer emit it. No writer in this
repository has been observed producing that shape, because none exists yet:
BACKLOG-3504 will be the first. Read C11 as a claim about what `now()` and `seq`
do, which is measured, and not as a claim about a producer, which is not.

---

## The reversal — the own-row read is gated on active membership

The first version of this migration shipped the agent's own-row SELECT policy as
a bare `agent_user_id = (SELECT auth.uid())`, on the reasoning that an agent who
leaves a brokerage keeps the record of what that brokerage promised them. **That
decision was reversed by the founder after the PR was opened.** An agent reads
their own rows only while they are an active member of the organization that
wrote them. The reasoning is recorded on BACKLOG-3503; this file records the
shape.

Losing access has **two different shapes in the data**, and a rule that handles
one silently misses the other:

| Product action | What it writes | What a read rule must notice |
|---|---|---|
| Remove (`broker-portal/lib/actions/removeUser.ts`) | DELETEs the `organization_members` row | no row matches at all |
| Deactivate (`broker-portal/lib/actions/deactivateUser.ts`) | sets `license_status = 'suspended'`, row stays | the row matches; its **status** does not |

SCIM (`supabase/functions/scim/handlers/users.ts`) and `directory-sync` write the
same `'suspended'`. So the rule is `public.is_active_split_member(org)`:
a member row for this caller, in **this** organization, at
`license_status = 'active'`.

### Why `= 'active'` and not `NOT IN ('suspended','expired')`

The CHECK on `organization_members.license_status`
(`20260122_b2b_broker_portal.sql:90`) admits four values — `pending`, `active`,
`suspended`, `expired`. The **writers** admit fewer, and the writers are what
decides:

- every writer that creates a membership row carrying a `user_id` writes
  `'active'` — `jit_join_organization`, `auto_provision_it_admin`,
  `_ensure_personal_organization_for`, `claim_pending_invite`,
  `handle_new_user_invitation_link`, the portal's auth callback, SCIM,
  `directory-sync`;
- the only move away from it is to `'suspended'`, and back;
- `'pending'` belongs to **invite** rows, which carry `invited_email` and a NULL
  `user_id`, so they can never match `m.user_id = auth.uid()`. Measured on
  production: all 9 `pending` rows have a NULL `user_id`; all 10 rows with a
  `user_id` are `active`;
- **no writer anywhere in this repository sets it to `'expired'`.** The value is
  in the CHECK and rendered by the admin portal, and nothing produces it.

So the two spellings are behaviourally identical **today**, and they differ on
the state nobody has written yet: `= 'active'` denies it, `NOT IN (…)` admits
it. Access control fails closed. `= 'active'` is also the spelling three
policies already on this database use for the same question
(`organization_identity_providers`, `scim_tokens`, `scim_sync_log`).

### What the reversal did NOT change, stated

- **The INSERT policy's member-EXISTS had no subject test at all**, so a broker
  could write an agreement for an agent who is suspended, at any date. That was
  outside this round's ruling and stayed true for two rounds. It is **no longer
  true**: the founder ruled the subject must be active (2026-09-22) and then
  refined that a day later to allow a backdated agreement inside the agent's
  active period. See *The subject — judged by their ACTIVE PERIOD, not by their
  status today* below.
- **`set_by` stays `ON DELETE NO ACTION`.** The broker who writes a split cannot
  afterwards be hard-deleted; the founder accepted that, because the product
  deactivates rather than deletes. C19 and C20 assert it by constraint name.

---

## The ruling extended — a deactivated BROKER or ADMIN loses it too

The round above left one thing open, and the PR's own summary asked it: does
deactivation cut a suspended **broker or admin's** read and write as well? The
founder's answer is yes. "No no accese if they are deactivted" was said about
agents, and the person who sets an agent's pay is not the exception to it.

So `can_write_split_agreements` gained the same term, in the **same
EXISTS** as the role term:

```sql
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.role IN ('broker', 'admin')
                    AND m.license_status = 'active');
```

One EXISTS, not two, and not a call to `is_active_split_member` beside a
role test: with two clauses a caller could satisfy one by one membership row and
the other by a different row. One row must carry both.

**One helper fronts all four policies** — the broker/admin SELECT and INSERT on
`agent_split_agreements`, and the same pair on
`organization_franchise_fees` — so the term lands on the read and the write, on
both tables, from one edit. That is the fit rather than a compromise: the ruling
covers reading and writing on both tables, so there is no half of it that wants
a different rule, and splitting the helper would mean writing the same sentence
twice and letting the copies drift.

**The spelling is `= 'active'` for the reasons already set out above** — the
writers admit fewer values than the CHECK does, and an exclusion list fails OPEN
on a state added later. Nothing in that argument is specific to the agent's rule.

**The deactivate path is one path, not one per role.** `deactivateUser.ts` sets
`license_status = 'suspended'` whatever the member's role is, so
`u_broker_sus` and `u_admin_sus` in `fixtures.sql` are the same row shape as
`u_agent_sus` with a different `role`. They hold **no agreement rows of their
own** — what they lose is the office-wide read and the write, not a row about
themselves — so adding them changed no count in any existing control.

**There is no separate org-scope mutant for the write rule.** The status term
sits inside the same `EXISTS` as `m.organization_id = p_org_id`, so it cannot be
org-blind while the role test is org-scoped; a rule that loses the organization
loses it for both terms, and that is `m11`.

### The fixture that makes an org-blind rule visible

`u_agent_gone` is removed from org A **and still an active member of org B** —
an agent who moved brokerages. Without that second membership, a rule asking
"is the caller an active member of *some* organization" would pass C22 while
leaking every former office's rows. Mutant `m34` is that rule, and C22 is the
only control that reds on it.

---

## The subject — judged by their ACTIVE PERIOD, not by their status today

**The founder's rule, refined 2026-09-23** (`pm_comments` `92f46fb4` on
BACKLOG-3503, refining `dc342335` of 2026-09-22): a broker may record an
agreement for an agent who has left, **as long as its effective date falls
inside the period that agent was active**. Nothing new may be dated after they
left. His driving case, in his words: *an agent closes a deal in March, leaves in
April, and the broker goes to record their commission agreement in May.*

The INSERT policy's member-EXISTS therefore distinguishes four shapes:

| subject | membership row | outcome | refused by |
|---|---|---|---|
| **active** | present, `'active'` | **admitted**, no date test at all | — |
| **deactivated, dated inside the period** | present, `'suspended'`, carries `deactivated_at` | **admitted** — the new case | — |
| **deactivated, dated after the deactivation** | same row | refused | the date comparison |
| **removed** | none — `removeUser.ts` DELETEs it | refused | the EXISTS finding nothing |

### What had to be built to ask that question at all

**The end of the active period did not exist as data.** `organization_members`
carries `joined_at` but had no deactivation date, there is no membership-history
table, and `updated_at` is bumped by `update_org_members_updated_at` on **any**
update. Measured on production before the column was added: zero columns match
`%deactiv%`, `license_status = 'suspended'` has **zero rows**, `'active'` has 10
and `'pending'` 9. No backfill population, no ambiguous history — the cheapest
moment the column will ever be added.

So the migration adds `organization_members.deactivated_at timestamptz` and the
trigger `org_members_track_deactivation`. **A trigger rather than an edit to
`deactivateUser.ts`**, because four writers across three runtimes move a row to
`'suspended'`:

| writer | shape |
|---|---|
| `broker-portal/lib/actions/deactivateUser.ts:115-119` | the portal Deactivate button |
| `supabase/functions/scim/handlers/users.ts:646` | SCIM PatchOp `active:false` |
| `supabase/functions/scim/handlers/users.ts:824-831` | SCIM DELETE handler — **unconditional**, never reads the current value |
| `supabase/functions/directory-sync/index.ts:936-946` | member gone from the directory |

Derived by execution, not by grep alone: a `pg_proc` scan of every `public`
function whose definition matches `license_status` or `organization_members`,
plus a repo-wide TS/TSX/Deno grep. **No writer anywhere INSERTs a row already at
`'suspended'`** — every INSERT writes `'active'` or `'pending'` — so a row-level
`BEFORE UPDATE` trigger sees every transition that exists. Three functions that
matched on `license_status` were ruled out by reading them rather than assuming:
`admin_update_license`, `suspend_account_for_dispute` and
`reinstate_suspended_account` all write the account-event table and
`public.users`, never `organization_members`.

### The trigger tests the TRANSITION, and that is the load-bearing part

```sql
BEFORE UPDATE OF license_status ... FOR EACH ROW
WHEN (OLD.license_status IS DISTINCT FROM NEW.license_status)
```

Written the obvious way instead — `IF NEW.license_status = 'suspended' THEN
stamp` — the SCIM DELETE handler's unconditional write, and every
`scim_synced_at` bump on an already-suspended row, would push the date
**forward**. The active period silently widens and the rule re-admits exactly the
agreement it refuses. `m38` is that trigger; `C26` is its red.

**`C26` has to defeat a vacuity trap to see it.** `now()` is constant for a whole
transaction and `run.sh` wraps each control in one `BEGIN … ROLLBACK`, so a
re-stamp writes the same instant the column already held and a broken trigger is
indistinguishable from a correct one. C26 seeds an explicit past value first —
and asserts the seed survived — so the re-stamp has something visibly different
to overwrite.

### The fixture trap this round nearly shipped

Before this round, `fixtures.sql` created its suspended subjects by **INSERTing
them at `'suspended'`**. A `BEFORE UPDATE` trigger never sees an INSERT, so every
one of them would have carried `deactivated_at` NULL — and every suspended-subject
assertion in C25, C27 and C28 would have been refused by the `IS NOT NULL` guard
**without ever reaching the date comparison**. All of them would have reported
GREEN, the date logic would have been entirely untested, and the mutants that
move the boundary would have reddened nothing.

The fixture now does what production does: INSERT `'active'`, then UPDATE to
`'suspended'`. The date is written by the real trigger, never by hand — a
hand-written value would hide the same hole one layer down, by proving the policy
works on a value no producer had to generate. The fixture **asserts** all four
rows were stamped, so a broken trigger fails there, loudly, instead of passing
for the wrong reason. Controls express their dates as **offsets** from
`t3503.d_sus`, which is read back out of the column.

### The measurement that justifies every new control

Each mutation was run **before** its control was written, against the code the
control would sit beside. RED sets against the **26 controls that existed then**:

| mutant | RED against the pre-existing 26 |
|---|---|
| `m36` the subject clause flattened to bare membership | **c25** |
| `m38` trigger ignores the transition | **NONE** |
| `m40` comparison loses its UTC pin | **NONE** |
| `m41` boundary becomes exclusive | **NONE** |
| `m42` date arm loses its status gate | **NONE** |

**Five of six were invisible.** And `c25` itself, *unmodified*, stayed **GREEN**
against the new policy — its deactivated-subject INSERT used a fixed future date
(`2026-10-01`), so the row was refused by the new date arm instead of the old
status term and the behavioural reversal produced no signal anywhere. All 26
controls stayed green through a rule reversal. That is why C25 was rewritten to
offsets and why C26–C29 exist.

### One guard no mutant can hold, and what was done about it

`m39` was written for `m.deactivated_at IS NOT NULL`, run against the whole
suite, and reddened **NOTHING** — because NULL propagates through the comparison
to NULL, NULL is not TRUE, and the row is refused either way. It is a genuine
**equivalent mutant**. It was **removed** rather than shipped as a permanently
green one, which would have broken this directory's "every mutant reds at least
one control" invariant and misreported the suite.

The guard itself stays: it states the refusal as the **intent** (a suspended row
with no recorded date fails closed, deliberately — not a missing guard) and keeps
that refusal if the comparison is ever rewritten in a form where NULL does not
propagate. Since no mutant can pin it, **the CI text test does**, and that
assertion was itself proven to fail (see *Text tripwire*). `C27` still exercises
the NULL **behaviour**.

### The status gate on the date arm, which looks redundant and is not

The second arm requires `m.license_status = 'suspended'`. Only a suspension
writes `deactivated_at`, so the gate reads as noise — but the trigger
deliberately **leaves the column alone** on a move to `'expired'` or `'pending'`,
because the recorded date is still true. A member deactivated and then expired
therefore sits at `'expired'` carrying a date, and an ungated arm admits them.
The same hole opens for any fifth value added to
`organization_members_license_status_check` later — the exact fail-open this
migration spells `= 'active'` rather than `NOT IN (…)` everywhere else to avoid.
`C29` is the refusal, produced through the real transitions
(active → suspended → expired); `m42` is the gate deleted.

### The UTC pin, and the only condition that reveals it

`deactivated_at` is `timestamptz` and `effective_from` is `date`, so one must be
converted. A bare `::date` resolves against the **session** TimeZone — a property
of the connection, not of this rule. Production runs UTC on every role today
(`pg_db_role_setting` carries no TimeZone for `anon`, `authenticated`,
`authenticator` or `postgres`), so the spellings agree there **by coincidence of
configuration**. `C27` sets `America/Los_Angeles` explicitly for one arm, against
a deactivation pinned at 01:00 UTC whose local date is the previous day; that is
the only condition under which `m40` reds. Direction of the off-by-one: an
evening-Pacific deactivation lands on the later UTC date, so the rule is one day
**more generous** — the safe side, since refusing a genuine March agreement is
the harm this change exists to prevent.

### What the refinement did NOT change

- **Reading is untouched.** An agent who loses membership lost the read in the
  C21/C22 round; a deactivated broker or admin lost read and write in the
  C23/C24 round. The broker's office-wide read tests the **reader's** status,
  never the subject's, so an active broker still reads a departed agent's rows.
- **The ledger stays append-only.** This gates the INSERT; nothing already
  written is withdrawn.
- **The lower bound is unaddressed.** Nothing tests `effective_from` against
  `joined_at`, so an agreement may be dated **before** the subject joined —
  which is what this file already did for an active member and still does. Filed
  as **BACKLOG-3522**; it would affect active agents too, so it does not belong
  in this migration.
- **One active period, not a history.** SCIM PatchOp `active:true`
  (`users.ts:650`) writes `'active'` onto an existing row, so a member can have
  more than one active period, and clearing the column on reactivation loses the
  gap. An agreement dated inside a past suspension gap would be admitted.
  Modelling it needs the membership-history table this repo does not have. Taken
  knowingly, and invisible today: `scim_tokens` and
  `organization_identity_providers` both hold **zero rows**.

**`m20` was rebased for it, and the rebase was not optional.** That mutant
re-creates the INSERT policy in order to plant an unqualified `organization_id`,
so a body copied from before this round drops the new date arm as a side effect.
Measured, both ways: left on the pre-refinement body it reddened
**c17 c25 c27 c28 c29** — four reds saying nothing whatever about the unqualified
column it names. Carried forward, with a self-check asserting every term of the
clause is still present, it reds **c17 alone**, exactly as before. Same artifact
class that `m11`, `m16` and `m17` were rebased out of, caught the same way: by
reading the RED set rather than the mutant.

---

## Mutants — 41, every one reds at least one control

Each prints `MUTATION APPLIED: <catalog evidence>` inside the transaction before
any control runs, after verifying its own effect from the catalog; `run.sh`
refuses a red without that line (`RED WITHOUT PROOF`) and refuses a mutant that
never printed one. 41/41 printed it, and no mutant has an empty RED set. Full output in `mutant-run.txt`.

| Mutant | RED |
|---|---|
| `m01` read helpers marked SECURITY DEFINER | c13 c17 c21 c22 c23 |
| `m02` write rule reuses `is_org_admin` | c01 c04 c04b c05 c06 c08 c10 c11 c14 c15 c16 c21 c22 c23 c24 c25 c27 c28 c29 |
| `m03` `set_at DESC` ordered before `seq DESC` | c10 c11 c16 |
| `m04` `effective_from ASC` | c10 c11 c16 c28 |
| `m05` no `effective_from <= p_on_date` filter | c10 c11 c12 c14 c16 |
| `m06` `set_by` inside the INSERT grant | c08 c18 |
| `m07` `set_by` has no default | c04b c08 c15 c24 c25 c27 c28 c29 |
| `m08` UPDATE granted, with a policy | c05 |
| `m09` DELETE granted, with a policy | c06 c18 |
| `m10` anon can read | c07 c18 |
| `m11` write rule ignores the org *(rebased)* | c01 c06 c09 c13 c23 |
| `m12` writer SELECT policy `USING (true)` | c01 c02 c04 c06 c13 c14 c21 c22 c23 |
| `m13` agreements readable org-wide | c02 c04 c13 c17 c21 c22 c23 |
| `m14` helper ignores the agent | c10 c12 c13 |
| `m15` no split-sum CHECK | c15 |
| `m16` `it_admin` added to the writer list *(rebased)* | c04 |
| `m17` `agent` added to the writer list *(rebased)* | c02 c03 c13 c14 c22 |
| `m18` franchise fee readable org-wide | c04 c14 c23 |
| `m19` INSERT policy without the member check | c09 c17 c25 c27 c28 c29 |
| `m20` INSERT policy's unqualified `organization_id` | c17 |
| `m21` UPDATE granted **without** a policy | c05 |
| `m22` DELETE granted **without** a policy | c06 c18 |
| `m23` self-comparison in a *different* policy | c17 |
| **`m24` TRUNCATE granted** | **c18** |
| **`m25` `REVOKE ALL` omitted** (the default ACL grant stands) | **c05 c06 c07 c08 c18** |
| **`m26` RLS not enabled on the agreements table** | **c01 c02 c03 c04 c06 c09 c13 c21 c22 c23 c24 c25 c27 c28 c29** |
| **`m27` RLS not enabled on either table** | **c01 c02 c03 c04 c06 c09 c13 c14 c21 c22 c23 c24 c25 c27 c28 c29** |
| **`m28` `SET search_path` dropped from the DEFINER write rule** | **c17** |
| **`m29` agent FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m30` franchise `set_by` FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m31` org FK written ON DELETE RESTRICT, not NO ACTION** | **c19 c20** |
| **`m32` own-row policy reverted to the bare `auth.uid()` predicate** | **c17 c21 c22** |
| **`m33` active-membership rule drops the `license_status` filter** | **c21** |
| **`m34` active-membership rule drops the organization scope** | **c22** |
| **`m35` the WRITE rule drops the `license_status` filter** | **c23 c24** |
| **`m36` the INSERT policy's SUBJECT clause flattened to bare membership** | **c25 c27 c28 c29** |
| **`m38` the deactivation trigger ignores the TRANSITION** | **c26 c27** |
| **`m40` the date comparison loses its UTC pin** | **c27** |
| **`m41` the boundary becomes exclusive (`<`)** | **c27** |
| **`m42` the date arm loses its status gate** | **c29** |
| **`m37` `franchise_fee_in_force` ordered by `set_at DESC` before `seq DESC`** | **c14 c16** |

`m21`/`m22` and `m25` are the reason C05 and C06 assert a **specific** SQLSTATE.
A grant without a policy makes the write a silent zero-row no-op, and every one
of `m25`'s four reds reads `got OK` — "it raised something" would have passed
all four. **Do not let a later round relax those assertions.**

`m25` and `m26`/`m27` are the two likeliest wrong implementations of this
migration, because they are *omissions* rather than wrong choices.

`m35` reds **exactly C23 and C24 and nothing else.** That is why its body is
byte-identical to the pre-ruling helper: the only difference from the shipped
file is the status term, so its RED set is evidence about that term alone. Its
`MUTATION APPLIED` check asserts three things from `prosrc` — that
`license_status` is gone, and that `m.role` and `m.organization_id = p_org_id`
are still there — because a mutant that emptied the body would red the same two
controls for a different reason.

### The RED-set diff for the round that added C25 and C14's new arms

*(History. The diff for the round after it — the subject-status ruling — is
below.)*

Six reds were **removed on purpose** and every other red is byte-identical.

**`m11`, `m16` and `m17` are REBASED onto the current write-rule body.** Each one
used to `CREATE OR REPLACE` a body copied from before the founder's ruling, so it
silently dropped the `license_status` term as well as making its named change —
and collected C23/C24 reds that said nothing about org-blindness, `it_admin` or
`agent`. **Six of their twenty recorded reds were that artifact.** Measured, both
before and after:

| Mutant | before | after | artifact removed |
|---|---|---|---|
| `m11` org term dropped | c01 c06 c09 c13 c23 **c24** | c01 c06 c09 c13 c23 | **c24** |
| `m16` `it_admin` added | c04 **c23 c24** | **c04** | **c23, c24** |
| `m17` `agent` added | c02 c03 c13 c14 **c21** c22 **c23 c24** | c02 c03 c13 c14 c22 | **c21, c23, c24** |

**No set went empty and no red was lost that another mutant does not already
own.** `m35` owns the write rule's status term exclusively (c23 c24 and nothing
else); `m32`/`m33` own the own-row status term. After the rebase c24 is still red
under m02 m07 m26 m27 m35, c23 under nine mutants and c21 under eight. Each
rebased mutant now asserts from `prosrc` that the status, role and org terms it
did **not** mean to touch are still present, so it cannot drift back.

Two reds that SURVIVE the rebase and are worth reading rather than skimming:

- **`m11` still reds c23**, for a real and different reason: with the org term
  gone the *active* broker over-reads org B's row, so c23's positive arm fails at
  `got 8`. That is c23 carrying a positive assertion as well as a negative one.
- **`m17` still reds c22** — but the row leaking through is **org B's**, not the
  removed agent's own, because `u_agent_gone` is an active org-B member and
  `agent` has just become a writer role there. C21/C22 open with an unqualified
  count on purpose (the claim is that they read *nothing*), and the message now
  says "anywhere" so it cannot be misread as a claim about their own row.

Everything else in the diff is a gain, and every gain is real:

| Gained | Mutant | Why |
|---|---|---|
| c25 | `m36` | the new control's whole purpose — see below |
| c25 | `m02` `is_org_admin` | the broker is not an admin, so every INSERT is refused, including the two that must succeed |
| c25 | `m07` `set_by` has no default | all three INSERTs fail `23502`, the same reason it reds C04b |
| c25 | `m19` INSERT policy without the member check | the **removed** subject's write is no longer refused (`got OK`) |
| c25 | `m26`, `m27` RLS not enabled | no policy is evaluated |
| c14 c16 | `m37` | the franchise-fee same-day tie — see below |

`m28` is the counter-example that makes the old artifact's mechanism plain: it
`ALTER`s the existing function instead of replacing its body, so it always
carried the shipped body — status term included — and it reds neither C23 nor
C24.

### The RED-set diff for the subject-status round — against `b9480eab9`

**Not one RED set moved.** `diff` over every `^m` and `RED:` line of the
committed log and this round's returns a single line:

```
71c71
< m36-insert-subject-must-be-active
---
> m36-insert-subject-ignores-license-status
```

That is the mutant's **file rename**, not a moved red. `m36` still reds `c25` and
nothing else — for the opposite reason, which is the whole point: the mutation is
now the term's REMOVAL. C25's owners are unchanged at six (`m02` `m07` `m19`
`m26` `m27` `m36`); no mutant gained a control and none lost one. The counts are
unchanged too: 37 mutants × 26 controls = **962 runs**, 37/37 `MUTATION APPLIED`,
no `RED WITHOUT PROOF`, no `VOID`, no empty RED set, 176 assertions over 26 green
controls. The venue gate was re-run afterwards and still reads
`target_tables_absent=true`.

Seven lines of the **full** log moved, every one of them C25's failure *text*:

| Mutant | was | now |
|---|---|---|
| `m02` | `a broker CAN write … for a DEACTIVATED agent, got 42501` | `...and CAN for an ACTIVE agent, got 42501` |
| `m07` | the same, `got 23502` | `...and CAN for an ACTIVE agent, got 23502` |
| `m19` `m26` `m27` | the REMOVED arm, `got OK` | the DEACTIVATED arm, `got OK` — arm 1 now fails first |
| `m36` | `a broker CAN write …, got 42501` | `a broker CANNOT write … for a DEACTIVATED agent, refused with 42501, got OK` |

`m07` settles something worth recording while it is measured: under it, C25's
arms 1 and 2 **pass** and only arm 3 reds, at `23502`. So Postgres evaluates the
RLS `WITH CHECK` **before** the NOT NULL constraint — both refusals are reached
before `set_by`'s missing default is ever noticed.

**`control-run.txt` did not move at all**, and that is a limit rather than a
reassurance: every control is green before and after and C25 kept its nine
assertions, so the control log has no power to show this change. Only the mutant
log does.

### The SR round — the two places the set was silent, and what closed them

SR's implementation review measured two probes against the 25 controls that
existed then. **Both returned RED: NONE.** A probe that reddens nothing is not a
clean bill of health; it is a dimension the suite cannot see, in either
direction.

**1. The INSERT policy's subject-status term (`msr01` → `m36`, control C25).**
Adding `AND m.license_status = 'active'` to the member-EXISTS — the clause about
the agent an agreement is written FOR — changed nothing any control could see. A
reviewer reading that log saw 25/25 and would have concluded nothing moved, on
the exact question the founder was about to be asked. C25 was written to close
that silence **whichever way he ruled**, asserting both shapes over the same rows
in the same transaction, with an active subject as a third arm so a write rule
stuck at false cannot satisfy it.

**He then ruled the term IN** (2026-09-22; see *The subject* above, which records
how he refined it a day later), so C25
now asserts that a deactivated subject and a removed subject are both refused and
an active one is not, and `m36` is that term **removed** — the direction the
ruling left open, and the likeliest regression. It reds **c25 and nothing else**,
which is what a control written for a dimension rather than for an answer buys
you: the ruling reversed and the control did not have to be rewritten around a
different set of mutants. The same rule is pinned in CI by the tripwire's
*requires the INSERT policy subject to be an active member, in the same EXISTS*,
because this harness needs a database and CI has none.

**2. The franchise fee's same-day tie (`msr02` → `m37`, control C14).** `m03`
mutates `split_agreement_in_force` alone, and the fee fixture had no pair
sharing an `effective_from` — so ordering the *other* helper by `set_at` reddened
nothing. The ordering contract is stated for both helpers and was pinned
behaviourally on one. The fixture now carries F2/F3 in the same long-transaction
shape as R2/R3 (later `set_at`, earlier `seq` on the mistake), C14 asserts the
fixture's shape and then that the correction wins, and `m37` reds **c14 and
c16**. The CI tripwire already pinned the ORDER BY *text* on both helpers; what
was missing, and is now present, is the behavioural half.

---

### The RED-set diff for the active-period round

The refinement of 2026-09-23 changed what the INSERT policy DOES, added a column
and a trigger to a shared table, and rewrote one control. Four movements, all
measured rather than inferred:

**1. Six pre-existing mutants gained reds, and none lost any.** `m02`, `m07`,
`m19`, `m26` and `m27` each gained **c27 c28 c29**; `m04` gained **c28**. Every
one is the expected shape — those mutants break the write rule, the `set_by`
default, the member check or row-level security outright, so any control that
performs a successful INSERT reds under them, and the three new controls all do.
No mutant's RED set shrank.

**2. `m36` was rewritten, not edited.** The old mutant deleted a
`license_status` term that no longer exists in that form. The new one flattens
the whole subject clause to bare membership, which is the reversal the
refinement is most likely to be confused with, and reds **c25 c27 c28 c29**.

**3. `m20` had to be rebased, and the RED set is what caught it.** See the note
at the end of the subject section: left on the pre-refinement body it reddened
five controls instead of one.

**4. `m39` was written, measured, and removed.** It is an equivalent mutant —
the `IS NOT NULL` guard changes no behaviour — so it reddened nothing and was
deleted rather than shipped always green. The guard is pinned in the CI text
test instead, and that assertion was proven able to fail.

**The pre-registration table is the important one**, and it is in the subject
section above: against the 26 controls that existed before this round, five of
the six mutations this round pins reddened **NOTHING**, and the unmodified `c25`
stayed **GREEN** through a behavioural reversal. Every control added here is
load-bearing by measurement, not by argument.

---

### The rename round — BACKLOG-3503, 2026-09-24

The founder corrected the terminology: the *commission* is what a deal pays; the
*split* is how the brokerage and agent divide it. The table, both RLS helpers
and the agreement read helper had "commission" in their identifiers where they
now say "split" — `agent_split_agreements`, `split_agreement_in_force`,
`can_write_split_agreements`, `is_active_split_member` — with every derived
constraint, index and policy name following mechanically (a `_pkey`, an
`_org_fkey`, a `_select_writer`, and so on, each inheriting the table's new
name). **Migration edited in place, not a follow-on `ALTER … RENAME`**: verified
against production before the edit — the migration is merged to `develop` but
applied nowhere (`schema_migrations` has no `20260922220719` row; the split
table, `organization_franchise_fees` and `organization_members.deactivated_at`
are all absent from production) — so renaming at the source means the old
identifiers never existed in applied history. The migration's own filename
keeps its pre-rename spelling on purpose; renaming a merged migration's
filename is a separate hazard this round does not take on.

**Diffed against the pre-rename run, not assumed identical.** `control-run.txt`
is byte-for-byte identical before and after — no control's message happens to
name any of the four renamed identifiers. `mutant-run.txt` differs on 17 of 322
lines (`diff`, 17 line-groups), and every one is accounted for: the old
identifiers appearing inside `MUTATION APPLIED` and `CONTROL FAILED` message
text, now reading with their new names, plus one `now()` timestamp in a single
C26 message. Restricting the diff to the `RED:` and `green:` lines alone — the
sets that decide whether a mutant is proven — gives **zero difference**: every
mutant reddens exactly the same controls it did before the rename, and the
`m01`…`m42` header sequence is unchanged. That is the expected shape for a pure
identifier rename, measured rather than assumed. This round: 30 green / 30, 210
assertions; 41/41 `MUTATION APPLIED`, 0 `RED WITHOUT PROOF`, 0 `VOID`, every one
of the 30 controls reddened by at least one mutant, 3:43.90 wall clock (`time`,
real).

**Straggler check after the rename:** a repo-wide search for all four
pre-rename identifiers, run against committed HEAD, returned nothing — recorded
on the backlog item rather than reproduced here, because pasting the search
pattern into this file would make it match its own search. Prose describing the
table's concept ("commission agreements" as a noun phrase) was swapped to
"split agreements" in this file, the migration header and two control/mutant
comments; the founder's own worked example is quoted verbatim in *The subject*
section above and in `c28`, and is left exactly as he said it; the
commission-tracking epic name (real money, not this table) and every filename
are unchanged.

---

## Text tripwire (CI) — made to fail before being trusted

`npx jest --config broker-portal/jest.config.js broker-portal/__tests__/migrations/commission-agreements-3503.test.ts --bail=0`
→ **20 passed, 20 total.** Each mutation below was applied to the committed
file, proved applied by an exact-string replace that refuses to run unless it
matches exactly once **and prints the file, the line number and the mutated line
back** — a non-empty `git diff --numstat` proves a mutation applied, not that it
applied where it was meant to — then run and restored with `git checkout --`.
The restored run is 20/20 and the tree is clean. The fix was committed **before**
any of these reverts, so no `git checkout --` could discard it.

Rows reading `n/16`, `n/17` and `n/18` were measured in earlier rounds, when the
suite had that many tests and the text they anchor on was already in its current
form; they were not re-run. The three rows reading `n/20` are this round's — the
active-period refinement — and each printed `git diff --numstat` (`1 1`) and the
mutated line before the suite ran. `Tests: 0 total` never appeared; every run
reported 20 total. The implementation was committed at `09b41d4e3` **before** any
of these reverts, so no `git checkout --` could discard it.

| Mutation | Tests | RED `it()` |
|---|---|---|
| franchise table's `ENABLE ROW LEVEL SECURITY` line deleted | 1/16 | enables row level security on both tables |
| `REVOKE ALL` narrowed to `REVOKE INSERT, UPDATE, DELETE` | 1/16 | revokes ALL from anon and authenticated on both tables |
| `GRANT UPDATE (agent_pct)` added | 1/16 | grants no UPDATE and no DELETE on either table |
| `set_by` added to the agreements INSERT column list | 1/16 | keeps set_by and set_at out of both INSERT column lists |
| `set_by` loses its `auth.uid()` default | 1/16 | gives set_by a NOT NULL default of auth.uid() on both tables |
| `set_at DESC` put back into the helper's ORDER BY | 1/16 | orders the read helpers by seq DESC, and never by set_at |
| `SET search_path` dropped from the write rule | 1/16 | marks both RLS helpers SECURITY DEFINER with a pinned search_path, and neither read helper |
| a read helper marked SECURITY DEFINER | 1/16 | *(same assertion)* |
| `SET search_path` dropped from the **own-row read rule** | 1/16 | *(same assertion)* |
| own-row policy reverted to the bare `auth.uid()` predicate | 1/16 | gates the own-row read on active membership, never on auth.uid() alone |
| the own-row policy renamed away | 1/16 | *(same assertion — `policyBody` throws rather than matching nothing)* |
| active membership spelled `NOT IN ('suspended','expired')` | 1/16 | spells active membership as license_status = active, and scopes it to the row's org |
| the active-membership rule loses `m.organization_id = p_org_id` | 1/16 | *(same assertion)* |
| `it_admin` added to the writer role list | **2/17** | names exactly broker and admin as writers, and never reaches for is_org_admin **+** gates the broker and admin read and write on active membership too |
| the write rule delegates to `is_org_admin` | **2/17** | *(the same two)* |
| **the WRITE rule loses `AND m.license_status = 'active'`** | **1/17** | gates the broker and admin read and write on active membership too |
| **the WRITE rule spells it `NOT IN ('suspended','expired')`** | **1/17** | *(same assertion)* |
| **the write rule's two terms split into separate `EXISTS`** — role in one, `is_active_split_member(p_org_id)` beside it | **1/17** | *(same assertion — one membership row must carry both)* |
| split-sum CHECK relaxed to `<= 100` **at the constraint** | 1/16 | carries the split-sum and cadence CHECK constraints |
| cadence CHECK gains a third value | 1/16 | *(same assertion)* |
| member check written as a self-comparison | 1/16 | writes the INSERT policy member check against the NEW ROW, not against itself |
| `AND m.license_status = 'active'` removed from the INSERT policy's member-EXISTS | 1/18 | *(that round's assertion, since rewritten — see the three rows below)* |
| **the trigger's `WHEN (OLD… IS DISTINCT FROM NEW…)` replaced by `WHEN (true)`** | **1/20** | records the end of the active period with a TRANSITION-guarded trigger |
| **`AND m.deactivated_at IS NOT NULL` replaced by `AND true`** | **1/20** | keeps the NULL guard on the date arm, which no mutant can pin |
| **`(m.deactivated_at AT TIME ZONE 'UTC')::date` reduced to `m.deactivated_at::date`** | **1/20** | judges the INSERT policy subject by their active period, in the same EXISTS |
| the `NOT APPLIED TO PRODUCTION` sentence removed | 1/16 | says in its header that it is not applied to production by this PR |
| the migration opens its own transaction | 1/16 | opens no transaction of its own |
| the franchise table renamed | 2/16 | creates both tables; gives set_by a NOT NULL default … |
| `run.sh` pointed at a different migration stamp | 1/16 | the file is not empty and the harness reads the same file CI does |

**One false green, and what it was.** The split-sum mutation was first written as
a replacement of the *first* occurrence of `CHECK (agent_pct + brokerage_pct =
100)` in the file. There are **two**: the header discusses it in prose before the
constraint declares it. The first run therefore edited a comment, the suite
stayed green — and that green would have been recorded as "the assertion is
vacuous". It is not: re-anchored on the constraint, it reds. A non-empty
`numstat` proves a mutation applied; it does **not** prove it applied where you
meant.

**One false RED, recorded so the next reader does not spend an hour on it.** The
`1/18` row's assertion — *requires the INSERT policy subject to be an active
member, in the same EXISTS* — is a regex over the two terms **in that order**, so
it also reds if the terms are simply **reordered** (`license_status` first,
`user_id` second): one `EXISTS`, same row, behaviourally identical, and the suite
goes red anyway. SR measured that from the other side (`1 failed, 17 passed, 18
total`, same `it()`). It fails **safe** — a correct edit gets a red naming the
right test, not a silent green — and the migration is immutable once merged, so
it is left as it stands rather than loosened. Read the assertion's *in the same
EXISTS* as *in this order, in the same EXISTS*.

---

## What this does NOT prove

1. **Production data** — fixtures only. Both tables are new and empty, so there
   is no cohort to check, but nothing here says anything about production rows.
2. **The PostgREST request path.** Roles are switched with `set_config`, not by
   a real token through a real connection. 3364's harness exercised PostgREST
   with the real client; this one does not.
3. **Anything `service_role` does.** `rolbypassrls = true`; no control can ever
   see it, and none pretends to.
4. **Lock behaviour under production traffic.** Both tables are new, so the
   apply takes no lock on an existing table — but the apply itself has not been
   run anywhere but here.
5. **Concurrency.** The same-day tie-break is proved from a constructed pair, not
   from two live sessions racing.
6. **Anything outside the database** — no portal, no desktop build, no UI.

## A note for BACKLOG-3096

`supabase/tests/backlog-3096/control-*.sql` run `DELETE FROM public.users` as
fixture cleanup. Those are harness files, not production, and their users hold no
split agreements today. **If a future 3096 run ever seeds one, its cleanup
will fail with `23503`** — that is C19's rule working, not a regression. Delete
the agreement rows first.

## The venue is not named here

`run.sh` refuses to start unless `SSH_HOST` and `PG_CONTAINER` are set, and has
no defaults for either. The earlier version hard-coded both. `backlog-3364/run.sh`
set the precedent: take the target as input, validate it, do not publish it.
Both values are on the backlog item.

## Fixture identifiers are invented

UUIDs sit in the `00000000-0000-4000-8000-00003503xxxx` block, each carrying a
`pii-allow-uuid` waiver; emails use the reserved `.example.test` domain; slugs
carry a `fixture-3503` prefix. No customer, address or real organisation name
appears anywhere in this directory. The venue held **zero** real rows when every
result above was measured.
