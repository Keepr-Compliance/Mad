/**
 * Retry classification + exponential-backoff helpers for transactional email.
 *
 * BACKLOG-2009: Transactional email hardening (retry/queue + delivery visibility).
 *
 * The M365 Graph send path splits failures into two buckets:
 *
 *   TRANSIENT — HTTP 429 (throttled), 408 (timeout), any 5xx, or a network /
 *               timeout error with no HTTP status. These are worth retrying:
 *               in-request first (small backoff) and then, if still failing, via
 *               the durable queue drained by /api/cron/email-retry.
 *
 *   PERMANENT — everything else (4xx auth/validation, malformed recipient, etc.).
 *               A retry cannot help, so we do NOT retry and do NOT enqueue.
 *
 * "skipped" (missing Azure creds / EMAIL_SENDER_ADDRESS) is handled upstream in
 * sendEmail() and is likewise never retried.
 */

/** Small default backoff schedule (ms) for in-request retries. */
export const IN_REQUEST_BACKOFF_MS = [200, 400] as const;

/**
 * Best-effort extraction of an HTTP status code from a Graph SDK / fetch error.
 * The Microsoft Graph client surfaces the status as `statusCode`; other layers
 * may use `status` or `code`. Returns null when no numeric status is present.
 */
export function getErrorStatus(err: unknown): number | null {
  if (err === null || err === undefined || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const candidate = e.statusCode ?? e.status ?? e.code;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
    return parseInt(candidate, 10);
  }
  return null;
}

/**
 * Classify a send error as transient (retryable) or permanent.
 *
 * Transient:
 *   - HTTP 408, 429, or any 5xx
 *   - No HTTP status at all (network drop / timeout / DNS) — treated as transient
 *     because these are exactly the blips a retry recovers from.
 * Permanent:
 *   - Any other HTTP status (notably 4xx auth/validation).
 */
export function isTransientError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === null) {
    // No HTTP status -> network/timeout style failure -> retry.
    return true;
  }
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Exponential backoff with a cap. attempt is 0-based (0 = first retry delay).
 * base=1000, factor=2 -> 1s, 2s, 4s, 8s ... capped at maxMs.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; factor?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 2;
  const maxMs = opts.maxMs ?? 60 * 60 * 1000; // 1h cap
  const delay = baseMs * Math.pow(factor, Math.max(0, attempt));
  return Math.min(delay, maxMs);
}

/** Promise-based sleep. Exposed so tests can mock it. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
