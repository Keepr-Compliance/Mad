/**
 * Database calls for the OAuth server (BACKLOG-4238).
 *
 * A bare anon client: no session, no cookies, no service role. Every call has
 * an 8 s timeout. Every result passes an envelope check; anything that is not
 * a known success or a known refusal is reported as 'transport'.
 */

import { createClient } from '@supabase/supabase-js';

export const RPC_TIMEOUT_MS = 8000;

interface ClientConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(RPC_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

function anonClient(cfg: ClientConfig) {
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: timedFetch },
  });
}

/** A failure that is neither a success nor a known refusal. `name`/`code` are for logs only. */
export interface Transport {
  kind: 'transport';
  name: unknown;
  code: unknown;
}

function transport(err: unknown): Transport {
  const e = err as { name?: unknown; code?: unknown } | null;
  return { kind: 'transport', name: e?.name, code: e?.code };
}

async function call(cfg: ClientConfig, fn: string, args: Record<string, unknown>): Promise<{ data: unknown } | Transport> {
  try {
    const { data, error } = await anonClient(cfg).rpc(fn, args);
    if (error) return transport(error);
    return { data };
  } catch (err) {
    return transport(err);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** {ok:false, error:<one of codes>} → the code; anything else → null. */
function refusal<C extends string>(v: Record<string, unknown>, codes: readonly C[]): C | null {
  if (v.ok !== false || typeof v.error !== 'string') return null;
  return (codes as readonly string[]).includes(v.error) ? (v.error as C) : null;
}

// ---------------------------------------------------------------------------
// mcp_register_client(p_secret text, p_client_id text, p_client_name text,
//                     p_redirect_uris text[], p_ip_sha256 bytea)
// ---------------------------------------------------------------------------

export const REGISTER_ERRORS = ['invalid_client_metadata', 'invalid_redirect_uri', 'rate_limited', 'busy'] as const;
export type RegisterError = (typeof REGISTER_ERRORS)[number];

export type RegisterResult =
  | { kind: 'ok'; clientId: string; clientName: string; redirectUris: string[] }
  | { kind: 'error'; error: RegisterError }
  | Transport;

export interface RegisterArgs {
  secret: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** bytea text form, '\x' + 64 hex characters */
  ipSha256: string;
}

export function checkRegisterEnvelope(v: unknown): RegisterResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    if (
      typeof v.client_id === 'string' &&
      typeof v.client_name === 'string' &&
      Array.isArray(v.redirect_uris) &&
      v.redirect_uris.every((u) => typeof u === 'string')
    ) {
      return { kind: 'ok', clientId: v.client_id, clientName: v.client_name, redirectUris: v.redirect_uris as string[] };
    }
    return transport(null);
  }
  const code = refusal(v, REGISTER_ERRORS);
  return code ? { kind: 'error', error: code } : transport(null);
}

export async function registerClient(cfg: ClientConfig, a: RegisterArgs): Promise<RegisterResult> {
  const res = await call(cfg, 'mcp_register_client', {
    p_secret: a.secret,
    p_client_id: a.clientId,
    p_client_name: a.clientName,
    p_redirect_uris: a.redirectUris,
    p_ip_sha256: a.ipSha256,
  });
  if ('kind' in res) return res;
  return checkRegisterEnvelope(res.data);
}

// ---------------------------------------------------------------------------
// mcp_authorize_begin(p_secret text, p_client_id text, p_redirect_uri text,
//   p_code_challenge text, p_code_challenge_method text, p_resource text,
//   p_scope text, p_state text, p_browser_binding_sha256 bytea, p_ip_sha256 bytea)
// ---------------------------------------------------------------------------

const AUTHORIZE_PAGE_ERRORS = ['invalid_client', 'temporarily_unavailable'] as const;
const AUTHORIZE_REDIRECT_ERRORS = ['invalid_request', 'invalid_scope'] as const;

type AuthorizeResult =
  | { kind: 'ok'; requestId: string }
  | { kind: 'page'; error: (typeof AUTHORIZE_PAGE_ERRORS)[number] }
  | { kind: 'redirect'; error: (typeof AUTHORIZE_REDIRECT_ERRORS)[number]; redirectUri: string }
  | Transport;

interface AuthorizeArgs {
  secret: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string;
  scope: string;
  state: string | null;
  /** bytea text form */
  bindingSha256: string;
  /** bytea text form */
  ipSha256: string;
}

function checkAuthorizeEnvelope(v: unknown): AuthorizeResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    return typeof v.request_id === 'string' && typeof v.expires_in === 'number'
      ? { kind: 'ok', requestId: v.request_id }
      : transport(null);
  }
  if (v.show === 'page') {
    const code = refusal(v, AUTHORIZE_PAGE_ERRORS);
    return code ? { kind: 'page', error: code } : transport(null);
  }
  if (v.show === 'redirect' && typeof v.redirect_uri === 'string') {
    const code = refusal(v, AUTHORIZE_REDIRECT_ERRORS);
    return code ? { kind: 'redirect', error: code, redirectUri: v.redirect_uri } : transport(null);
  }
  return transport(null);
}

export async function authorizeBegin(cfg: ClientConfig, a: AuthorizeArgs): Promise<AuthorizeResult> {
  const res = await call(cfg, 'mcp_authorize_begin', {
    p_secret: a.secret,
    p_client_id: a.clientId,
    p_redirect_uri: a.redirectUri,
    p_code_challenge: a.codeChallenge,
    p_code_challenge_method: a.codeChallengeMethod,
    p_resource: a.resource,
    p_scope: a.scope,
    p_state: a.state,
    p_browser_binding_sha256: a.bindingSha256,
    p_ip_sha256: a.ipSha256,
  });
  if ('kind' in res) return res;
  return checkAuthorizeEnvelope(res.data);
}

// ---------------------------------------------------------------------------
// mcp_exchange_code(p_secret text, p_code_digest bytea, p_code_verifier text,
//   p_client_id text, p_redirect_uri text, p_resource text, p_at_digest bytea,
//   p_rt_digest bytea)
// mcp_refresh(p_secret text, p_rt_digest bytea, p_client_id text,
//   p_resource text, p_new_at_digest bytea, p_new_rt_digest bytea)
// ---------------------------------------------------------------------------

const TOKEN_ERRORS = ['invalid_grant', 'invalid_request', 'rate_limited'] as const;

export type TokenResult =
  | { kind: 'ok'; tokenType: 'Bearer'; expiresIn: number; scope: string }
  | { kind: 'error'; error: (typeof TOKEN_ERRORS)[number] }
  | Transport;

function checkTokenEnvelope(v: unknown): TokenResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    if (
      v.token_type === 'Bearer' &&
      typeof v.expires_in === 'number' &&
      Number.isInteger(v.expires_in) &&
      v.expires_in > 0 &&
      typeof v.scope === 'string'
    ) {
      return { kind: 'ok', tokenType: 'Bearer', expiresIn: v.expires_in, scope: v.scope };
    }
    return transport(null);
  }
  const code = refusal(v, TOKEN_ERRORS);
  return code ? { kind: 'error', error: code } : transport(null);
}

interface ExchangeArgs {
  secret: string;
  codeDigest: string;
  codeVerifier: string;
  clientId: string;
  /** null when the request did not send redirect_uri */
  redirectUri: string | null;
  resource: string;
  atDigest: string;
  rtDigest: string;
}

export async function exchangeCode(cfg: ClientConfig, a: ExchangeArgs): Promise<TokenResult> {
  const res = await call(cfg, 'mcp_exchange_code', {
    p_secret: a.secret,
    p_code_digest: a.codeDigest,
    p_code_verifier: a.codeVerifier,
    p_client_id: a.clientId,
    p_redirect_uri: a.redirectUri,
    p_resource: a.resource,
    p_at_digest: a.atDigest,
    p_rt_digest: a.rtDigest,
  });
  if ('kind' in res) return res;
  return checkTokenEnvelope(res.data);
}

interface RefreshArgs {
  secret: string;
  rtDigest: string;
  clientId: string;
  resource: string;
  newAtDigest: string;
  newRtDigest: string;
}

export async function refreshTokens(cfg: ClientConfig, a: RefreshArgs): Promise<TokenResult> {
  const res = await call(cfg, 'mcp_refresh', {
    p_secret: a.secret,
    p_rt_digest: a.rtDigest,
    p_client_id: a.clientId,
    p_resource: a.resource,
    p_new_at_digest: a.newAtDigest,
    p_new_rt_digest: a.newRtDigest,
  });
  if ('kind' in res) return res;
  return checkTokenEnvelope(res.data);
}
