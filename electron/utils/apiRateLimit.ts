/**
 * API Rate Limiting Utilities for External APIs
 *
 * Provides exponential backoff, request throttling, and Retry-After header
 * handling for Microsoft Graph and Gmail API requests.
 *
 * Created as part of BACKLOG-497: Email API Rate Limiting
 *
 * API Limits Reference:
 * - Microsoft Graph (per-app): 10,000 requests / 10 minutes
 * - Gmail (per-user): 250 requests / 100 seconds
 *
 * Usage:
 *   import { withRetry, createApiThrottler } from './apiRateLimit';
 *
 *   // For automatic retry with exponential backoff
 *   const result = await withRetry(() => fetchFromApi());
 *
 *   // For request throttling
 *   const throttler = createApiThrottler(100); // 100ms min delay
 *   await throttler.throttle();
 *   const result = await fetchFromApi();
 */

import logService from "../services/logService";
import { isChromiumNetError } from "./networkErrors";

/**
 * Options for the withRetry function
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Context for logging (e.g., "OutlookFetch", "GmailFetch") */
  context?: string;
}

/**
 * Error type that includes response data for rate limit handling
 */
interface RateLimitError extends Error {
  response?: {
    status?: number;
    headers?: {
      get?: (name: string) => string | null;
      "retry-after"?: string;
    };
  };
  status?: number;
  code?: string | number;
}

/**
 * Parses Retry-After header value
 *
 * The header can be:
 * - A number of seconds (e.g., "120")
 * - An HTTP-date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
 *
 * @param retryAfter - The Retry-After header value
 * @returns Delay in milliseconds, or null if invalid/unparseable
 */
export function parseRetryAfter(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) {
    return null;
  }

  const trimmed = retryAfter.trim();

  // Check if it's a numeric string (including negative numbers)
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (seconds >= 0) {
      return seconds * 1000;
    }
    // Negative numbers are invalid
    return null;
  }

  // Try parsing as an HTTP-date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return null;
}

/**
 * Checks if an error is a rate limit error (HTTP 429)
 *
 * @param error - The error to check
 * @returns true if this is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as RateLimitError;

  // Check various ways the status might be exposed
  if (err.response?.status === 429) {
    return true;
  }
  if (err.status === 429) {
    return true;
  }
  if (err.code === 429 || err.code === "429") {
    return true;
  }

  // Check error message for rate limit indicators
  const message = err.message?.toLowerCase() || "";
  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded")
  );
}

/**
 * Extracts Retry-After value from an error
 *
 * @param error - The error object
 * @returns Retry-After delay in milliseconds, or null
 */
export function extractRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const err = error as RateLimitError;

  // Try response.headers.get() (Fetch API style)
  if (typeof err.response?.headers?.get === "function") {
    const retryAfter = err.response.headers.get("retry-after");
    const parsed = parseRetryAfter(retryAfter);
    if (parsed !== null) {
      return parsed;
    }
  }

  // Try response.headers["retry-after"] (axios style)
  if (err.response?.headers?.["retry-after"]) {
    const parsed = parseRetryAfter(err.response.headers["retry-after"]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

/**
 * Calculates exponential backoff delay with jitter
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds
 * @param maxDelay - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);

  // Add jitter (0-25% of delay) to prevent thundering herd
  const jitter = Math.random() * cappedDelay * 0.25;

  return Math.round(cappedDelay + jitter);
}

/**
 * Determines if an error is retryable
 *
 * Retryable errors include:
 * - Rate limit errors (429)
 * - Server errors (500, 502, 503, 504)
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 *
 * @param error - The error to check
 * @returns true if the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as RateLimitError;

  // Rate limit errors are always retryable
  if (isRateLimitError(error)) {
    return true;
  }

  // Check for server errors (5xx)
  const status = err.response?.status ?? err.status;
  if (status && status >= 500 && status < 600) {
    return true;
  }

  // Check for network errors
  const code = err.code;
  if (typeof code === "string") {
    const networkErrors = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ERR_NETWORK", // axios, transport failure over net.fetch (BACKLOG-3799)
    ];
    if (networkErrors.includes(code)) {
      return true;
    }
  }

  // Chromium net::ERR_* from Electron net.fetch (message or cause chain,
  // incl. gaxios which sets no code). Cert failures will not heal on retry.
  if (isChromiumNetError(error, false)) {
    return true;
  }

  return false;
}

/**
 * Executes a function with automatic retry and exponential backoff
 *
 * Handles rate limit errors (429) by respecting Retry-After headers and
 * using exponential backoff for other transient failures.
 *
 * @param fn - The async function to execute
 * @param options - Retry options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 *
 * @example
 * // Basic usage
 * const result = await withRetry(() => fetchFromApi());
 *
 * @example
 * // With custom options
 * const result = await withRetry(
 *   () => fetchFromApi(),
 *   { maxRetries: 3, baseDelay: 500, context: "OutlookFetch" }
 * );
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    context = "API",
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        break;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        break;
      }

      // Calculate delay
      let delay: number;

      if (isRateLimitError(error)) {
        // For rate limit errors, prefer Retry-After header
        const retryAfter = extractRetryAfter(error);
        if (retryAfter !== null && retryAfter > 0) {
          delay = retryAfter;
          logService.warn(
            `Rate limited. Retry-After: ${Math.ceil(delay / 1000)}s`,
            context
          );
        } else {
          // Fall back to exponential backoff for rate limits
          delay = calculateBackoffDelay(attempt, baseDelay * 2, maxDelay);
          logService.warn(
            `Rate limited. Backing off for ${Math.ceil(delay / 1000)}s`,
            context
          );
        }
      } else {
        // Standard exponential backoff for other errors
        delay = calculateBackoffDelay(attempt, baseDelay, maxDelay);
        logService.debug(
          `Transient error. Retry ${attempt + 1}/${maxRetries} in ${Math.ceil(delay / 1000)}s`,
          context
        );
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Promise-based sleep function
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * API Request Throttler
 *
 * Ensures minimum delay between API requests to avoid rate limiting.
 */
export interface ApiThrottler {
  /**
   * Waits if necessary to maintain minimum delay between requests.
   * Call this before each API request.
   */
  throttle(): Promise<void>;

  /**
   * Resets the throttler state (e.g., when starting a new session).
   */
  reset(): void;

  /**
   * Gets the time until the next request is allowed.
   * @returns Milliseconds until next allowed request, or 0 if allowed now
   */
  getWaitTime(): number;
}

/**
 * Creates an API request throttler with configurable minimum delay
 *
 * @param minDelayMs - Minimum milliseconds between requests (default: 100)
 * @returns ApiThrottler instance
 *
 * @example
 * const throttler = createApiThrottler(100); // 100ms between requests
 *
 * // Before each API call
 * await throttler.throttle();
 * const result = await apiCall();
 */
export function createApiThrottler(minDelayMs: number = 100): ApiThrottler {
  let lastRequestTime = 0;

  return {
    async throttle(): Promise<void> {
      const now = Date.now();
      const elapsed = now - lastRequestTime;

      if (elapsed < minDelayMs) {
        const waitTime = minDelayMs - elapsed;
        await sleep(waitTime);
      }

      lastRequestTime = Date.now();
    },

    reset(): void {
      lastRequestTime = 0;
    },

    getWaitTime(): number {
      const elapsed = Date.now() - lastRequestTime;
      return Math.max(0, minDelayMs - elapsed);
    },
  };
}

/**
 * Pre-configured throttlers for email APIs
 *
 * These enforce minimum delays between requests to stay under rate limits:
 * - Microsoft Graph: 100ms (10 req/sec gives headroom under 10K/10min limit)
 * - Gmail: 100ms (10 req/sec gives headroom under 250/100sec limit)
 */
export const apiThrottlers = {
  /**
   * Microsoft Graph API throttler
   * 100ms minimum delay = 10 requests/second max
   */
  microsoftGraph: createApiThrottler(100),

  /**
   * Gmail API throttler
   * 100ms minimum delay = 10 requests/second max
   */
  gmail: createApiThrottler(100),
} as const;
