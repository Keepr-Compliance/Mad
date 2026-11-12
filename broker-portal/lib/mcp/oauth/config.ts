/**
 * OAuth server configuration (BACKLOG-4238), read per request.
 *
 * Three states:
 * - 'off': MCP_ENABLED is not exactly "true", or MCP_PUBLIC_ORIGIN is not an https origin.
 * - 'misconfigured': a required variable is missing or malformed; `missing` lists names only.
 * - 'ok': everything the OAuth routes need.
 *
 * No variable substitutes for another one.
 */

import { configuredOrigin, MCP_PATH, mcpEnabled } from '@/lib/mcp/config';

export type OAuthConfig =
  | { state: 'off' }
  | { state: 'misconfigured'; missing: string[] }
  | {
      state: 'ok';
      issuer: string;
      resource: string;
      pepper: Buffer;
      secret: string;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** MCP_TOKEN_PEPPER decoded from base64url; null unless it is exactly 32 bytes. */
function decodePepper(raw: string | undefined): Buffer | null {
  if (!raw || !BASE64URL.test(raw)) return null;
  const buf = Buffer.from(raw, 'base64url');
  if (buf.length !== 32) return null;
  if (buf.toString('base64url') !== raw) return null;
  return buf;
}

export function oauthConfig(): OAuthConfig {
  if (!mcpEnabled()) return { state: 'off' };
  const origin = configuredOrigin();
  if (origin === null) return { state: 'off' };

  const missing: string[] = [];
  const pepper = decodePepper(process.env.MCP_TOKEN_PEPPER);
  if (!pepper) missing.push('MCP_TOKEN_PEPPER');
  const secret = process.env.MCP_PORTAL_SECRET;
  if (!secret) missing.push('MCP_PORTAL_SECRET');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseAnonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  if (missing.length > 0 || !pepper || !secret || !supabaseUrl || !supabaseAnonKey) {
    return { state: 'misconfigured', missing };
  }
  return {
    state: 'ok',
    issuer: origin,
    resource: `${origin}${MCP_PATH}`,
    pepper,
    secret,
    supabaseUrl,
    supabaseAnonKey,
  };
}
