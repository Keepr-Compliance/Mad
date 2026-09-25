# BACKLOG-3450 — saved-view isolation control (FOUNDER-RUN)

These scripts prove the one security property of `report_saved_views`: **one
internal user cannot read or delete another internal user's saved views**.

## Why this is not run by the engineer

The migration `20260919235452_backlog_3450_report_saved_views.sql` is applied by
the founder, not by the engineer. There is nowhere else to run these:

- A Supabase preview branch cannot replay these migrations from blank
  (recorded on BACKLOG-3364).
- The NAS test stack was unreachable when this PR was built — Tailscale was
  down and the CLI is not installed on the build machine; `nc -z` on the
  recorded ports timed out on both the API and the database. Starting Tailscale
  is a founder decision.

So: **apply the migration, then run these, then the PR may merge.** PM answer
Q3 on BACKLOG-3450 is the ruling that says so.

## Why the control calls the RPCs and does not only query the table

`report_list_saved_views` and `report_delete_saved_view` are `SECURITY DEFINER`.
A `SECURITY DEFINER` function **bypasses RLS entirely**. So a control that only
selects from `report_saved_views` as a second user proves something true about
the policy and nothing at all about the path the running app takes: delete
`WHERE v.user_id = v_caller_id` from the RPC and that control stays green while
every internal user sees every other internal user's saved views.

Control 1 therefore **calls the RPCs**. Control 3 keeps the policy-level check
as defence in depth.

## What has and has not been verified

The migration was not applied when these were written, so **none of them has
been run end to end** — that is the whole reason they are here. What HAS been
checked, against the live database:

- each `DO` block compiles and executes as far as its first reference to
  something the migration creates, so the plpgsql is syntactically valid and
  the two-user lookup works. Control 1 reached its `report_save_view` call,
  control 3 its first `report_saved_views` read, control 4 its first `ASSERT`
  over the table — each failing with "does not exist" and writing nothing.
- control 2's two `CREATE OR REPLACE FUNCTION` bodies are NOT verified. They
  could only be checked by creating them, which is exactly what must not happen
  outside the transaction that rolls them back. They are the migration's own
  bodies with one clause removed from each.

## Safety

Every script is one transaction ending in `ROLLBACK`. Nothing it inserts
survives, and control 2 restores the function it replaces the same way — DDL is
transactional in Postgres. Run them against production only after reading them.

## Before you run

Nothing to fill in. **Each script picks its own two users** from
`internal_roles` — the first two by `(created_at, user_id)` — and refuses to
continue if there is only one, because isolation between two users cannot be
observed with one. Both must be internal: the RPCs raise
`Access denied: internal role required` before they ever reach the isolation
check, so a non-internal second user would make a control pass for the wrong
reason.

There were two internal users when this was written:

```sql
select count(distinct user_id) from internal_roles;   -- 2
```

**Every script that calls `report_save_view` uses its own `report_key`** —
`control-1`, `control-2`, `control-4` — and never `iphone-sync`. The views they
save are pinned, and the server refuses a sixth pin per report key, so on a
database where five cards are already pinned on the real report a script using
that key would abort on the cap before reaching its assertions and read as a
failed control. Isolation is between users and does not depend on the key.
Control 3 seeds its one row with a direct `INSERT`, which no cap applies to.

**Do not pass ids with `-v`.** psql does not substitute a colon-prefixed name
inside a dollar-quoted block, so `:owner` written in a `DO $$ … $$` body reaches
Postgres verbatim and fails to parse. The first version of these scripts did
exactly that and could not have run at all; it was caught by reading, before
they were ever handed over. The BACKLOG-3096 scripts avoid it by hardcoding
their ids inside the block; these avoid it by looking the ids up.

## Running

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-1-rpc-isolation.sql
```

Repeat for each script, in order. Every one prints `PASS` / `MUTANT RED` notices
and raises on failure.

| Script | Proves |
|---|---|
| `control-1-rpc-isolation.sql` | a second internal user's `report_list_saved_views` returns `[]`, and their `report_delete_saved_view` on the owner's row is refused |
| `control-2-mutant-rpc-isolation.sql` | **the mutation.** With the isolation dropped from both RPCs, control 1's assertions fail — so control 1 is not vacuous |
| `control-3-policy-isolation.sql` | defence in depth: the owner's own direct `SELECT` returns their row (asserted, so a policy that denied everyone cannot pass this), and the second user's returns none of it |
| `control-4-server-side-limits.sql` | the sixth pin is refused by the database, a `p_id` matching no row raises rather than inserting, and another user cannot update the owner's row |
| `control-5-grants.sql` | `anon` holds no privilege on the table and cannot execute the three functions |
