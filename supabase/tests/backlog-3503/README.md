# BACKLOG-3503 harness — commission agreements, migration 1

Executes `supabase/migrations/20260922220719_backlog_3503_commission_agreements.sql`
— **the shipped file itself, not a copy** — on a real Postgres 17.6, and records
what every control and every mutant did.

**It has been run.** 2026-09-22, on the NAS Supabase test stack, container
`supabase_db_keepr-test`. **21 controls, 120 assertions, all green; 31 mutants
× 21 controls = 651 runs.** Every mutant reddens at least one control and every
control is reddened by at least one mutant. Every result below was measured;
none was predicted. `control-run.txt` and `mutant-run.txt` in this directory are
the runs' own output, unedited.

It is not in CI: CI has no database. The text-level tripwire that does run in CI
is `broker-portal/__tests__/migrations/commission-agreements-3503.test.ts`, and
its table is at the bottom of this file.

**Nothing has been applied to production, and nothing here can reach it.**

---

## The transport, stated plainly

`supabase/tests/backlog-3364/run.sh` and `backlog-3096/`'s scripts take a
`postgresql://…` URL and run `psql` here, as a client. **That does not work from
this Mac.** The NAS tailnet address does not answer it: `ping` reports 100%
packet loss and port 54322 is unreachable. The host is alive over SSH and the
database is healthy inside its container; only the direct client path is closed.

So `run.sh` pipes SQL *to* psql running **on the venue, inside the container**:

```bash
ssh -o BatchMode=yes ugreen \
  "docker exec -i supabase_db_keepr-test psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"
```

Four consequences, all handled in `run.sh` and all worth knowing before editing it:

1. **`\i <path>` cannot be used.** A path would resolve *inside the container*,
   where this repository does not exist. Every file — the migration, the mutant,
   the fixtures, the control — is concatenated **on the client** into one stream.
2. **The URL host gate has nothing to check.** 3364's runner refuses any host
   that is not loopback or a Tailscale address; there is no host here. It is
   replaced by a **literal container name** plus a **refusal unless
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
bash $H controls   # 21 controls, each in its own rolled-back transaction
bash $H mutants    # 31 mutants x 21 controls
bash $H mutants m24   # one mutant, by name fragment
```

`SSH_HOST` defaults to `ugreen`. A full `mutants` run took **131 s**; `controls`
takes about 4 s. An *implausibly fast* green is a broken harness — if `controls`
returns instantly with no assertion counts, the stream never reached psql.

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

## Controls — all 21 GREEN, 120 assertions

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
| `c14` | the franchise fee is effective-dated the same way, and an agent cannot read it in M1 | 3 |
| `c15` | the constraints that encode the fee model: the split sums to 100, cadence is constrained, no fee is negative | 5 |
| `c16` | the founder's worked example, computed from what the helpers return | 7 |
| `c17` | catalog: the write rule is DEFINER with `SET search_path = public`; neither read helper is DEFINER; the member check names the NEW ROW's org; **and a sweep of every policy for a self-comparison** | 11 |
| `c18` | **privilege level**: UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER absent for `anon` and `authenticated` on both tables; `set_by` and `set_at` not INSERT-grantable; plus the behavioural half — the weakest signed-in role's TRUNCATE is refused and all nine rows survive | 34 |
| `c19` | a user holding agreements cannot be deleted, **asserted by constraint name**, with memberships cleared first; the same for the organization; the broker who *set* the rows is held too; and a user holding nothing IS deletable | 7 |
| `c20` | catalog: all five foreign keys exist and every one is ON DELETE NO ACTION | 6 |

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

## Mutants — 31, every one reds at least one control

Each prints `MUTATION APPLIED: <catalog evidence>` inside the transaction before
any control runs, after verifying its own effect from the catalog; `run.sh`
refuses a red without that line (`RED WITHOUT PROOF`) and refuses a mutant that
never printed one. 31/31 printed it. Full output in `mutant-run.txt`.

| Mutant | RED |
|---|---|
| `m01` read helpers marked SECURITY DEFINER | c13 c17 |
| `m02` write rule reuses `is_org_admin` | c01 c04 c04b c05 c06 c08 c10 c11 c14 c15 c16 |
| `m03` `set_at DESC` ordered before `seq DESC` | c10 c11 c16 |
| `m04` `effective_from ASC` | c10 c11 c16 |
| `m05` no `effective_from <= p_on_date` filter | c10 c11 c12 c14 c16 |
| `m06` `set_by` inside the INSERT grant | c08 c18 |
| `m07` `set_by` has no default | c04b c08 c15 |
| `m08` UPDATE granted, with a policy | c05 |
| `m09` DELETE granted, with a policy | c06 c18 |
| `m10` anon can read | c07 c18 |
| `m11` write rule ignores the org | c01 c06 c09 c13 |
| `m12` writer SELECT policy `USING (true)` | c01 c02 c04 c06 c13 c14 |
| `m13` agreements readable org-wide | c02 c04 c13 |
| `m14` helper ignores the agent | c10 c12 c13 |
| `m15` no split-sum CHECK | c15 |
| `m16` `it_admin` added to the writer list | c04 |
| `m17` `agent` added to the writer list | c02 c03 c13 c14 |
| `m18` franchise fee readable org-wide | c04 c14 |
| `m19` INSERT policy without the member check | c09 c17 |
| `m20` INSERT policy's unqualified `organization_id` | c17 |
| `m21` UPDATE granted **without** a policy | c05 |
| `m22` DELETE granted **without** a policy | c06 c18 |
| `m23` self-comparison in a *different* policy | c17 |
| **`m24` TRUNCATE granted** | **c18** |
| **`m25` `REVOKE ALL` omitted** (the default ACL grant stands) | **c05 c06 c07 c08 c18** |
| **`m26` RLS not enabled on the agreements table** | **c01 c02 c03 c04 c06 c09 c13** |
| **`m27` RLS not enabled on either table** | **c01 c02 c03 c04 c06 c09 c13 c14** |
| **`m28` `SET search_path` dropped from the DEFINER write rule** | **c17** |
| **`m29` agent FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m30` franchise `set_by` FK rewritten ON DELETE CASCADE** | **c19 c20** |
| **`m31` org FK written ON DELETE RESTRICT, not NO ACTION** | **c19 c20** |

`m21`/`m22` and `m25` are the reason C05 and C06 assert a **specific** SQLSTATE.
A grant without a policy makes the write a silent zero-row no-op, and every one
of `m25`'s four reds reads `got OK` — "it raised something" would have passed
all four. **Do not let a later round relax those assertions.**

`m25` and `m26`/`m27` are the two likeliest wrong implementations of this
migration, because they are *omissions* rather than wrong choices.

---

## Text tripwire (CI) — made to fail before being trusted

`npx jest --config broker-portal/jest.config.js broker-portal/__tests__/migrations/commission-agreements-3503.test.ts --bail=0`
→ **14 passed, 14 total.** Each mutation below was applied to the committed
file, proved applied by a non-empty `git diff --numstat`, run, then restored
with `git checkout --`; the restored run is 14/14 and the tree is clean.

| Mutation | Tests | RED `it()` |
|---|---|---|
| franchise table's `ENABLE ROW LEVEL SECURITY` line deleted | 1/14 | enables row level security on both tables |
| `REVOKE ALL` narrowed to `REVOKE INSERT, UPDATE, DELETE` | 1/14 | revokes ALL from anon and authenticated on both tables |
| `GRANT UPDATE (agent_pct)` added | 1/14 | grants no UPDATE and no DELETE on either table |
| `set_by` added to the agreements INSERT column list | 1/14 | keeps set_by and set_at out of both INSERT column lists |
| `set_by` loses its `auth.uid()` default | 1/14 | gives set_by a NOT NULL default of auth.uid() on both tables |
| `set_at DESC` put back into the helper's ORDER BY | 1/14 | orders the read helpers by seq DESC, and never by set_at |
| `SET search_path` dropped from the write rule | 1/14 | marks the write rule SECURITY DEFINER with a pinned search_path, and neither read helper |
| a read helper marked SECURITY DEFINER | 1/14 | *(same assertion)* |
| `it_admin` added to the writer role list | 1/14 | names exactly broker and admin as writers, and never reaches for is_org_admin |
| the write rule delegates to `is_org_admin` | 1/14 | *(same assertion)* |
| split-sum CHECK relaxed to `<= 100` **at the constraint** | 1/14 | carries the split-sum and cadence CHECK constraints |
| cadence CHECK gains a third value | 1/14 | *(same assertion)* |
| member check written as a self-comparison | 1/14 | writes the INSERT policy member check against the NEW ROW, not against itself |
| the `NOT APPLIED TO PRODUCTION` sentence removed | 1/14 | says in its header that it is not applied to production by this PR |
| the migration opens its own transaction | 1/14 | opens no transaction of its own |
| the franchise table renamed | 2/14 | creates both tables; gives set_by a NOT NULL default … |
| `run.sh` pointed at a different migration stamp | 1/14 | the file is not empty and the harness reads the same file CI does |

**One false green, and what it was.** The split-sum mutation was first written as
a replacement of the *first* occurrence of `CHECK (agent_pct + brokerage_pct =
100)` in the file. There are **two**: the header discusses it in prose before the
constraint declares it. The first run therefore edited a comment, the suite
stayed green — and that green would have been recorded as "the assertion is
vacuous". It is not: re-anchored on the constraint, it reds. A non-empty
`numstat` proves a mutation applied; it does **not** prove it applied where you
meant.

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

## Fixture identifiers are invented

UUIDs sit in the `00000000-0000-4000-8000-00003503xxxx` block, each carrying a
`pii-allow-uuid` waiver; emails use the reserved `.example.test` domain; slugs
carry a `fixture-3503` prefix. No customer, address or real organisation name
appears anywhere in this directory. The venue held **zero** real rows when every
result above was measured.
