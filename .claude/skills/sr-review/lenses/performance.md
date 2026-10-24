# Lens 7: Performance (query plans, indexes, read / write amplification)

**Question this lens answers:** how much work does the database do per unit of useful result,
and does it grow with the user's data?

## Triggers

Any SQL: `.sql` migrations, `db.prepare(...)`, Supabase `.from(...)` / `.rpc(...)`, schema and
index changes, RLS policies, loops that call a DB function, renderer lists over large data,
caches (`dedicatedReadCache.ts`, roster caches, feature-gate cache, Next.js `revalidate*`).

## Checks

**Query plans and indexes**
- [ ] **Every new or changed query on a large table has its plan in the PR:** `EXPLAIN QUERY PLAN`
      for SQLite, `EXPLAIN (ANALYZE, BUFFERS)` for Postgres. `SCAN <table>` on a large table is a
      finding unless justified.
- [ ] **The index can be used:** no function wrapped around the indexed column, no leading `%` in
      `LIKE`, composite index column order matches the `WHERE` / `ORDER BY`.
- [ ] **The index is selective:** an index on a boolean or a low-cardinality status column rarely
      helps on its own; consider a partial index (`WHERE synced_at IS NULL`).
- [ ] **RLS:** `auth.uid()` in a policy is wrapped as `(select auth.uid())` so it is evaluated once
      per query, not per row. Policy predicates are indexed.

**Amplification**
- [ ] **Read amplification / N+1:** count queries per batch. A DB call inside a loop or inside
      `Promise.all(items.map(...))` is N queries; fetch the set with one `IN (...)` or join.
- [ ] **Unbounded result sets:** every list query has a `LIMIT` or a proven small bound.
- [ ] **Write amplification:** each new index slows every insert and update on that table. Name
      the write path that pays and confirm the read win is worth it. Large rewrites (updating
      every row to touch one column) belong in a migration, not in the sync loop.

**Caching**
- [ ] **What invalidates this cache, and what does a stale hit show the user?** Name the
      invalidation trigger with `file:line`.
- [ ] **Stampede:** when the entry expires, do N concurrent callers all recompute? Use
      single-flight (one in-flight promise per key).

## Required controls

1. **Plan regression test** for any query the PR adds to a hot path: assert the plan uses the
   intended index (patterns: `electron/services/db/__tests__/threadIdentityQueryPlan-3868.test.ts`,
   `electron/services/__tests__/matchingIndexUsage.test.ts`). Drop the index: red.
2. **Query count:** for a loop fix, assert the number of DB calls for a batch of N is constant,
   not N. Reintroduce the per-item call: red.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Read the execution plan before and after; paste it in the PR. | Add an index because the query "looks slow". | *Use The Index, Luke*, ch. 1–2 |
| Order composite index columns for the equality predicates first, then the range or sort. | Create one index per column and expect the planner to combine them. | *Use The Index, Luke*, "Concatenated Indexes" |
| Keep predicates sargable: compare the bare column. | Wrap the indexed column in `lower()`, `date()` or a cast in the `WHERE`. | *Use The Index, Luke*, "Functions" |
| Batch reads: one query for the set. | Query per item inside a loop (N+1). | *PoEAA*, "Lazy Load" pitfalls |
| Put a `LIMIT` on every list query and page through. | Return every row and filter in JavaScript. | *Release It!*, "Unbounded Result Sets" |
| Count the write cost of every index you add. | Index every column "just in case". | *DDIA* ch. 3; *Use The Index, Luke*, "Insert, Delete and Update" |
| Wrap `auth.uid()` in `(select ...)` inside RLS policies. | Call `auth.uid()` per row in a policy on a large table. | Supabase docs, "RLS performance" / advisor `auth_rls_initplan` |
| Coalesce concurrent cache misses into one computation. | Let every caller recompute on expiry. | Cache-stampede protection (single-flight) |

## Keepr reference cases (`develop` @ `9cb79019c`)

- **Good:** query-plan regression tests exist (`threadIdentityQueryPlan-3868.test.ts`,
  `matchingIndexUsage.test.ts`). SQLite runs WAL with `synchronous = NORMAL`
  (`electron/services/db/core/dbConnection.ts:110`, `:123`).
- **Gap:** `getEmailByExternalId` is called once per fetched email inside the sync loop
  (`electron/services/emailSyncService.ts:1665`, `:1756`).
- **Dead code:** `electron/services/ipcCache.ts` (TTL + prefix invalidation) is imported only by
  its own test.
- **Untriaged:** many migrations call `auth.uid()` unwrapped. Some are inside functions rather
  than policies, so the count is not the finding; run the Supabase performance advisor and act on
  its `auth_rls_initplan` results.
