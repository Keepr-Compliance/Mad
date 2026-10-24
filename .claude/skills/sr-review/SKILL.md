---
name: sr-review
description: Senior Engineer review lenses. Routes a PR diff to the reliability and performance lenses its paths trigger (latency, load control, failure handling, data correctness, async systems, performance, operability) and defines the checks, required controls and Do/Don't calibration for each.
---

# SR Review Lenses

**Used by:** `senior-engineer-pr-lead` during PR review (PR-SOP Phase 6), and by engineers
self-reviewing before handoff.

**Does not replace** `.claude/docs/PR-SOP.md`. PR-SOP is the core checklist that runs on every PR
(branch, tests, controls, security, message hygiene, reachability). The lenses are the
**topic-specific** checks that run only when the diff touches what they cover.

---

## Why lenses

PR-SOP §5.3 asks for "inefficient database queries" and "inefficient use of APIs". Nobody can
apply that. The cases below were all live in `develop` @ `9cb79019c` and none of them is caught
by a generic bullet; every one is caught by a specific question:

| Live case | The question that catches it | Lens |
|---|---|---|
| Gmail API client built with no timeout (`gmailFetchService.ts:309`) | "Does every outbound call have a deadline?" | 3 |
| `retryPendingSync` / `setRetryCallback` have no caller outside `networkResilience.ts` | "Does the new retry path have a caller?" | 3 |
| Throttler reads `lastRequestTime` before sleeping, so 10 parallel `Promise.all` callers pass together (`apiRateLimit.ts:381`, `gmailFetchService.ts:444`) | "Is the limit enforced under concurrency, or only sequentially?" | 2 |
| Per-email `getEmailByExternalId` inside the sync loop (`emailSyncService.ts:1665`, `:1756`) | "How many queries does one batch issue?" | 7 |
| Email retry queue drained once a day (`broker-portal/vercel.json`, `0 4 * * *`) | "What is the worst-case delay before the next attempt?" | 6 |
| Desktop Sentry has no `tracesSampleRate` (`syncOutcomeReporter.ts:25` says so) | "Can you see this path's latency in production?" | 8 |

---

## Routing: which lenses to load

Load **only** the lenses whose triggers the diff touches (`git diff --name-only <base>...HEAD`
plus a read of the hunks). Most PRs trigger zero to two lenses.

| # | Lens | File | Triggers (paths or content in the diff) |
|---|---|---|---|
| 1 | Latency | `lenses/latency.md` | IPC handlers (`electron/handlers/`), sync loops, `Promise.all` / fan-out, portal route handlers and server components, anything on the startup path |
| 2 | Load control | `lenses/load-control.md` | `apiRateLimit.ts`, batch sizes, worker pools (`electron/workers/`), queues, inbound API routes (`*/app/api/**`), edge functions |
| 3 | Failure handling | `lenses/failure-handling.md` | Any outbound call: Graph, Gmail, Google People, Supabase, Stripe, `fetch`/axios/gaxios, `withRetry`, `retryOnNetwork`, `withTimeout` |
| 4 | Data correctness | `lenses/data-correctness.md` | DB writes (SQLite or Postgres), upserts, `ON CONFLICT`, transactions, locks, migrations, cloud sync of a record both sides can edit |
| 6 | Async systems | `lenses/async-systems.md` | Outboxes, `*_queue` tables, crons (`vercel.json`), realtime subscriptions, delta cursors / `historyId` / `deltaLink`, background schedulers |
| 7 | Performance | `lenses/performance.md` | SQL (any `.sql`, `db.prepare`, `.from(...)`), schema / indexes, RLS policies, loops that touch the DB, renderer lists over large data |
| 8 | Operability | `lenses/operability.md` | Sentry config, `logService` calls on error paths, health routes, user-facing error / offline states, feature gates |

Lens 5 (data distribution: sharding, consistent hashing, replication) is **folded into lens 4**.
Keepr has one encrypted SQLite per user and one Supabase Postgres: there is no shard key, ring or
read replica to review. Lens 4 says when that stops being true.

### Cross-lens pairs: always load both

The worst defects sit between lenses. When one of these triggers, load its partner too.

| If the diff adds... | Also load | Because |
|---|---|---|
| a retry (3) | data correctness (4) | a retried write that is not idempotent duplicates or double-charges |
| a timeout (3) | latency (1) | a timeout longer than the caller's budget is no timeout at all |
| a queue or outbox (6) | data correctness (4) | at-least-once delivery requires an idempotent consumer |
| a concurrency increase (2) | performance (7) | more parallel callers multiply DB and lock pressure |
| a fallback / degraded mode (8) | failure handling (3) | a fallback that is never exercised by a test is a second untested code path |

### High-risk PRs: fan out

For PRs touching the sync engine (`emailSyncService.ts`, `*FetchService.ts`, `*SyncService.ts`),
migrations, or billing: launch one subagent per triggered lens **in parallel**, each given the
diff and its lens file, then do one combined pass yourself over the cross-lens pairs above.
For every other PR, apply the lenses yourself in one pass. Eight subagents on a two-file PR is
eight times the tokens for mostly "N/A".

---

## How to apply a lens

1. **Answer every check with a `file:line`, or "N/A because ___".** A blank is not a pass.
2. **Run the lens's required control,** or state why it cannot apply. The control rules in
   CLAUDE.md apply in full: run the mutation, prove it applied, `Tests: 0 total` is a failure.
3. **Calibrate with the Do/Don't table.** The sources are named so the reviewer can read the
   argument, not just the rule. A Don't that appears in the diff is a finding.
4. **Reachability first** (PR-SOP §6.2l): a resilience finding on a path with no caller is a
   different finding (dead code), not a resilience one.

## Output format

Append to the PR review summary:

```markdown
## Lenses applied
| Lens | Triggered by | Result | Control run |
|------|--------------|--------|-------------|
| 3 Failure handling | `gmailFetchService.ts` | 1 blocker, 1 nit | forced-hang test: red without timeout, green with |
| 4 Data correctness | cross-lens pair with 3 | pass | duplicate-delivery test: red without ON CONFLICT |

Lenses not triggered: 1, 2, 6, 7, 8
```

---

## Sources

The Do/Don't tables paraphrase and cite these. Read the original before arguing with a rule.

| Short name | Work |
|---|---|
| *Release It!* | Michael T. Nygard, *Release It! Design and Deploy Production-Ready Software*, 2nd ed. (2018) |
| *DDIA* | Martin Kleppmann, *Designing Data-Intensive Applications* (2017) |
| *SRE* | Beyer, Jones, Petoff, Murphy (eds.), *Site Reliability Engineering* (Google, 2016) |
| *SRE Workbook* | Beyer et al., *The Site Reliability Workbook* (2018) |
| *Tail at Scale* | Jeffrey Dean and Luiz André Barroso, "The Tail at Scale", *CACM* 56(2), 2013 |
| *Builders' Library* | Marc Brooker, "Timeouts, retries, and backoff with jitter", Amazon Builders' Library; and "Exponential Backoff and Jitter", AWS Architecture Blog (2015) |
| *Use The Index, Luke* | Markus Winand, *SQL Performance Explained* (2012) / use-the-index-luke.com |
| *Microservices Patterns* | Chris Richardson, *Microservices Patterns* (2018) |
| *EIP* | Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns* (2003) |
| *PoEAA* | Martin Fowler, *Patterns of Enterprise Application Architecture* (2002) |
| *Observability Engineering* | Charity Majors, Liz Fong-Jones, George Miranda, *Observability Engineering* (2022) |
