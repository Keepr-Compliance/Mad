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
 * Callers pass the classified {@link UpdaterErrorType} and the current
 * {@link RetryState}. This function is a PURE decision — it does NOT mutate the
 * state. The caller mutates state only when it actually performs the action
 * (so a decision that is inspected but not executed doesn't consume an attempt).
 *
 * @param errorType Fingerprint class of the failure.
 * @param state     Per-cycle attempt counters accumulated so far.
 */
export function decideRecovery(
  errorType: UpdaterErrorType,
  state: RetryState,
): RecoveryDecision {
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
  /** Called when kicking off the recovery download throws synchronously. */
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

  if (decision.action === "fallback-full") {
    state.checksumFallbackUsed = true;
    try {
      updater.disableDifferentialDownload = true;
      void updater.downloadUpdate();
    } catch (err) {
      hooks.onError?.(err);
      return false; // couldn't start fallback → let caller surface original error
    }
    return true;
  }

  // action === "retry": bounded network retry with linear backoff.
  state.networkRetryCount += 1;
  const schedule = hooks.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  schedule(() => {
    try {
      void updater.downloadUpdate();
    } catch (err) {
      hooks.onError?.(err);
    }
  }, decision.backoffMs);
  return true;
}
