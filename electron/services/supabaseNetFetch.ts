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

import { app, net } from "electron";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { authStepFromUrl, classifyNetError } from "./supabaseNetError";

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

async function transportFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  if (!process.versions.electron) {
    // Not running in Electron (jest): Node's fetch.
    return globalThis.fetch(input, init);
  }
  if (!net || typeof net.fetch !== "function") {
    throw new Error("Electron net.fetch is unavailable in the main process");
  }
  if (!app.isReady()) {
    await app.whenReady();
  }
  return net.fetch(input instanceof URL ? input.href : input, init);
}

/**
 * The `global.fetch` handed to supabase-js `createClient` in main.
 */
export async function supabaseNetFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const authStep = authStepFromUrl(requestUrl(input));
  let raw: Response;
  try {
    raw = await transportFetch(input, { ...init, credentials: "omit", cache: "no-store" });
  } catch (err) {
    try {
      const cls = classifyNetError(err);
      if (!cls.aborted) report(authStep, cls.causeCode, cls.tlsIntercept, 0);
    } catch {
      // Classification must never replace the original error.
    }
    throw err;
  }

  if (!raw.ok && authStep === "refresh") {
    report(authStep, `HTTP_${raw.status}`, false, raw.status);
  }

  return new Response(raw.body, {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
  });
}
