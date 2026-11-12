/**
 * BACKLOG-4238 — fixtures for the consent page and AI apps tests.
 *
 * Envelope shapes are transcribed from the migration
 * supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql:
 * mcp_authorize_view :814-822, approve :891, deny :923, refusals via
 * _mcp_refuse :198-201 ({ok:false, error}), list :939-948, disconnect :975,
 * disconnect_all_mine :994. The timestamp text of consented_at / last_used_at
 * (timestamptz in jsonb) is not transcribed from a running database.
 */

export { BINDING, CODE, ORIGIN, PEPPER_BYTES, REDIRECT_URI, REQUEST_ID } from '../oauth/fixtures';
import { BINDING, OAUTH_ENV, REDIRECT_URI, REQUEST_ID } from '../oauth/fixtures';

export const NONCE = 'N'.repeat(43);
export const NONCE_2 = 'M'.repeat(43);
export const EMAIL = 'consent-4238@example.test';
export const CONNECTION_ID = '00000000-0000-4000-8000-000000423801'; // pii-allow-uuid: invented fixture id
export const CONNECTION_ID_2 = '00000000-0000-4000-8000-000000423802'; // pii-allow-uuid: invented fixture id

export const BIND_COOKIE = `__Host-kpr_mcp_bind=${BINDING}`;

export function setMcpEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(OAUTH_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export function clearMcpEnv(): void {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_PUBLIC_ORIGIN;
}

export function viewOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    request_id: REQUEST_ID,
    client_name: 'Claude',
    provider: 'anthropic',
    redirect_host: 'claude.ai',
    scope: 'mcp:read',
    notice_version: 1,
    nonce: NONCE,
    ...over,
  };
}

export function decisionOk(state: string | null = 'state-4238', redirectUri: string = REDIRECT_URI) {
  return { ok: true, redirect_uri: redirectUri, state };
}

export function refused(code: string) {
  return { ok: false, error: code };
}

export function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    client_name: 'Claude',
    provider: 'anthropic',
    redirect_host: 'claude.ai',
    consented_at: '2026-11-10T18:30:00.123456+00:00',
    last_used_at: null,
    ...over,
  };
}
