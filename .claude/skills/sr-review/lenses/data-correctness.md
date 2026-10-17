# Lens 4: Data correctness (idempotency, locking, consistency; includes data distribution)

**Question this lens answers:** if this write runs twice, runs concurrently with another write,
or is read before it has propagated, is the data still right?

## Triggers

DB writes in SQLite or Postgres, upserts, `ON CONFLICT`, `INSERT OR IGNORE`, transactions,
`FOR UPDATE`, advisory locks, migrations that change constraints, cloud sync of any record both
desktop and portal can edit. Also loaded as a partner by lens 3 (retries) and lens 6 (queues).

**PR-SOP §6.2b (ACID) is part of this lens.** Run it in full for any DB write; the checks below
add the concurrency and duplication questions it does not ask.

## Checks

**Idempotency**
- [ ] **What happens on the second delivery?** Name the natural key or idempotency key that makes
      the repeat a no-op, and the unique constraint that enforces it. An application-level
      "check if exists, then insert" is not enforcement.
- [ ] **Is the key stable across retries and devices?** A key generated per attempt
      (`crypto.randomUUID()` inside the retry loop) deduplicates nothing.

**Concurrency**
- [ ] **Can two writers race on this row?** Desktop and portal, two devices, two tabs, a cron and
      a user. If yes, name the strategy:
  - **Optimistic** (version or `updated_at` compare-and-set, reject on mismatch): for
    user-edited records with rare conflicts.
  - **Pessimistic** (`SELECT ... FOR UPDATE`, advisory lock, lease): for counters, balances,
    queues, anything where a lost update costs money.
- [ ] **Read-modify-write in application code** (read row, change in JS, write back) without
      either strategy is a lost-update bug. Flag it.
- [ ] **Locks are held briefly and in a consistent order,** never across a network call.

**Consistency**
- [ ] **Which reads can be stale, and is that acceptable here?** Desktop SQLite is eventually
      consistent with Supabase. Name the user-visible effect of reading before sync completes.
- [ ] **Does the user read their own write?** After an edit, the next screen must show it, even
      if the cloud copy has not caught up.

**Data distribution (folded lens 5)**
- [ ] Keepr has one encrypted SQLite per user and one Supabase Postgres primary. There is no shard
      key, hash ring or read replica. **If a PR introduces any of these** (a read replica, a
      partitioned table, a second region), this lens expands to: shard-key choice and hot keys,
      replication lag and read-your-writes, and rebalancing. Until then, answer "N/A: single
      primary" and move on. Do not invent findings here.

## Required controls

1. **Duplicate delivery:** run the write twice with the same input; assert one row and unchanged
   side effects. Remove the unique constraint or `ON CONFLICT`: red.
2. **Concurrent writers (if a race is possible):** interleave two writers (stale version
   first); assert the second is rejected or serialised. Remove the version check or lock: red.
3. **§6.2b forced crash** for multi-statement writes.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Enforce uniqueness with a database constraint, and let the insert conflict. | Check-then-insert in application code. | *DDIA* ch. 7, "Preventing Lost Updates" |
| Give retried and queued operations a stable idempotency key, stored with a unique index. | Generate a fresh key per attempt. | *Microservices Patterns*, "Idempotent Consumer"; *EIP*, "Idempotent Receiver" |
| Use compare-and-set (`WHERE version = $expected`) for user-edited records; surface the conflict. | Last-write-wins silently on records two people can edit. | *PoEAA*, "Optimistic Offline Lock"; *DDIA* ch. 7 |
| Use `FOR UPDATE` / `SKIP LOCKED` / advisory locks for money, counters and work queues. | Do read-modify-write on a balance in application code. | *PoEAA*, "Pessimistic Offline Lock"; *DDIA* ch. 7 |
| Name the consistency guarantee each read relies on (read-your-writes, monotonic reads). | Assume the cloud copy is current because it usually is. | *DDIA* ch. 5, "Problems with Replication Lag" |
| Keep transactions short; never hold a lock across a network call. | Open a transaction, call Graph, then commit. | *DDIA* ch. 7; PR-SOP §6.2b |

## Keepr reference cases (`develop` @ `9cb79019c`)

- **Good:** SQLite unique indexes on `emails(account_id, external_id)` and
  `messages(user_id, external_id)` make re-synced messages no-ops (`electron/database/schema.sql`).
  `billing_outbox.dedupe_key` is `UNIQUE` and drained with `FOR UPDATE SKIP LOCKED`
  (`supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql:532`, `:581`).
- **Good:** checklist-template saves are optimistic: `p_expected_updated_at` is compared before
  writing (`supabase/migrations/20260924190429_backlog_3474_save_checklist_template.sql`).
- **Gap:** no version / `updated_at` compare-and-set found on other desktop-to-Supabase writes;
  where both sides can edit, last write wins.
