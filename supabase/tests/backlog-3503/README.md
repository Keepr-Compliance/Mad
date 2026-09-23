# BACKLOG-3503 harness — commission agreements, migration 1

Executes `supabase/migrations/20260922220719_backlog_3503_commission_agreements.sql`
— **the shipped file itself, not a copy** — on a real Postgres 17.6, and records
what every control and every mutant did.

**It has been run.** Five times, on 2026-09-22 and 2026-09-23, every time on the
same Postgres 17.6 test venue (the venue is named on the backlog item, not in
this repository): as first written; again after the agent's own-row read was
gated on active membership; again after that gate was extended to the broker and
the admin; again after SR's implementation review; and again after the founder
ruled that an agreement may only be written FOR an active member (see *The
reversal*, *The ruling extended*, *The SR round* and *The subject too*). The
recorded run is the fifth: **26 controls, 176 assertions, all green; 37 mutants ×
26 controls = 962 runs, 175 s wall clock.** Every mutant reddens at least one
control and every control is reddened by at least one mutant. Every result below
was measured; none was predicted. `control-run.txt` and `mutant-run.txt` in this
directory are the runs' own output, unedited.

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
bash $H controls   # 26 controls, each in its own rolled-back transaction
bash $H mutants    # 37 mutants x 26 controls
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

## Venue gate — 2026-09-22

| Check | Value |
|---|---|
| database / connected role / server | `postgres` / `postgres` / 17.6 |
| `public.users` rows | **0** |
| `public.organizations` rows | **0** |
| `agent_commission_agreements` / `organization_franchise_fees` exist | **no** |

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

## Controls — all 26 GREEN, 176 assertions

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
| `c25` | what the INSERT policy does about the **subject's** status: a broker CANNOT write for a **deactivated** agent (the status term refuses the row that survives) and CANNOT for a **removed** one (no row at all to find) — two refusals by two different halves of the same clause — with an **active** subject as the third arm, so a write rule stuck at false cannot satisfy it | 9 |

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
same `'suspended'`. So the rule is `public.is_active_commission_member(org)`:
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

- **The INSERT policy's member-EXISTS had no status term**, so a broker could
  still write an agreement for an agent who is suspended. That was outside this
  round's ruling and stayed true for two rounds. It is **no longer true**: the
  founder was asked the question directly and ruled that a broker cannot record
  an agreement for a deactivated agent at all. See *The subject too — an
  agreement may only be written FOR an active member* below.
- **`set_by` stays `ON DELETE NO ACTION`.** The broker who writes a split cannot
  afterwards be hard-deleted; the founder accepted that, because the product
  deactivates rather than deletes. C19 and C20 assert it by constraint name.

---

## The ruling extended — a deactivated BROKER or ADMIN loses it too

The round above left one thing open, and the PR's own summary asked it: does
deactivation cut a suspended **broker or admin's** read and write as well? The
founder's answer is yes. "No no accese if they are deactivted" was said about
agents, and the person who sets an agent's pay is not the exception to it.

So `can_write_commission_agreements` gained the same term, in the **same
EXISTS** as the role term:

```sql
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.role IN ('broker', 'admin')
                    AND m.license_status = 'active');
```

One EXISTS, not two, and not a call to `is_active_commission_member` beside a
role test: with two clauses a caller could satisfy one by one membership row and
the other by a different row. One row must carry both.

**One helper fronts all four policies** — the broker/admin SELECT and INSERT on
`agent_commission_agreements`, and the same pair on
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

## The subject too — an agreement may only be written FOR an active member

The last of the three open questions, and the PR's own summary asked it: **should
a broker be able to record a commission agreement for a deactivated agent at
all?** The founder's answer, 2026-09-22, was **no**. So the INSERT policy's
member-EXISTS — the clause about the AGENT an agreement is written FOR, not about
the caller — gained the same `AND m.license_status = 'active'` term the other two
rules carry. It reverses what this migration shipped in the two rounds above.

Both shapes of the loss now refuse, and **they refuse by different mechanisms**,
which is what makes C25's two denial arms independent rather than redundant:

| Subject | What the EXISTS finds | What refuses the write |
|---|---|---|
| **deactivated** | a membership row, at `'suspended'` | the **status term** |
| **removed** | no membership row at all | the **user_id term**, as before |

A mutant can break one and leave the other standing — `m36` does exactly that,
and reds on the first arm only.

**What the ruling costs, written down because it is a real loss taken
knowingly.** An agent deactivated **before any agreement was ever entered** can no
longer have one entered at all. `commission_agreement_in_force` then returns zero
rows for every closing they ever worked — control C12 is that shape — and the
closing cannot be computed. **There is no workaround in the product today.**

An earlier draft of this section, of the migration header and of C25's header all
said *"the route is: reactivate the member, record the agreement, deactivate
again"*, and that is the mitigation the founder was shown when he was first asked.
**That route does not exist.** For the ordinary case — invited through the broker
portal, deactivated through the broker portal, no directory sync and no IdP — the
agreement is simply **unrecordable**, and a route back to `license_status =
'active'` for such a row is **MECHANISM UNTRACED**.

The enumeration, at `074e01cbe`. Three writers set `license_status` to `'active'`
on an **existing** `organization_members` row, and each is gated away from a
portal-deactivated one:

```
git grep -nE "license_status[\"']?[[:space:]]*[:=][[:space:]]*[\"']active[\"']" \
  -- '*.ts' '*.tsx' ':!*__tests__*' ':!*.test.ts' ':!*.test.tsx'     ->  7 hits
```

| writer | why it cannot reach such a row |
|---|---|
| `supabase/functions/directory-sync/index.ts:768` | gated on `existingMember.provisioned_by === 'directory_sync'` (`:764-766`). A portal invite carries `provisioned_by: 'invite'` (`broker-portal/lib/actions/inviteUser.ts:177`), and `deactivateUser.ts:114-120` writes only `license_status` and `updated_at`, so it stays `'invite'` |
| `supabase/functions/scim/handlers/users.ts:650` | a SCIM `PATCH … active:true`; reachable only for an organization provisioned from an IdP, not from any portal action |
| `broker-portal/app/auth/callback/route.ts:126` | the pending-invite acceptance path. Its row is selected with `.is('user_id', null)` (`:91`); a deactivated member has a `user_id`, so this can only take `pending` → `active`, never `suspended` → `active` |

The other four hits — `directory-sync:861`, `:917`, `scim/handlers/users.ts:263`,
`:364` — are INSERTs for members who have no row yet, not reactivations.

**The re-invite side door is closed too, twice.** A broker cannot route around it
by re-inviting the same person: `inviteUser.ts:107-116` refuses on a matching
`invited_email` (the deactivated row keeps its `invited_email`) and `:119-136`
refuses on a matching `user_id`. Either refusal alone would be enough.
`admin_invite_user` (`supabase/migrations/20260412_fix_cross_table_duplicate_invite_check.sql:125-132`)
only INSERTs a fresh `'pending'` row and never updates an existing one, and
`broker-portal/lib/actions/` contains no `reactivateUser.ts` at all.

**And the two-step route is closed, which the grep above would not have shown.**
A writer that reset a suspended row to `'pending'` and nulled its `user_id` would
hand it to `auth/callback:126` legitimately, and it would match neither pattern
in the enumeration. Neither write exists:

```
git grep -nE "license_status[\"']?[[:space:]]*[:=][[:space:]]*[\"']pending[\"']|user_id[\"']?[[:space:]]*:[[:space:]]*null" \
  -- '*.ts' '*.tsx' ':!*__tests__*' ':!*.test.ts' ':!*.test.tsx'
```

One hit — `inviteUser.ts:172`, the INSERT of a brand-new row — and **no writer
anywhere sets `user_id` back to null**. `resendInvite.ts`, the one action that
looks like it might, refuses outright when the row has a `user_id`
(`:61-63`) and its UPDATE writes only `invitation_token` and
`invitation_expires_at` (`:69-76`). `bulkUpdateRole.ts`, `updateUserRole.ts` and
`scim.ts` write neither field.

**Why `MECHANISM UNTRACED` rather than a flat "no route exists".** The
enumeration above is derived by `git grep` over `.ts`/`.tsx`, and a grep finds a
token, not a property — the repo rule *Derive sets by execution, not by grep*
applies. Its positive control is that the same command found all three writers,
so it is not blind to the spelling, and `file` reports all five cited files as
text, so none is being skipped as binary. That is as far as text can take it; a
route reached some other way (a console `UPDATE`, a support script, an admin-portal
path added later) is not excluded, so the mechanism is marked untraced rather
than asserted absent.

**The founder was re-asked on that basis** — knowing the mitigation he was shown
does not exist and the loss is therefore larger than the one he accepted — **and
the ruling stands.** Recorded in `pm_comments` on BACKLOG-3503, with SR's
enumeration in parts `3f345d18` and `0a975373`.

**What it does not touch.** Reading is unchanged: an agent who loses membership
lost the read in the round above (C21/C22), and a deactivated broker or admin
lost both read and write in the round after (C23/C24). Rows already recorded stay
readable to the office's active brokers — this gates the INSERT, and the ledger is
append-only, so nothing already written is withdrawn.

**`m20` was rebased for it.** That mutant re-creates the INSERT policy in order to
plant an unqualified `organization_id`, so a body copied from before this ruling
would drop the status term as a side effect. Measured, both ways: the un-rebased
form reds **c17 c25**, and its c25 red says nothing whatever about the unqualified
column it names. Rebased — the term carried forward, plus a self-check asserting
it is still present — `m20` reds **c17 alone**, exactly as before. Same artifact
class that `m11`, `m16` and `m17` were rebased out of one round earlier.

---

## Mutants — 37, every one reds at least one control

Each prints `MUTATION APPLIED: <catalog evidence>` inside the transaction before
any control runs, after verifying its own effect from the catalog; `run.sh`
refuses a red without that line (`RED WITHOUT PROOF`) and refuses a mutant that
never printed one. 37/37 printed it. Full output in `mutant-run.txt`.

| Mutant | RED |
|---|---|
| `m01` read helpers marked SECURITY DEFINER | c13 c17 c21 c22 c23 |
| `m02` write rule reuses `is_org_admin` | c01 c04 c04b c05 c06 c08 c10 c11 c14 c15 c16 c21 c22 c23 c24 c25 |
| `m03` `set_at DESC` ordered before `seq DESC` | c10 c11 c16 |
| `m04` `effective_from ASC` | c10 c11 c16 |
| `m05` no `effective_from <= p_on_date` filter | c10 c11 c12 c14 c16 |
| `m06` `set_by` inside the INSERT grant | c08 c18 |
| `m07` `set_by` has no default | c04b c08 c15 c24 c25 |
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
| `m19` INSERT policy without the member check | c09 c17 c25 |
| `m20` INSERT policy's unqualified `organization_id` | c17 |
| `m21` UPDATE granted **without** a policy | c05 |
| `m22` DELETE granted **without** a policy | c06 c18 |
| `m23` self-comparison in a *different* policy | c17 |
| **`m24` TRUNCATE granted** | **c18** |
| **`m25` `REVOKE ALL` omitted** (the default ACL grant stands) | **c05 c06 c07 c08 c18** |
| **`m26` RLS not enabled on the agreements table** | **c01 c02 c03 c04 c06 c09 c13 c21 c22 c23 c24 c25** |
| **`m27` RLS not enabled on either table** | **c01 c02 c03 c04 c06 c09 c13 c14 c21 c22 c23 c24 c25** |
| **`m28` `SET search_path` dropped from the DEFINER write rule** | **c17** |
| **`m29` agent FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m30` franchise `set_by` FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m31` org FK written ON DELETE RESTRICT, not NO ACTION** | **c19 c20** |
| **`m32` own-row policy reverted to the bare `auth.uid()` predicate** | **c17 c21 c22** |
| **`m33` active-membership rule drops the `license_status` filter** | **c21** |
| **`m34` active-membership rule drops the organization scope** | **c22** |
| **`m35` the WRITE rule drops the `license_status` filter** | **c23 c24** |
| **`m36` the INSERT policy's SUBJECT clause drops its `license_status` term** | **c25** |
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

**He then ruled the term IN** (2026-09-22; see *The subject too* above), so C25
now asserts that a deactivated subject and a removed subject are both refused and
an active one is not, and `m36` is that term **removed** — the direction the
ruling left open, and the likeliest regression. It reds **c25 and nothing else**,
which is what a control written for a dimension rather than for an answer buys
you: the ruling reversed and the control did not have to be rewritten around a
different set of mutants. The same rule is pinned in CI by the tripwire's
*requires the INSERT policy subject to be an active member, in the same EXISTS*,
because this harness needs a database and CI has none.

**2. The franchise fee's same-day tie (`msr02` → `m37`, control C14).** `m03`
mutates `commission_agreement_in_force` alone, and the fee fixture had no pair
sharing an `effective_from` — so ordering the *other* helper by `set_at` reddened
nothing. The ordering contract is stated for both helpers and was pinned
behaviourally on one. The fixture now carries F2/F3 in the same long-transaction
shape as R2/R3 (later `set_at`, earlier `seq` on the mistake), C14 asserts the
fixture's shape and then that the correction wins, and `m37` reds **c14 and
c16**. The CI tripwire already pinned the ORDER BY *text* on both helpers; what
was missing, and is now present, is the behavioural half.

---

## Text tripwire (CI) — made to fail before being trusted

`npx jest --config broker-portal/jest.config.js broker-portal/__tests__/migrations/commission-agreements-3503.test.ts --bail=0`
→ **18 passed, 18 total.** Each mutation below was applied to the committed
file, proved applied by an exact-string replace that refuses to run unless it
matches exactly once **and prints the file, the line number and the mutated line
back** — a non-empty `git diff --numstat` proves a mutation applied, not that it
applied where it was meant to — then run and restored with `git checkout --`.
The restored run is 18/18 and the tree is clean. The fix was committed **before**
any of these reverts, so no `git checkout --` could discard it.

Rows reading `n/16` and `n/17` were measured in earlier rounds, when the suite
had 16 and 17 tests and the text they anchor on was already in its current form;
they were not re-run. The row reading `n/18` is this round's — the subject-status
ruling — and it was applied and reversed by two exact-string replaces, each
printing the file, the line and the resulting line, with no `git checkout --`
involved at any point.

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
| **the write rule's two terms split into separate `EXISTS`** — role in one, `is_active_commission_member(p_org_id)` beside it | **1/17** | *(same assertion — one membership row must carry both)* |
| split-sum CHECK relaxed to `<= 100` **at the constraint** | 1/16 | carries the split-sum and cadence CHECK constraints |
| cadence CHECK gains a third value | 1/16 | *(same assertion)* |
| member check written as a self-comparison | 1/16 | writes the INSERT policy member check against the NEW ROW, not against itself |
| **`AND m.license_status = 'active'` removed from the INSERT policy's member-EXISTS** | **1/18** | requires the INSERT policy subject to be an active member, in the same EXISTS |
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
commission agreements today. **If a future 3096 run ever seeds one, its cleanup
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
