/**
 * BACKLOG-2856 — cancellation plumbing shared by the provider fetch services.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `emailSyncService.precacheEmails` has held an `AbortController` since the
 * Cancel button shipped, but the signal was consulted only at PHASE boundaries.
 * A single `outlookFetchService.searchAllFolders()` call spans folder discovery,
 * every folder, and every Graph page inside each folder, so an in-flight fetch
 * ran to completion before the loop next looked at the signal. The founder
 * measured 28.3 seconds between clicking Cancel and the cancel taking effect,
 * during which all 487 messages were downloaded AND staged, then discarded.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * The signal reaches the HTTP call itself (so the socket is torn down) and is
 * checked at every loop boundary inside the fetch services. When it fires, the
 * fetch services RETURN WHAT THEY HAVE rather than throwing. That is deliberate:
 *
 *   - `searchAllFolders` wraps each folder in a `try/catch` that logs and
 *     CONTINUES to the next folder. A thrown abort would be swallowed there and
 *     the run would keep going — the exact defect, with extra steps.
 *   - `retryOnNetwork` and `withRetry` would each need to learn a new error
 *     class, and a misclassification would turn a cancel into a retry storm.
 *
 * So `FetchCancelledError` never escapes a fetch service; it is the internal
 * signal a page loop uses to unwind to the nearest accumulator and return.
 *
 * WHY THIS IS KEYED OFF `signal.aborted` AND NEVER OFF THE ERROR SHAPE
 * -------------------------------------------------------------------
 * axios throws `CanceledError` (`code: "ERR_CANCELED"`) and gaxios throws its
 * own shape; both are library-version-dependent, and `ECONNABORTED` — which a
 * plain axios TIMEOUT uses — is in `NETWORK_ERROR_CODES` and would be retried.
 * Asking the signal we ourselves passed is the one classification that cannot
 * drift: if it is aborted, the failure is a cancel, whatever the library called
 * the error.
 */

/**
 * Thrown inside a fetch service when its `AbortSignal` has fired. Callers within
 * the service catch it and return their partial accumulation; it is not part of
 * any service's public contract and must not reach `emailSyncService`.
 */
export class FetchCancelledError extends Error {
  constructor(context: string) {
    super(`Fetch cancelled by the user (${context})`);
    this.name = "FetchCancelledError";
  }
}

export function isFetchCancelledError(error: unknown): boolean {
  return error instanceof FetchCancelledError;
}

/**
 * Throws `FetchCancelledError` if the signal has already fired.
 *
 * Called on both sides of every `await` that can take real time — notably after
 * the API throttler, which can hold a request for hundreds of milliseconds and
 * was therefore a place a cancel could be requested and then ignored.
 */
export function throwIfCancelled(signal: AbortSignal | undefined, context: string): void {
  if (signal?.aborted) {
    throw new FetchCancelledError(context);
  }
}
