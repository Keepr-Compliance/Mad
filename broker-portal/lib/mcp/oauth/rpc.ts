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
