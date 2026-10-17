# Lens 3: Failure handling (timeouts, retries, circuit breakers)

**Question this lens answers:** when the thing on the other end is slow, down, or rate-limiting,
does this code stop, wait sensibly, and recover, or does it hang, hammer, and hide?

## Triggers

Any outbound call: Microsoft Graph, Gmail, Google People, Supabase, Stripe, Resend, `fetch`,
axios, gaxios, `mainNetFetch`, `supabaseNetFetch`; any use of `withRetry`, `retryOnNetwork`,
`withTimeout`; any new provider service.

**Always load lens 4 with this one** if the diff adds a retry around a write.

## Checks

**Timeouts**
- [ ] **Every outbound call has a deadline.** Name it with `file:line`. "The library has a
      default" is not an answer until you have read the default (gaxios has none unless set).
- [ ] **The deadline fits the caller's budget** (lens 1). A 30s timeout inside a 15s IPC budget is
      not a timeout.
- [ ] **Reuse a shared helper.** Seven private `withTimeout` copies exist already; an eighth is a
      finding.

**Retries**
- [ ] **What is retried is safe to retry.** Reads, or writes with an idempotency key / upsert
      (lens 4). Name which.
- [ ] **Only retryable errors are retried:** 429, 5xx, network resets. Not 400, 401, 403, 404.
- [ ] **Backoff is exponential with jitter, and capped,** including when the server sends
      `Retry-After`. Prefer `withRetry` (`electron/utils/apiRateLimit.ts:269`) over a new loop.
- [ ] **Retries do not multiply across layers.** Two nested retry loops of 5 retries each allow
      up to 6 × 6 = 36 attempts per call. Count them.
- [ ] **The retry path has a caller.** A retry queue nobody drains is dead code that reads like
      resilience (PR-SOP §6.2k).

**Circuit breakers**
- [ ] **After repeated failures, does the code stop calling for a while** and say so, or does
      every sync re-run the full failing path?
- [ ] **Is the breaker scoped correctly** (per provider and mailbox, not global), and does it
      half-open to test recovery rather than staying open until restart?

## Required controls

1. **Forced hang:** mock the client to never resolve. The test must finish within the deadline
   and assert the timeout error. Remove the timeout: the test must hang to jest's limit (red).
2. **Forced 429 then success:** assert exactly the expected number of attempts and that the
   delay honoured `Retry-After`. Remove the retry: red.
3. **Forced 400:** assert **one** attempt. A retry policy that retries 400s passes test 2 too.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Put a timeout on every integration point. | Trust the remote side, or the library default, to bound your wait. | *Release It!*, "Timeouts" and "Integration Points" |
| Exponential backoff with **full jitter**, capped. | Fixed-interval retries, or backoff without jitter (synchronised clients retry in waves). | *Builders' Library*, "Exponential Backoff and Jitter" |
| Retry at **one** layer, with a retry budget. | Retry at every layer: attempts multiply and turn a blip into an outage. | *SRE* ch. 22; *Builders' Library*, "Timeouts, retries, and backoff" |
| Make the operation idempotent before making it retryable. | Retry a non-idempotent POST and hope the first one failed. | *Builders' Library*, "Making retries safe with idempotent APIs" |
| Use a circuit breaker to fail fast while a dependency is down, and surface the open state. | Keep calling a failing dependency on every cycle, burning quota and battery. | *Release It!*, "Circuit Breaker" and "Fail Fast" |
| Cap a server-supplied `Retry-After` at a sane maximum and log when you do. | Sleep for whatever the server says, uncapped. | Defensive input handling |
| Distinguish "failed" from "cancelled by the user" from "timed out" in the error type. | Catch all errors into one "sync failed" string. | PR-SOP §2.3 |

## Keepr reference cases (`develop` @ `9cb79019c`)

- **Good:** `withRetry` does capped exponential backoff with 0–25% jitter and honours
  `Retry-After` (`electron/utils/apiRateLimit.ts:161-182`, `:269`). Graph requests carry
  `timeout: 15000` (`outlookFetchService.ts:541`).
- **Gap:** the Gmail client is built with no timeout (`gmailFetchService.ts:309`), so a stuck
  `messages.get` has no deadline.
- **Gap:** a `Retry-After` value is used as the delay without the `maxDelay` cap
  (`apiRateLimit.ts:303-304`).
- **Gap:** `retryOnNetwork` backs off without jitter (`networkResilience.ts:86-87`).
- **Dead code:** `recordPartialSync` is called from `emailSyncService.ts`, but nothing outside
  `networkResilience.ts` calls `setRetryCallback` or `retryPendingSync`, so recorded partial
  syncs are never retried.
- **Nested retries:** `retryOnNetwork` (5 retries by default, `networkResilience.ts:68`) wraps
  the whole Gmail block (`emailSyncService.ts:1646`), whose calls already go through `withRetry`
  (`gmailFetchService.ts:241`, 5 retries by default). A network error retried at both layers can
  re-run the whole block, and its inner retries, up to 6 times.
- **Breaker:** only the shadow delta sync has one, and it stays open until app restart
  (`shadowDeltaSyncService.ts:103`). The main sync has none.
