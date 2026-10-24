# Lens 6: Async systems (CDC, outbox, queues, delivery semantics)

**Question this lens answers:** when work leaves the request that created it, is it guaranteed to
happen, exactly as often as it should, and will anyone notice if it does not?

## Triggers

Outbox tables, `*_queue` tables, `synced_at IS NULL` drains, crons (`broker-portal/vercel.json`,
`admin-portal/vercel.json`), Supabase realtime / `postgres_changes`, delta cursors (Graph
`deltaLink`, Gmail `historyId`), background schedulers, webhooks in or out (Stripe, Resend).

**Always load lens 4 with this one.** At-least-once delivery is only correct with an idempotent
consumer.

## Checks

- [ ] **Name the delivery guarantee:** at-most-once, at-least-once, or "effectively once"
      (at-least-once + idempotent consumer). "Exactly once" is not an answer.
- [ ] **Dual write?** If the code writes the DB and then calls a network service (or two
      databases) as separate steps, a crash between them loses one. Use an outbox row written in
      the same transaction as the state change.
- [ ] **Who drains it, how often, and what is the worst-case delay?** Name the cron or loop with
      `file:line`, and the time from enqueue to first attempt and to retry.
- [ ] **What happens after the last attempt?** A dead-letter state that is visible somewhere
      (status column + a query someone runs, an alert, an admin view). A `failed` row nobody
      reads is a silent drop.
- [ ] **Is the consumer safe against two drainers at once?** Lease / `SKIP LOCKED` / claim
      column, or a single-flight guard on desktop.
- [ ] **Ordering:** does the consumer depend on order? If yes, what guarantees it?
- [ ] **CDC / delta cursors:** is the cursor saved only **after** the data it covers is
      committed? What happens on an expired cursor (Graph 410, Gmail 404 on `historyId`): a full
      resync, or silent data loss? Are deletions handled, or knowingly ignored?
- [ ] **Poison messages:** can one bad item block the queue forever?

## Required controls

1. **Crash between state change and side effect:** throw after the DB commit and before the
   network call; assert the outbox row survives and is picked up on the next drain.
2. **Double drain:** run two drainers concurrently; assert each item is processed once.
3. **Max attempts:** fail an item every time; assert it lands in the dead-letter state with its
   last error, and the drain moves on to the next item.
4. **Cursor:** fail the store step after fetching a delta page; assert the cursor did **not**
   advance.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Write the event to an outbox table in the same transaction as the state change; publish from there. | Commit the row, then call the API, and hope nothing crashes in between. | *Microservices Patterns*, "Transactional Outbox"; *DDIA* ch. 11 |
| Design for at-least-once and make the consumer idempotent. | Claim exactly-once delivery from the transport. | *DDIA* ch. 11, "Exactly-once"; *EIP*, "Idempotent Receiver" |
| Route repeatedly failing items to a visible dead-letter state with the error attached. | Retry forever, or drop silently after N attempts. | *EIP*, "Dead Letter Channel" |
| Advance a change-data cursor only after the changes it covers are durably applied. | Save the cursor first "so we don't refetch". | *DDIA* ch. 11, "Change Data Capture" |
| Prefer log-based change capture (delta tokens, `historyId`, realtime) over full re-scans once correctness is proven. | Re-fetch the whole mailbox window every sync forever. | *DDIA* ch. 11 |
| Pick the drain frequency from the delay the user can tolerate. | Run a retry drain daily because the cron slot was free. | *SRE Workbook*, SLO-driven design |

## Keepr reference cases (`develop` @ `9cb79019c`)

- **Good:** `billing_outbox` has a unique `dedupe_key` and a `FOR UPDATE SKIP LOCKED` lease
  (`supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql:523-581`).
- **Good:** `email_delivery_queue` counts attempts and dead-letters at `max_attempts` (default 5)
  as `status = 'failed'`
  (`supabase/migrations/20260717_backlog_2009_email_delivery_queue.sql:40-42`).
- **Gap:** that queue's retry drain (`/api/cron/email-retry`) runs once a day at 04:00 UTC
  (`broker-portal/vercel.json`), so a transient failure waits up to 24 hours.
- **Gap:** Graph per-folder delta exists only in the shadow engine, off by default, and is
  additive-only by design: `@removed` entries are counted and skipped
  (`outlookFetchService.ts:1196`). Gmail has no `historyId` path.
- **Desktop outbox:** audit-log rows with `synced_at IS NULL` are drained to Supabase
  (`electron/services/db/auditLogDbService.ts`, `auditService.ts`). There is no generic local
  pending-change queue or dead-letter table.
