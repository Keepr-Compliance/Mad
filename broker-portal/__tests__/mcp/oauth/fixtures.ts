/**
 * Shared fixtures for the OAuth server tests (BACKLOG-4238).
 *
 * Database envelopes are transcribed from
 * supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql
 * (mcp_register_client success at :470-471; refusal shape from _mcp_refuse).
 * The transport error is transcribed from the installed @supabase/postgrest-js
 * 2.110.2 fetch-error branch (dist/index.cjs, the `res.catch` that returns
 * {error: {message, details, hint, code}, data: null, status: 0}), with
 * planted text.
 */

export const ORIGIN = 'https://portal.test';

/** 32 bytes 0x00..0x1f, base64url. */
export const PEPPER_B64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const PEPPER_BYTES = Buffer.from([...Array(32).keys()]);

export const PORTAL_SECRET = 'portal-secret-fixture';

export const OAUTH_ENV = {
  MCP_ENABLED: 'true',
  MCP_PUBLIC_ORIGIN: ORIGIN,
  MCP_TOKEN_PEPPER: PEPPER_B64URL,
  MCP_PORTAL_SECRET: PORTAL_SECRET,
  NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture',
};

/** kpr_-shaped planted credential (43 characters after the prefix). */
export const PLANTED_KPR = `kpr_rt_${'P'.repeat(43)}`;
/** Plain planted value, not kpr_-shaped, so redaction cannot hide it. */
export const PLANTED_PLAIN = 'planted-plain-value-0042';

export const REDIRECT_URI = 'https://client.example/callback';

/** mcp_register_client success, :470-471. */
export function registerOk(clientId: string, clientName: string, redirectUris: string[]) {
  return { ok: true, client_id: clientId, client_name: clientName, redirect_uris: redirectUris };
}

/** _mcp_refuse(code). */
export function refusal(code: string) {
  return { ok: false, error: code };
}

/** postgrest-js 2.110.2 fetch failure, returned (not thrown). */
export function postgrestFetchError(planted: string) {
  return {
    success: false,
    error: { message: `TypeError: fetch failed ${planted}`, details: `TypeError: fetch failed ${planted}`, hint: '', code: '' },
    data: null,
    count: null,
    status: 0,
    statusText: '',
  };
}

/**
 * postgrest-js 2.110.2 with an AbortSignal.timeout() signal: Node 22 rejects
 * with name 'TimeoutError' (measured), which takes postgrest-js's generic
 * branch (empty hint), not its AbortError branch.
 */
export function postgrestTimeoutError(planted: string) {
  return {
    success: false,
    error: { message: `TimeoutError: The operation was aborted due to timeout ${planted}`, details: '', hint: '', code: '' },
    data: null,
    count: null,
    status: 0,
    statusText: '',
  };
}

/** postgrest-js 2.110.2 AbortError branch (a caller-aborted signal). */
export function postgrestAbortError(planted: string) {
  return {
    success: false,
    error: {
      message: `AbortError: This operation was aborted ${planted}`,
      details: '',
      hint: 'Request was aborted (timeout or manual cancellation)',
      code: '',
    },
    data: null,
    count: null,
    status: 0,
    statusText: '',
  };
}

/** Replaces global.fetch with one that throws, for the life of a test file. */
export function blockNetwork(): void {
  const realFetch = global.fetch;
  beforeAll(() => {
    global.fetch = (() => {
      throw new Error('network access in a test');
    }) as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Captures every console line written during a test. */
export function captureConsole(): { lines: () => string[]; restore: () => void } {
  const spies = CONSOLE_METHODS.map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  return {
    lines: () => spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

// ---------------------------------------------------------------------------
// PR-2b envelopes, transcribed from the same migration.
// ---------------------------------------------------------------------------

/** A client id of the registered shape (all zeros). */
export const CLIENT_ID = `kpr_c_${'A'.repeat(22)}`;
export const RESOURCE = `${ORIGIN}/api/mcp`;
/** A code verifier of the minimum length (RFC 7636 section 4.1) and a challenge of the S256 shape. */
export const VERIFIER = 'v'.repeat(43);
export const CHALLENGE = 'c'.repeat(43);
/** kpr_-shaped fixture credentials (repeated characters). */
export const CODE = `kpr_ac_${'C'.repeat(43)}`;
export const REFRESH = `kpr_rt_${'R'.repeat(43)}`;
export const BINDING = `kpr_bd_${'B'.repeat(43)}`;
/** request id shape of _mcp_b64url(uuid_send(gen_random_uuid())): 22 characters. */
export const REQUEST_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

/** mcp_authorize_begin success, :524. */
export function authorizeOk(requestId: string = REQUEST_ID) {
  return { ok: true, request_id: requestId, expires_in: 600 };
}

/** mcp_authorize_begin page refusal, :489/:495 (invalid_client), :499/:503 (temporarily_unavailable). */
export function authorizePage(code: string) {
  return { ok: false, error: code, show: 'page' };
}

/** mcp_authorize_begin redirect refusal, :510-511 (invalid_request), :514-515 (invalid_scope). */
export function authorizeRedirect(code: string, redirectUri: string, state: string | null) {
  return { ok: false, error: code, show: 'redirect', redirect_uri: redirectUri, state };
}

/** mcp_exchange_code success :626; mcp_refresh success :693. */
export function tokenOk() {
  return { ok: true, token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' };
}
