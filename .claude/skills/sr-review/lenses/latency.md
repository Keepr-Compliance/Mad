# Lens 1: Latency (p95 / p99, tail amplification)

**Question this lens answers:** how slow is this path for the unluckiest 1–5% of calls, and does
the change make that worse?

## Triggers

IPC handlers (`electron/handlers/`), sync loops, `Promise.all` fan-out, portal route handlers and
server components, the startup path, anything the user waits on with a spinner.

## Checks

- [ ] **Name the user-visible operation and its budget.** "Opening a transaction's emails tab"
      with a target, not "the query". If there is no budget, say so in the review: that is a
      finding for lens 8, not a pass.
- [ ] **Count the sequential hops.** IPC → service → DB → network → DB. Latencies of sequential
      hops add; p99s of sequential hops add worse than their medians.
- [ ] **Count the fan-out.** A `Promise.all` over N calls is as slow as its slowest call. With
      N = 10 and each call slow 1% of the time, about 10% of batches are slow
      (1 − 0.99¹⁰ ≈ 0.096).
- [ ] **Does any call on the path lack a deadline?** One unbounded call makes the path's p100
      infinite. (Partner: lens 3.)
- [ ] **Is work done on the main process that blocks every other IPC?** Synchronous
      `better-sqlite3` calls are fine when short and harmful when they scan. `mainLagMonitor.ts`
      and `IpcSlowHandler` log stalls; check whether the new path appears there.
- [ ] **Is work done that the user is not waiting for?** Move it after the response, to a worker,
      or behind a cache (lens 7).

## Required control

A measurement, not an opinion: time the path before and after on a realistic corpus (an existing
perf probe in `electron/__tests__/perf/` or `performance-benchmark.test.ts`), report p50 **and**
the max over at least 20 runs. Then **break it**: add an artificial 2s delay to one of the
fanned-out calls and confirm the path's total moves by ~2s. If it does not, the measurement is not
measuring the path.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Report percentiles (p50, p95, p99) and the max. | Report an average. A mean hides the users who are actually waiting. | *DDIA* ch. 1, "Describing Performance"; *SRE* ch. 6 |
| Treat every fan-out as multiplying tail probability; reduce N or bound each call. | Add "just one more" parallel call because each is fast on its own. | *Tail at Scale*; *DDIA* ch. 1, "tail latency amplification" |
| Give each request a deadline and pass the **remaining** budget down to each hop. | Give every hop its own independent 30s timeout so the stack can take 30s × depth. | *SRE* ch. 22, "Addressing Cascading Failures" (deadline propagation) |
| Consider hedged or tied requests for idempotent reads with a long tail. | Hedge non-idempotent writes. | *Tail at Scale* |
| Measure on a realistic corpus (thousands of emails, hundreds of contacts). | Measure on the three-row fixture the unit test uses. | CLAUDE.md, "Transcribe fixtures, never invent them" |

## Keepr reference cases (`develop` @ `9cb79019c`)

- Gmail message details are fetched 10 at a time with `Promise.all`
  (`electron/services/gmailFetchService.ts:444`, `:464`): each batch waits for its slowest
  message.
- No production latency percentiles exist for desktop: Sentry tracing is off
  (`electron/services/syncOutcomeReporter.ts:25`). Duration buckets in sync outcomes are the only
  signal today.
