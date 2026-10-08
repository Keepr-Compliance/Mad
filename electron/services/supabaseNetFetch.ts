/**
 * Supabase fetch for the main process (BACKLOG-3768).
 *
 * supabase-js in main used Node's fetch (undici), which trusts only Node's
 * bundled CA list. This wrapper sends every Supabase request (auth, token
 * refresh, PostgREST, functions, storage) through Electron's `net.fetch`,
 * which uses Chromium's network stack and the operating system's certificate
 * store and proxy settings. Certificate validation stays ON.
 *
 * Contract:
 *  - Outside Electron (jest): falls back to `globalThis.fetch`. The choice is
 *    keyed on `process.versions.electron`, read per call. Inside Electron a
 *    missing `net.fetch` THROWS; it never falls back to Node's fetch.
 *  - `net.fetch` needs the app to be ready: awaits `app.whenReady()` first.
 *  - `credentials: "omit"` and `cache: "no-store"` are applied LAST, so a
 *    caller cannot override them (no shared cookie jar, no HTTP disk cache).
 *  - The Response is rebuilt as a plain `Response`, so no Electron-internal
 *    own property (which carries raw headers) reaches auth-js error messages.
 *  - A rejected request is logged + reported, then the SAME error object is
 *    rethrown. A non-2xx on the token-refresh path is logged + reported with
 *    its status (no body). Reports are throttled per (auth_step, cause_code).
 *  - Logged / tagged fields: auth_step (from the URL path), cause_code
 *    (allow-listed), tls_intercept, status. Never the URL, query, headers,
 *    body or error message.
 *
 * @module services/supabaseNetFetch
 */

import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { authStepFromUrl, classifyNetError } from "./supabaseNetError";
import { mainNetFetch } from "./mainNetFetch";

/** One report per (auth_step, cause_code) per window, per process. */
export const REPORT_THROTTLE_MS = 10 * 60 * 1000;

interface ThrottleEntry {
  lastReportedAt: number;
  suppressed: number;
}

const throttle = new Map<string, ThrottleEntry>();

/** Test-only: forget throttle state between cases. */
export function __resetSupabaseNetFetchThrottle(): void {
  throttle.clear();
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function report(authStep: string, causeCode: string, tlsIntercept: boolean, status: number): void {
  const key = `${authStep}|${causeCode}`;
  const now = Date.now();
  const entry = throttle.get(key);
  if (entry && now - entry.lastReportedAt < REPORT_THROTTLE_MS) {
    entry.suppressed += 1;
    return;
  }
  const suppressedSinceLast = entry?.suppressed ?? 0;
  throttle.set(key, { lastReportedAt: now, suppressed: 0 });

  const fields = {
    auth_step: authStep,
    cause_code: causeCode,
    tls_intercept: tlsIntercept,
    status,
    suppressed_since_last: suppressedSinceLast,
  };
  void logService
    .warn("[Supabase] Request failed", "SupabaseNetFetch", fields)
    .catch(() => {});
  try {
    Sentry.captureMessage("Supabase request failed", {
      level: "warning",
      tags: {
        auth_step: authStep,
        cause_code: causeCode,
        tls_intercept: String(tlsIntercept),
      },
      extra: { status, suppressed_since_last: suppressedSinceLast },
      fingerprint: ["supabase-net", authStep, causeCode],
    });
  } catch {
    // Reporting must never change the request outcome.
  }
}

/**
 * The `global.fetch` handed to supabase-js `createClient` in main.
 */
export async function supabaseNetFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const authStep = authStepFromUrl(requestUrl(input));
  let res: Response;
  try {
    // Transport, credentials/cache options and the Response rebuild live in
    // mainNetFetch (shared with axios / gaxios, BACKLOG-3799).
    res = await mainNetFetch(input, init);
  } catch (err) {
    try {
      const cls = classifyNetError(err);
      if (!cls.aborted) report(authStep, cls.causeCode, cls.tlsIntercept, 0);
    } catch {
      // Classification must never replace the original error.
    }
    throw err;
  }

  if (!res.ok && authStep === "refresh") {
    report(authStep, `HTTP_${res.status}`, false, res.status);
  }

  return res;
}
