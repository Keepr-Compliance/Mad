/**
 * BACKLOG-3768: auth-js error objects TRANSCRIBED from a real supabase-js
 * client, never hand-built.
 *
 * Each helper runs the real `createClient` (supabase-js 2.110.2) with an
 * injected fetch that reproduces a measured transport shape, and returns the
 * `error` the SDK itself produces. Shapes measured (Step 0 a745f5f6, SR
 * f3d7522a, engineer probe scratchpad 3768-eng/p1.js):
 *
 *   Electron net.fetch, untrusted cert  -> rejects `Error("net::ERR_CERT_AUTHORITY_INVALID")`
 *     -> setSession returns AuthRetryableFetchError, status 0, same message
 *   503 from the edge                   -> AuthRetryableFetchError, status 503, message "{}"
 *   401 bad_jwt                         -> AuthApiError 401, code bad_jwt
 *   400 refresh_token_not_found         -> AuthApiError 400 (expired access token -> refresh)
 *   getUser() after a failed setSession -> AuthSessionMissingError 400 (NOT retryable)
 *
 * The injected fetch never opens a socket, so the BACKLOG-3284 net guard is
 * not involved.
 */

import type { AuthError } from "@supabase/supabase-js";

// Real module, even in suites that jest.mock("@supabase/supabase-js").
const { createClient } = jest.requireActual<typeof import("@supabase/supabase-js")>(
  "@supabase/supabase-js",
);

type FetchFn = typeof fetch;

/**
 * CI runs jest on Node 20, which has no global WebSocket; realtime-js throws in
 * createClient without one. Realtime is never connected in these tests.
 */
class NoRealtimeWebSocket {
  constructor() {
    throw new Error("realtime is not used in this test");
  }
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}

function fakeJwt(expOffsetSec: number): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b({ sub: "u", exp: Math.floor(Date.now() / 1000) + expOffsetSec })}.sig`;
}

function client(fetchImpl: FetchFn) {
  return createClient("https://fixture.supabase.co", "anon", {
    auth: { persistSession: false, autoRefreshToken: false, storage: memoryStorage() },
    global: { fetch: fetchImpl },
    realtime: { transport: NoRealtimeWebSocket as unknown as typeof WebSocket },
  });
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  // auth-js console.error()s every transport failure (lib/fetch.js).
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

async function setSessionError(fetchImpl: FetchFn, expOffsetSec = 3600): Promise<AuthError> {
  return quietly(async () => {
    const { error } = await client(fetchImpl).auth.setSession({
      access_token: fakeJwt(expOffsetSec),
      refresh_token: "r",
    });
    if (!error) throw new Error("fixture: expected setSession to fail");
    return error;
  });
}

const jsonResponse = (status: number, body: object) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Transport failure (untrusted cert) as Electron net.fetch reports it. */
export function retryableCertError(): Promise<AuthError> {
  return setSessionError(async () => {
    throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
  });
}

/** Transport failure (DNS) as Electron net.fetch reports it. */
export function retryableDnsError(): Promise<AuthError> {
  return setSessionError(async () => {
    throw new Error("net::ERR_NAME_NOT_RESOLVED");
  });
}

/** 503 from the edge: retryable WITH a status (missed by a `status === 0` check). */
export function retryable503Error(): Promise<AuthError> {
  return setSessionError(async () => new Response('{"msg":"x"}', { status: 503 }));
}

/** Genuine rejection: 401 bad_jwt. */
export function apiError401(): Promise<AuthError> {
  return setSessionError(jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }));
}

/** Genuine rejection on refresh: 400 refresh_token_not_found (expired access token). */
export function apiError400Refresh(): Promise<AuthError> {
  return setSessionError(
    jsonResponse(400, {
      code: 400,
      error_code: "refresh_token_not_found",
      msg: "Invalid Refresh Token: Refresh Token Not Found",
    }),
    -60,
  );
}

/** What getUser() returns on the same client after setSession failed on the network. */
export function sessionMissingAfterFailedRestore(): Promise<AuthError> {
  return quietly(async () => {
    const c = client(async () => {
      throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
    });
    await c.auth.setSession({ access_token: fakeJwt(3600), refresh_token: "r" });
    const { error } = await c.auth.getUser();
    if (!error) throw new Error("fixture: expected getUser to fail");
    return error;
  });
}
