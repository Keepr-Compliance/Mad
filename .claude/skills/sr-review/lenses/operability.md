# Lens 8: Operability (SLOs, tracing, graceful degradation)

**Question this lens answers:** when this breaks in a customer's app or the portal, will we know,
can we find out why, and does the user still get something useful?

## Triggers

Sentry config (`electron/bootstrap/installSentry.ts`, `src/main.tsx`,
`*-portal/sentry.*.config.ts`), `logService` / `Sentry.capture*` on error paths, health routes,
user-facing error, empty and offline states, feature gates, new background jobs, new
user-facing operations that need a budget (lens 1).

## Checks

**Detect**
- [ ] **Would this failure reach Sentry or `sync_outcomes`,** with enough tags to group it
      (provider, operation, error class)? A `catch` that only logs locally is invisible.
- [ ] **For a new user-facing operation or background job: is there a success criterion
      someone could measure?** A target like "99% of syncs complete within 2 minutes" turns
      "it feels slow" into a number. If none exists, name the one this PR implies.

**Diagnose**
- [ ] **Can one user action be followed across processes?** Renderer → IPC → main → network →
      Supabase. Is there an ID (sync `runId`, request ID) on each log line and Sentry event of
      that path?
- [ ] **Are logs structured** (fields, not interpolated prose) and free of PII? Follow the
      existing redaction in `electron/config/logFileConfig.ts`.

**Degrade**
- [ ] **When a dependency is down, what does the user see?** Cached data with a "last synced"
      notice, a disabled action with a reason, or a blank screen? Name the state.
- [ ] **Does the fallback fail open or closed, and is that the right choice?** Feature gates fail
      open offline (fine for UI, wrong for anything that grants paid or security-relevant access).
- [ ] **Is the degraded path tested?** An untested fallback is a second untested code path.
- [ ] **Health checks check something:** a health route that returns `ok` without touching its
      dependencies says only that the process is alive.

## Required controls

1. **Forced dependency failure:** make the provider or Supabase call throw; assert the user-facing
   state (text or component rendered) and that a Sentry event or `sync_outcomes` row with the
   expected tags was emitted. Remove the capture: red.
2. **Correlation:** for a new cross-process path, assert the same ID appears in the log or event
   at both ends.

## Do / Don't

| Do | Don't | Source |
|---|---|---|
| Define SLOs on what users experience (sync completed, page loaded) and spend the error budget deliberately. | Alert on CPU or on every exception. | *SRE* ch. 4 "Service Level Objectives"; *SRE Workbook* ch. 2 |
| Watch the four golden signals: latency, traffic, errors, saturation. | Monitor only "is it up". | *SRE* ch. 6 |
| Propagate one correlation / trace ID through every hop and put it on every event. | Log disconnected lines that can't be joined. | *Observability Engineering*, ch. 6–7 |
| Emit wide, structured events with high-cardinality fields (user, mailbox, provider, run). | Log interpolated strings and grep for them later. | *Observability Engineering*, ch. 5 |
| Degrade to cached or partial results with an honest notice. | Show a spinner forever, or an empty list that looks like data loss. | *Release It!*, "Steady State" and "Fail Fast"; PR-SOP §2.4 |
| Make health checks exercise the critical dependencies, cheaply. | Return a static `ok`. | *Release It!*, "Health checks" |

## Keepr reference cases (`develop` @ `9cb79019c`)

- **Good:** sync outcomes go to Sentry with duration buckets and to the `sync_outcomes` table; the
  sync `runId` ties a run's log lines together. Offline detection and notice exist
  (`src/contexts/NetworkContext.tsx`, `src/components/common/OfflineNotice.tsx`), and a provider
  failure falls back to cached results with a warning.
- **Gap:** desktop Sentry has no `tracesSampleRate`, so tracing is off
  (`electron/services/syncOutcomeReporter.ts:25-27`). The portals sample traces at 0.1.
- **Gap:** no request or correlation ID in portal routes or edge functions.
- **Gap:** `admin-portal/app/api/health/route.ts` returns a static `ok` with no dependency
  checks.
- **Gap:** no formal SLOs or p95/p99 budgets anywhere in the repo.
