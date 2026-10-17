# Lens 2: Load control (backpressure, rate limiting, bulkheads)

**Question this lens answers:** when more work arrives than this path can do, what happens, and
who gets hurt?

## Triggers

`electron/utils/apiRateLimit.ts`, batch sizes, worker pools (`electron/workers/`), in-memory
queues, `Promise.all` over unbounded input, inbound API routes (`broker-portal/app/api/**`,
`admin-portal/app/api/**`), Supabase edge functions.

## Checks

- [ ] **Is every queue and every in-flight set bounded?** Name the bound. An array that grows
      with mailbox size is unbounded.
- [ ] **Is the limit enforced under concurrency?** A throttle that reads a timestamp, sleeps, then
      writes it lets every concurrent caller through together. Check with N parallel callers, not
      a sequential loop.
- [ ] **Outbound: does the client honour the provider's 429 and `Retry-After`,** and does it slow
      down rather than just retry at the same rate?
- [ ] **Inbound: can one caller exhaust this route** for everyone? Name the limiter, its key
      (user, org, IP) and whether it survives across serverless instances. An in-memory limiter
      is per instance (the edge-function limiter's own header says it is best effort).
- [ ] **Bulkheads: can one slow mailbox, provider or tenant stall the others?** Name what isolates
      them (separate worker, separate queue, separate concurrency budget), or say nothing does.
- [ ] **When the limit is hit, is the outcome explicit?** Reject with a clear error, defer, or
      drop with a count: never an unbounded wait.

## Required control

Fire N concurrent callers (N ≥ 2 × the limit) at the limiter in a test and assert the observed
spacing or concurrency. Then **break it**: remove the serialisation (or raise the limit to
infinity) and confirm the test goes red. A limiter test that only calls sequentially cannot
distinguish a working limiter from a broken one.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Bound every queue; decide up front what happens when it is full. | Use an unbounded in-memory array as a queue "because volume is low". | *Release It!*, "Create Back Pressure" |
| Shed or defer load early, at the edge, with a clear signal. | Accept every request and let it time out deep in the stack. | *Release It!*, "Shed Load"; *SRE* ch. 21, "Handling Overload" |
| Partition resources so one failing dependency or tenant can only take its own partition down. | Run every provider and mailbox through one shared pool. | *Release It!*, "Bulkheads" |
| Size concurrency from throughput × latency (Little's Law) and measure it. | Pick `batchSize = 10` because it looked fine locally. | Little's Law; *SRE* ch. 21 |
| Serialise the limiter's critical section (a promise chain or a token bucket). | Read-then-sleep-then-write a shared timestamp from concurrent callers. | Classic check-then-act race |
| Key inbound limits on the identity that matters (user / org), backed by shared state on serverless. | Rely on a per-instance in-memory map on Vercel or edge functions for anything security-relevant. | `supabase/functions/_shared/rateLimiter.ts` header |

## Keepr reference cases (`develop` @ `9cb79019c`)

- `createThrottler` (`electron/utils/apiRateLimit.ts:381`) reads `lastRequestTime`, sleeps, then
  sets it. The 10 parallel `messages.get` calls in a Gmail batch
  (`gmailFetchService.ts:444`) all observe the same value, so the 100ms spacing is not enforced
  inside a batch.
- No p-limit / p-queue in the repo; concurrency is fixed per call site (Gmail 10, Graph `$batch`
  20 at `outlookFetchService.ts:1322`).
- Email sync runs Gmail and Outlook as sequential blocks on the main process: no per-provider
  bulkhead.
- Inbound: broker-portal's limiter (`broker-portal/lib/rate-limiter.ts`) guards only
  `auth/impersonate`; no limiter found on admin-portal routes.
