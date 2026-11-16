/**
 * Shared fixtures for the MCP endpoint tests (BACKLOG-4237, BACKLOG-4238).
 *
 * Tokens are built from repeated characters. Database envelopes are
 * transcribed from supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql:
 * - mcp_check_access: `jsonb_build_object('ok', true)` (:722) or
 *   `_mcp_refuse('not_connected')` (:708, :724), which is
 *   `jsonb_build_object('ok', false, 'error', code)` (:198-201).
 * - mcp_get_status: `jsonb_build_object('ok', true, 'result',
 *   jsonb_build_object('connected', true, 'provider', g.provider, 'entitled', …,
 *   'reason', v_ent -> 'reason'))` (:769-773); reason is JSON null when
 *   entitled (_mcp_r_entitlement :313) and a short code otherwise (:302-311).
 *   Refusals via _mcp_refuse with not_connected | disabled | rate_limited |
 *   busy (_mcp_enter :344-362) and timeout | error (:764-767).
 */

import { createHmac } from 'node:crypto';
import { PEPPER_BYTES } from './oauth/fixtures';

/** An access token of the issued shape (kpr_at_ + 43 base64url characters). */
export const ACCESS_TOKEN = `kpr_at_${'T'.repeat(43)}`;
/** A second well-formed access token the database does not know. */
export const UNKNOWN_ACCESS_TOKEN = `kpr_at_${'U'.repeat(43)}`;

/** HMAC-SHA256(pepper, whole token), computed here independently of lib/mcp/oauth/crypto.ts. */
export function expectedDigestBytes(token: string): Buffer {
  return createHmac('sha256', PEPPER_BYTES).update(token, 'utf8').digest();
}

/** The digest in the bytea text form the portal sends to PostgREST ('\x' + lowercase hex). */
export function expectedDigest(token: string): string {
  return `\\x${expectedDigestBytes(token).toString('hex')}`;
}

/** Every text form of a digest that could appear in a log line or a Sentry payload. */
export function digestForms(token: string): string[] {
  const b = expectedDigestBytes(token);
  return [`\\x${b.toString('hex')}`, b.toString('hex'), b.toString('hex').toUpperCase(), b.toString('base64'), b.toString('base64url')];
}

export function checkAccessOk() {
  return { ok: true };
}

export function getStatusOk(entitled = true, reason: string | null = null) {
  return { ok: true, result: { connected: true, provider: 'anthropic', entitled, reason } };
}
