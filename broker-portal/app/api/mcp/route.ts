/**
 * MCP endpoint — BACKLOG-4237, BACKLOG-4238.
 *
 * Order of checks on POST: OAuth configuration ('off' → 404, 'misconfigured'
 * → 503) → Origin (403) → Bearer token present (401) → token shape
 * kpr_at_ + 43 characters (401 invalid_token) → mcp_check_access with the
 * token digest ({ok:true} only → continue; not_connected → 401 invalid_token;
 * anything else → 503) → SDK handler. Other methods: 404 when MCP is off,
 * else 405.
 *
 * One log line per request: fixed outcome, status and duration. Never the
 * Authorization header, the token, its digest or the request body.
 */

import { mcpEnabled, resourceMetadataUrl } from '@/lib/mcp/config';
import {
  mcpForbiddenOrigin,
  mcpMethodNotAllowed,
  mcpNotFound,
  mcpUnauthorized,
  mcpUnavailable,
} from '@/lib/mcp/errors';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { digest } from '@/lib/mcp/oauth/crypto';
import { dbCode, errorNameTag, logOutcome, type Outcome } from '@/lib/mcp/oauth/log';
import { checkAccess } from '@/lib/mcp/oauth/rpc';
import { isCredential } from '@/lib/mcp/oauth/validate';
import { isOriginAllowed } from '@/lib/mcp/origin';
import { getMcpHandler } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The Bearer credential, or null when the header is absent or not of the Bearer form. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(header);
  return match ? match[1] : null;
}

type Extra = Partial<Pick<Outcome, 'error' | 'missing'>>;

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const done = (res: Response, outcome: string, extra: Extra = {}): Response => {
    logOutcome({ route: 'mcp', outcome, status: res.status, ms: Date.now() - started, ...extra });
    return res;
  };

  const cfg = oauthConfig();
  if (cfg.state === 'off') return done(mcpNotFound(), 'not_found');
  if (cfg.state === 'misconfigured') return done(mcpUnavailable(), 'misconfigured', { missing: cfg.missing });
  if (!isOriginAllowed(req.headers.get('origin'))) return done(mcpForbiddenOrigin(), 'forbidden_origin');

  const token = bearerToken(req);
  if (!token) return done(mcpUnauthorized(resourceMetadataUrl(req)), 'no_token');
  if (!isCredential('at', token)) {
    return done(mcpUnauthorized(resourceMetadataUrl(req), 'invalid_token'), 'bad_token_shape');
  }

  const atDigest = digest(cfg.pepper, token);
  const access = await checkAccess(cfg, { secret: cfg.secret, atDigest, resource: cfg.resource });
  if (access.kind === 'not_connected') {
    return done(mcpUnauthorized(resourceMetadataUrl(req), 'invalid_token'), 'not_connected');
  }
  if (access.kind !== 'ok') return done(mcpUnavailable(), 'unavailable', { error: dbCode(access.code) });

  try {
    const res = await getMcpHandler().fetch(req, {
      authInfo: { token: '', clientId: '', scopes: ['mcp:read'], extra: { atDigest } },
    });
    return done(res, 'ok');
  } catch (err) {
    console.error('[mcp] request failed:', (err as Error).name);
    return done(mcpUnavailable(), 'error', { error: errorNameTag(err) });
  }
}

function notPost(_req: Request): Response {
  const res = mcpEnabled() ? mcpMethodNotAllowed() : mcpNotFound();
  logOutcome({ route: 'mcp', outcome: res.status === 405 ? 'method_not_allowed' : 'not_found', status: res.status, ms: 0 });
  return res;
}

export const GET = notPost;
export const PUT = notPost;
export const PATCH = notPost;
export const DELETE = notPost;
// Next answers OPTIONS itself (204) unless the route exports it.
export const OPTIONS = notPost;
