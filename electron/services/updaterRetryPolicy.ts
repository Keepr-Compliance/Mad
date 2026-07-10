/**
 * Updater Retry Policy — pure decision function for auto-update self-recovery.
 * BACKLOG-1905 (SPRINT-167 Auto-Updater Resilience, Phase B)
 *
 * PURE MODULE — no Electron, autoUpdater, Sentry, or logging imports. Given the
 * fingerprint class of a failure (from updateDiagnostics.classifyUpdaterError)
 * plus the attempt counters accumulated so far in THIS check cycle, it returns
 * a single {@link RecoveryDecision}. main.ts (`handleUpdaterError`) executes the
 * decision (flip disableDifferentialDownload, re-call downloadUpdate, schedule a
 * backoff retry, or surface the error to the renderer); this module owns the
 * WHAT/WHEN so it can be unit-tested without the electron-updater runtime.
 *
 * Recovery is keyed on errorType (see the acceptance matrix in BACKLOG-1905):
 *   - checksum_mismatch : force ONE clean full re-download (disable differential)
 *                          before surfacing. electron-updater already retries the
 *                          blockmap→full path internally; this is the *final*
 *                          fallback after that has been exhausted.
 *   - network_timeout   : retry the download up to N=2 more times (3 total) with
 *                          backoff before surfacing.
 *   - everything else   : surface immediately (not retryable).
 */

import type { UpdaterErrorType } from "./updateDiagnostics";

/** Mutable per-check-cycle attempt counters. Reset on `checking-for-update`. */
export interface RetryState {
  /** Whether the checksum full-download fallback has already fired this cycle. */
  checksumFallbackUsed: boolean;
  /** How many network retries have already been attempted this cycle. */
  networkRetryCount: number;
}

/** Fresh counters for a new check cycle. */
export function createRetryState(): RetryState {
  return { checksumFallbackUsed: false, networkRetryCount: 0 };
}

/** The action main.ts should take in response to a failure. */
export type RecoveryAction =
  /** Set disableDifferentialDownload=true and re-call downloadUpdate() once. */
  | "fallback-full"
  /** Wait `backoffMs` then re-call downloadUpdate(). */
  | "retry"
  /** Give up recovering — forward update-error to the renderer (existing path). */
  | "surface";

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Human-readable reason (for logs + Sentry breadcrumbs). */
  reason: string;
  /** Backoff before the retry, in ms. Only meaningful when action === "retry". */
  backoffMs: number;
}

/** Max network retries (N). N=2 → 3 total download attempts. */
export const MAX_NETWORK_RETRIES = 2;

/** Base backoff (ms) for network retries; grows linearly with attempt number. */
export const NETWORK_RETRY_BASE_BACKOFF_MS = 3000;

/**
 * Decide how to recover from an updater failure.
 *
 * Callers pass the classified {@link UpdaterErrorType}, the current
 * {@link RetryState}, and whether a download was actually in flight this cycle.
 * This function is a PURE decision — it does NOT mutate the state. The caller
 * mutates state only when it actually performs the action (so a decision that is
 * inspected but not executed doesn't consume an attempt).
 *
 * @param errorType       Fingerprint class of the failure.
 * @param state           Per-cycle attempt counters accumulated so far.
 * @param downloadStarted Whether a `download-progress` event fired THIS cycle.
 *   BACKLOG-1905 B3: a `network_timeout` raised from `checkForUpdates()` (offline;
 *   `updateInfoAndProvider == null`) must NOT take the download-retry path — a
 *   re-issued `downloadUpdate()` would synchronously reject with
 *   "Please check update first" (AppUpdater.js:437-440), re-enter the handler,
 *   get misclassified as `unknown`, and lose the original offline error. When no
 *   download was in flight, recovery is skipped and the failure surfaces at once.
 */
export function decideRecovery(
  errorType: UpdaterErrorType,
  state: RetryState,
  downloadStarted: boolean,
): RecoveryDecision {
  // B3: recovery re-issues downloadUpdate(), which only makes sense once a
  // download has begun. If the failure came from the CHECK phase (offline — no
  // download-progress this cycle), skip recovery entirely and surface now.
  if (!downloadStarted) {
    return {
      action: "surface",
      reason: `${errorType}: no download in flight this cycle — surfacing (check-phase failure)`,
      backoffMs: 0,
    };
  }

  switch (errorType) {
    case "checksum_mismatch": {
      // One clean full re-download, once per cycle. If the fallback itself fails
      // again, we surface (no infinite loop).
      if (!state.checksumFallbackUsed) {
        return {
          action: "fallback-full",
          reason:
            "checksum_mismatch: forcing one full (non-differential) re-download",
          backoffMs: 0,
        };
      }
      return {
        action: "surface",
        reason: "checksum_mismatch: full re-download already attempted this cycle",
        backoffMs: 0,
      };
    }

    case "network_timeout": {
      if (state.networkRetryCount < MAX_NETWORK_RETRIES) {
        // Linear backoff: attempt 1 → base, attempt 2 → 2×base.
        const attempt = state.networkRetryCount + 1;
        return {
          action: "retry",
          reason: `network_timeout: retry ${attempt}/${MAX_NETWORK_RETRIES}`,
          backoffMs: NETWORK_RETRY_BASE_BACKOFF_MS * attempt,
        };
      }
      return {
        action: "surface",
        reason: `network_timeout: exhausted ${MAX_NETWORK_RETRIES} retries`,
        backoffMs: 0,
      };
    }

    // signature_codesign / disk_space / permission / manifest_parse /
    // feed_not_found / unknown are NOT retryable — go straight to the
    // manual-installer + Report affordance.
    default:
      return {
        action: "surface",
        reason: `${errorType}: not retryable — surfacing immediately`,
        backoffMs: 0,
      };
  }
}

/**
 * Minimal `electron-updater.autoUpdater` surface the recovery executor needs.
 * Declared here (not imported) so this module stays free of the electron-updater
 * runtime and the executor can be unit-tested with a plain mock.
 */
export interface RecoverableUpdater {
  disableDifferentialDownload: boolean;
  downloadUpdate: () => Promise<unknown>;
}

/** Side-effect hooks the caller (main.ts) injects into {@link executeRecovery}. */
export interface RecoveryHooks {
  /** Emit a Sentry breadcrumb / log line for this attempt. */
  onAttempt?: (decision: RecoveryDecision) => void;
  /** Schedule `fn` after `ms` (defaults to setTimeout; overridable in tests). */
  schedule?: (fn: () => void, ms: number) => void;
  /**
   * Called when the (deferred) recovery download rejects or throws. Because the
   * re-download is now scheduled (B1), this fires ASYNCHRONOUSLY. The caller
   * should log (and NOT capture) here — the real autoUpdater "error" re-entry
   * will surface the failure through the tagged/scrubbed `surfaceUpdaterError`.
   */
  onError?: (err: unknown) => void;
}

/**
 * Execute a {@link RecoveryDecision} against the injected updater, MUTATING the
 * retry state to record the consumed attempt. This is the wiring that
 * `handleUpdaterError` runs; extracted here so the checksum full-download
 * fallback and the network retry re-attempt are provable with a mocked updater
 * (acceptance #3 — the dev sim short-circuits to the error handler and cannot
 * prove the real re-download).
 *
 * Both the checksum full-download fallback and the network retry are DEFERRED
 * via `schedule` (B1): a synchronous downloadUpdate() from inside the error
 * dispatch hits electron-updater's `downloadPromise != null` guard and starts
 * nothing. Any rejection of the deferred download is routed to `hooks.onError`
 * (B2) so it never reaches process.on("unhandledRejection") untagged/unscrubbed.
 *
 * @returns true if a recovery action was taken (caller should NOT surface yet);
 *          false if the decision was `surface` (caller surfaces the error).
 */
export function executeRecovery(
  decision: RecoveryDecision,
  state: RetryState,
  updater: RecoverableUpdater,
  hooks: RecoveryHooks = {},
): boolean {
  if (decision.action === "surface") return false;

  hooks.onAttempt?.(decision);

  const schedule = hooks.schedule ?? ((fn, ms) => void setTimeout(fn, ms));

  if (decision.action === "fallback-full") {
    state.checksumFallbackUsed = true;
    // B1: DEFER the re-download. Calling downloadUpdate() synchronously from
    // inside the autoUpdater "error" dispatch is a NO-OP: AppUpdater.js:442-444
    // guards `if (this.downloadPromise != null) return this.downloadPromise;`
    // and downloadPromise is only nulled at :471-473 (a `.finally` that runs
    // AFTER the current error emit). Deferring even one tick lets that `.finally`
    // clear downloadPromise first so the fallback actually starts a fresh
    // download. B2: attach `.catch` so a rejected download is ALWAYS handled and
    // never escapes to process.on("unhandledRejection") (which would capture it
    // WITHOUT the `component: auto-updater` tag and bypass the PII scrub).
    schedule(() => {
      try {
        updater.disableDifferentialDownload = true;
        const p = updater.downloadUpdate();
        if (p && typeof p.then === "function") {
          p.catch((err) => hooks.onError?.(err));
        }
      } catch (err) {
        // Synchronous throw (rare) — same handling as a rejected promise.
        hooks.onError?.(err);
      }
    }, decision.backoffMs);
    return true;
  }

  // action === "retry": bounded network retry with linear backoff.
  state.networkRetryCount += 1;
  schedule(() => {
    try {
      // B2: handle the rejection so a failed retry re-surfaces through the
      // tagged/scrubbed autoUpdater "error" path (via onError) instead of
      // leaking a raw token via the untagged unhandledRejection handler.
      const p = updater.downloadUpdate();
      if (p && typeof p.then === "function") {
        p.catch((err) => hooks.onError?.(err));
      }
    } catch (err) {
      hooks.onError?.(err);
    }
  }, decision.backoffMs);
  return true;
}
