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

interface Transport {
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

type Refused<C extends string> = { kind: 'refused'; error: C };

// ---------------------------------------------------------------------------
// mcp_authorize_view(p_request_id text, p_browser_binding_sha256 bytea)
// ---------------------------------------------------------------------------

const VIEW_ERRORS = ['not_signed_in', 'impersonating', 'disabled', 'request_invalid'] as const;
type ViewError = (typeof VIEW_ERRORS)[number];

const VIEW_KEYS = [
  'ok',
  'request_id',
  'client_name',
  'provider',
  'redirect_host',
  'scope',
  'notice_version',
  'nonce',
  'replaces_existing',
];

/**
 * BACKLOG-4263 PR-10.5: a later migration adds one key, the request's age in whole seconds on the
 * database clock. The answer is either exactly VIEW_KEYS or exactly VIEW_KEYS plus this key.
 */
const VIEW_AGE_KEY = 'age_seconds';
const VIEW_KEYS_WITH_AGE = [...VIEW_KEYS, VIEW_AGE_KEY];
const MAX_AGE_SECONDS = 86_400;

function isAgeSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_AGE_SECONDS;
}

interface ConsentView {
  kind: 'ok';
  clientName: string;
  provider: Provider;
  redirectHost: string;
  noticeVersion: number;
  nonce: string;
  /** An active connection with the same redirect address is replaced when this request completes. */
  replacesExisting: boolean;
  /** BACKLOG-4263 PR-5: approving grants 'mcp:todos' (read, and change todos); the page shows that wording. */
  canChangeTodos: boolean;
  /** Seconds since the request was started, as the database computed it; absent when the answer has no age. */
  ageSeconds?: number;
}

type ViewResult = ConsentView | Refused<ViewError> | Transport;

function checkView(v: unknown, requestId: string): ViewResult {
  if (!isObject(v)) return transport(null);
  if (v.ok === true) {
    const hasAge = Object.prototype.hasOwnProperty.call(v, VIEW_AGE_KEY);
    if (
      (hasAge ? hasExactKeys(v, VIEW_KEYS_WITH_AGE) && isAgeSeconds(v[VIEW_AGE_KEY]) : hasExactKeys(v, VIEW_KEYS)) &&
      v.request_id === requestId &&
      isClientName(v.client_name) &&
      isProvider(v.provider) &&
      isHost(v.redirect_host) &&
      (v.scope === 'mcp:read' || v.scope === 'mcp:todos') &&
      typeof v.notice_version === 'number' &&
      Number.isInteger(v.notice_version) &&
      isNonce(v.nonce) &&
      typeof v.replaces_existing === 'boolean'
    ) {
      const view: ConsentView = {
        kind: 'ok',
        clientName: v.client_name,
        provider: v.provider,
        redirectHost: v.redirect_host,
        noticeVersion: v.notice_version,
        nonce: v.nonce,
        replacesExisting: v.replaces_existing,
        canChangeTodos: v.scope === 'mcp:todos',
      };
      if (hasAge) view.ageSeconds = v[VIEW_AGE_KEY] as number;
      return view;
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
type ApproveError = (typeof APPROVE_ERRORS)[number];

const DENY_ERRORS = ['not_signed_in', 'impersonating', 'request_invalid'] as const;
type DenyError = (typeof DENY_ERRORS)[number];

interface Decided {
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
/**
 * BACKLOG-4263 PR-6: migration 20261118140000 adds `scope` (the stored grant, 'mcp:read' or 'mcp:todos'). Both
 * shapes are accepted, so this portal can be deployed before that migration is applied (and after a rollback).
 */
const CONNECTION_KEYS_WITH_SCOPE = [...CONNECTION_KEYS, 'scope'];

interface Connection {
  id: string;
  clientName: string;
  provider: Provider;
  redirectHost: string;
  consentedAt: string;
  lastUsedAt: string | null;
  /** BACKLOG-4263 PR-6: granted 'mcp:todos'; null when the database does not say (before 20261118140000). */
  canChangeTodos: boolean | null;
}

type ListResult = { kind: 'ok'; connections: Connection[] } | Refused<'not_signed_in'> | Transport;

function checkConnection(v: unknown): Connection | null {
  if (!isObject(v) || !(hasExactKeys(v, CONNECTION_KEYS) || hasExactKeys(v, CONNECTION_KEYS_WITH_SCOPE))) return null;
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
    // An unknown scope value says nothing about this row: no "Allowed" line, the row and its Disconnect stay.
    canChangeTodos: v.scope === 'mcp:todos' ? true : v.scope === 'mcp:read' ? false : null,
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
type DisconnectError = (typeof DISCONNECT_ERRORS)[number];

type DisconnectResult = { kind: 'ok' } | Refused<DisconnectError> | Transport;

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
