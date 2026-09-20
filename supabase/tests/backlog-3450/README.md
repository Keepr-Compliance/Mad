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

## Safety

Every script is one transaction ending in `ROLLBACK`. Nothing it inserts
survives, and control 2 restores the function it replaces the same way — DDL is
transactional in Postgres. Run them against production only after reading them.

## Before you run

Each script needs two **internal** user ids. Both must be internal: the RPCs
raise `Access denied: internal role required` before they ever reach the
isolation check, so a non-internal second user would make the control pass for
the wrong reason.

```sql
select user_id from internal_roles order by created_at limit 5;
```

Put the first in `:owner` and a different one in `:other`.

## Running

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner="'<uuid-1>'" -v other="'<uuid-2>'" \
  -f control-1-rpc-isolation.sql
```

Repeat for each script. Every one prints `PASS` lines and raises on failure.

| Script | Proves |
|---|---|
| `control-1-rpc-isolation.sql` | a second internal user's `report_list_saved_views` returns `[]`, and their `report_delete_saved_view` on the owner's row is refused |
| `control-2-mutant-rpc-isolation.sql` | **the mutation.** With the isolation dropped from both RPCs, control 1's assertions fail — so control 1 is not vacuous |
| `control-3-policy-isolation.sql` | defence in depth: a direct `SELECT` as the second user returns no rows |
| `control-4-server-side-limits.sql` | the sixth pin is refused by the database, a `p_id` matching no row raises rather than inserting, and another user cannot update the owner's row |
| `control-5-grants.sql` | `anon` holds no privilege on the table and cannot execute the three functions |
