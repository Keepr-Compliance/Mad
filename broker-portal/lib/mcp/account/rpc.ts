/**
 * Signed-in database calls for the consent page and the AI apps page
 * (BACKLOG-4238).
 *
 * The client is the person's own cookie-session client; every function checks
 * auth.uid() inside. Every result passes a strict envelope check: anything that
 * is not exactly a known success or a known refusal is 'transport'.
 */

import { createClient } from '@/lib/supabase/server';
import { isProvider, type Provider } from './messages';
import { isConnectionId, isNonce, isRedirectUriShape } from '@/lib/mcp/oauth/validate';

export interface Transport {
  kind: 'transport';
  name: unknown;
  code: unknown;
}

function transport(err: unknown): Transport {
  const e = err as { name?: unknown; code?: unknown } | null;
  return { kind: 'transport', name: e?.name, code: e?.code };
}

async function call(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown } | Transport> {
  try {
    const supabase = await createClient();
    const { data, error } = args === undefined ? await supabase.rpc(fn) : await supabase.rpc(fn, args);
    if (error) return transport(error);
    return { data };
  } catch (err) {
    return transport(err);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

/** {ok:false, error:<one of codes>} with no other key → the code; anything else → null. */
function refusal<C extends string>(v: Record<string, unknown>, codes: readonly C[]): C | null {
  if (!hasExactKeys(v, ['ok', 'error']) || v.ok !== false || typeof v.error !== 'string') return null;
  return (codes as readonly string[]).includes(v.error) ? (v.error as C) : null;
}

function codePoints(s: string): number {
  return [...s].length;
}

function isClientName(v: unknown): v is string {
  return typeof v === 'string' && codePoints(v) >= 1 && codePoints(v) <= 100;
}

function isHost(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\s/?#@]/.test(v);
}

function isTimestamp(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

export type Refused<C extends string> = { kind: 'refused'; error: C };

// ---------------------------------------------------------------------------
// mcp_authorize_view(p_request_id text, p_browser_binding_sha256 bytea)
// ---------------------------------------------------------------------------

const VIEW_ERRORS = ['not_signed_in', 'impersonating', 'disabled', 'request_invalid'] as const;
export type ViewError = (typeof VIEW_ERRORS)[number];

const VIEW_KEYS = ['ok', 'request_id', 'client_name', 'provider', 'redirect_host', 'scope', 'notice_version', 'nonce'];

export interface ConsentView {
  kind: 'ok';
  clientName: string;
  provider: Provider;
  redirectHost: string;
  noticeVersion: number;
  nonce: string;
}

export type ViewResult = ConsentView | Refused<ViewError> | Transport;

function checkView(v: unknown, requestId: string): ViewResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    if (
      hasExactKeys(v, VIEW_KEYS) &&
      v.request_id === requestId &&
      isClientName(v.client_name) &&
      isProvider(v.provider) &&
      isHost(v.redirect_host) &&
      v.scope === 'mcp:read' &&
      typeof v.notice_version === 'number' &&
      Number.isInteger(v.notice_version) &&
      isNonce(v.nonce)
    ) {
      return {
        kind: 'ok',
        clientName: v.client_name,
        provider: v.provider,
        redirectHost: v.redirect_host,
        noticeVersion: v.notice_version,
        nonce: v.nonce,
      };
    }
    return transport(null);
  }
  const code = refusal(v, VIEW_ERRORS);
  return code ? { kind: 'refused', error: code } : transport(null);
}

export async function viewRequest(requestId: string, bindingSha256: string): Promise<ViewResult> {
  const res = await call('mcp_authorize_view', {
    p_request_id: requestId,
    p_browser_binding_sha256: bindingSha256,
  });
  if ('kind' in res) return res;
  return checkView(res.data, requestId);
}

// ---------------------------------------------------------------------------
// mcp_authorize_approve(p_request_id text, p_browser_binding_sha256 bytea,
//                       p_nonce text, p_code_digest bytea)
// mcp_authorize_deny(p_request_id text, p_browser_binding_sha256 bytea, p_nonce text)
// ---------------------------------------------------------------------------

const APPROVE_ERRORS = [
  'not_signed_in',
  'impersonating',
  'disabled',
  'not_entitled',
  'invalid_request',
  'request_invalid',
] as const;
export type ApproveError = (typeof APPROVE_ERRORS)[number];

const DENY_ERRORS = ['not_signed_in', 'impersonating', 'request_invalid'] as const;
export type DenyError = (typeof DENY_ERRORS)[number];

export interface Decided {
  kind: 'ok';
  redirectUri: string;
  state: string | null;
}

function checkDecision<C extends string>(v: unknown, codes: readonly C[]): Decided | Refused<C> | Transport {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    if (
      hasExactKeys(v, ['ok', 'redirect_uri', 'state']) &&
      isRedirectUriShape(v.redirect_uri) &&
      (v.state === null || typeof v.state === 'string')
    ) {
      return { kind: 'ok', redirectUri: v.redirect_uri, state: v.state as string | null };
    }
    return transport(null);
  }
  const code = refusal(v, codes);
  return code ? { kind: 'refused', error: code } : transport(null);
}

export async function approveRequest(
  requestId: string,
  bindingSha256: string,
  nonce: string,
  codeDigest: string
): Promise<Decided | Refused<ApproveError> | Transport> {
  const res = await call('mcp_authorize_approve', {
    p_request_id: requestId,
    p_browser_binding_sha256: bindingSha256,
    p_nonce: nonce,
    p_code_digest: codeDigest,
  });
  if ('kind' in res) return res;
  return checkDecision(res.data, APPROVE_ERRORS);
}

export async function denyRequest(
  requestId: string,
  bindingSha256: string,
  nonce: string
): Promise<Decided | Refused<DenyError> | Transport> {
  const res = await call('mcp_authorize_deny', {
    p_request_id: requestId,
    p_browser_binding_sha256: bindingSha256,
    p_nonce: nonce,
  });
  if ('kind' in res) return res;
  return checkDecision(res.data, DENY_ERRORS);
}

// ---------------------------------------------------------------------------
// mcp_list_my_connections()
// ---------------------------------------------------------------------------

const CONNECTION_KEYS = ['id', 'client_name', 'provider', 'redirect_host', 'consented_at', 'last_used_at'];

export interface Connection {
  id: string;
  clientName: string;
  provider: Provider;
  redirectHost: string;
  consentedAt: string;
  lastUsedAt: string | null;
}

export type ListResult = { kind: 'ok'; connections: Connection[] } | Refused<'not_signed_in'> | Transport;

function checkConnection(v: unknown): Connection | null {
  if (!isObject(v) || !hasExactKeys(v, CONNECTION_KEYS)) return null;
  if (
    !isConnectionId(v.id) ||
    !isClientName(v.client_name) ||
    !isProvider(v.provider) ||
    !isHost(v.redirect_host) ||
    !isTimestamp(v.consented_at) ||
    !(v.last_used_at === null || isTimestamp(v.last_used_at))
  ) {
    return null;
  }
  return {
    id: v.id,
    clientName: v.client_name,
    provider: v.provider,
    redirectHost: v.redirect_host,
    consentedAt: v.consented_at,
    lastUsedAt: v.last_used_at as string | null,
  };
}

function checkList(v: unknown): ListResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    if (!hasExactKeys(v, ['ok', 'connections']) || !Array.isArray(v.connections)) return transport(null);
    const out: Connection[] = [];
    for (const row of v.connections) {
      const c = checkConnection(row);
      if (c === null) return transport(null);
      out.push(c);
    }
    return { kind: 'ok', connections: out };
  }
  const code = refusal(v, ['not_signed_in'] as const);
  return code ? { kind: 'refused', error: code } : transport(null);
}

export async function listMyConnections(): Promise<ListResult> {
  const res = await call('mcp_list_my_connections');
  if ('kind' in res) return res;
  return checkList(res.data);
}

// ---------------------------------------------------------------------------
// mcp_disconnect(p_connection_id uuid)
// mcp_disconnect_all_mine()
// ---------------------------------------------------------------------------

const DISCONNECT_ERRORS = ['not_signed_in', 'impersonating'] as const;
export type DisconnectError = (typeof DISCONNECT_ERRORS)[number];

export type DisconnectResult = { kind: 'ok' } | Refused<DisconnectError> | Transport;

export async function disconnectConnection(connectionId: string): Promise<DisconnectResult> {
  const res = await call('mcp_disconnect', { p_connection_id: connectionId });
  if ('kind' in res) return res;
  const v = res.data;
  if (!isObject(v)) return transport(null);
  if (v.ok === true) return hasExactKeys(v, ['ok']) ? { kind: 'ok' } : transport(null);
  const code = refusal(v, DISCONNECT_ERRORS);
  return code ? { kind: 'refused', error: code } : transport(null);
}

export async function disconnectAllMine(): Promise<DisconnectResult> {
  const res = await call('mcp_disconnect_all_mine');
  if ('kind' in res) return res;
  const v = res.data;
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    return hasExactKeys(v, ['ok', 'disconnected']) && Number.isInteger(v.disconnected) && (v.disconnected as number) >= 0
      ? { kind: 'ok' }
      : transport(null);
  }
  const code = refusal(v, DISCONNECT_ERRORS);
  return code ? { kind: 'refused', error: code } : transport(null);
}
