/**
 * Network Error Detection Utilities (TASK-2049)
 *
 * Provides shared network error classification for email sync resilience.
 * Used by networkResilience service and email sync handlers to detect
 * network disconnections vs application errors.
 */

/**
 * Error code strings that indicate a network connectivity issue.
 * These are Node.js system error codes and common browser/fetch error patterns.
 */
const NETWORK_ERROR_CODES: ReadonlyArray<string> = [
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  // axios code for a transport failure with no response (BACKLOG-3799)
  "ERR_NETWORK",
];

/**
 * Error message substrings that indicate a network connectivity issue.
 * Case-insensitive matching is used.
 */
const NETWORK_ERROR_MESSAGES: ReadonlyArray<string> = [
  "fetch failed",
  "network error",
  "err_internet_disconnected",
  "network request failed",
  "socket hang up",
  "getaddrinfo",
  "dns lookup failed",
  "unable to connect",
  "connection timed out",
  "network is unreachable",
];

/** Chromium network-stack failures surface as "net::ERR_*" (BACKLOG-3799). */
const CHROMIUM_NET_ERROR = /net::err_[a-z0-9_]+/i;
const MAX_CAUSE_DEPTH = 4;

/**
 * True when the error, or anything on its `cause` chain, is a Chromium
 * `net::ERR_*` transport failure (what Electron `net.fetch` rejects with,
 * wrapped by axios / gaxios). `net::ERR_ABORTED` is a cancellation, not a
 * network failure, and is excluded. Certificate failures (`net::ERR_CERT_*`)
 * are included only when `includeCert` is set: they classify as network for
 * the UI but will not heal on retry.
 */
export function isChromiumNetError(
  error: unknown,
  includeCert = true,
): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth <= MAX_CAUSE_DEPTH; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") {
      const match = message.match(CHROMIUM_NET_ERROR);
      if (match) {
        const name = match[0].toLowerCase();
        if (name !== "net::err_aborted" && (includeCert || !name.startsWith("net::err_cert_"))) {
          return true;
        }
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Determines if an error is caused by a network connectivity issue.
 *
 * Checks error code, error message, and axios response properties to
 * classify the error. Returns false for application-level errors (4xx
 * status codes, auth errors, etc.) which should not trigger retry.
 *
 * @param error - The error to classify
 * @returns true if the error is a network connectivity issue
 *
 * @example
 * ```typescript
 * try {
 *   await fetchEmails();
 * } catch (error) {
 *   if (isNetworkError(error)) {
 *     // Save partial progress and schedule retry
 *   } else {
 *     // Application error, throw normally
 *     throw error;
 *   }
 * }
 * ```
 */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;

  if (isChromiumNetError(error)) return true;

  // Check error code (Node.js system errors)
  const errorCode = (error as { code?: string }).code;
  if (typeof errorCode === "string" && NETWORK_ERROR_CODES.includes(errorCode)) {
    return true;
  }

  // Check error message
  const errorMessage =
    error instanceof Error
      ? error.message
      : (error as { message?: string }).message ?? "";
  if (errorMessage) {
    const lowerMessage = errorMessage.toLowerCase();
    if (NETWORK_ERROR_MESSAGES.some((pattern) => lowerMessage.includes(pattern))) {
      return true;
    }
  }

  // Check for axios/fetch errors without HTTP response (network layer failure)
  const axiosError = error as {
    response?: { status?: number };
    request?: unknown;
    isAxiosError?: boolean;
  };
  if (axiosError.isAxiosError && !axiosError.response && axiosError.request) {
    // Axios error with request but no response = network failure
    return true;
  }

  return false;
}
