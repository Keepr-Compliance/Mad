/**
 * Bearer token pre-check for the MCP endpoint (BACKLOG-4237).
 *
 * The token must verify with Supabase Auth (getClaims) AND carry a non-empty
 * string `client_id` claim. A token without one is refused.
 */

import { createClient } from '@supabase/supabase-js';
import type { AuthInfo } from '@modelcontextprotocol/server';

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(header);
  return match ? match[1] : null;
}

function authClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type McpTokenResult =
  | { ok: true; authInfo: AuthInfo }
  | { ok: false; reason: 'invalid' | 'unavailable' };

export async function verifyMcpToken(token: string): Promise<McpTokenResult> {
  const client = authClient();
  if (!client) return { ok: false, reason: 'unavailable' };

  let claims: Record<string, unknown> | undefined;
  try {
    const { data, error } = await client.auth.getClaims(token);
    if (error || !data) return { ok: false, reason: 'invalid' };
    claims = data.claims as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const clientId = claims?.client_id;
  const sub = claims?.sub;
  if (typeof clientId !== 'string' || clientId.length === 0) return { ok: false, reason: 'invalid' };
  if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'invalid' };

  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  return {
    ok: true,
    authInfo: { token, clientId, scopes: [], expiresAt: exp, extra: { sub } },
  };
}
