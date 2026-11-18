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
 * BACKLOG-4263 PR-10, between the token shape and mcp_check_access: the body
 * is read once here (over 256 KiB → the SDK's 413), more than 4 JSON-RPC
 * requests in one POST → 400, then the per-token request limits of
 * lib/mcp/rateLimit.ts (60 JSON-RPC requests per 60 s, 4 in flight). A
 * refused request makes no database call. The counters are in memory and
 * count per server instance: they bound one instance's load from one
 * connection, not a caller spread over many instances.
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
import { checkAccess, writeAccess } from '@/lib/mcp/oauth/rpc';
import { isCredential } from '@/lib/mcp/oauth/validate';
import { isOriginAllowed } from '@/lib/mcp/origin';
import { admitMcpRequest, MCP_BATCH_LIMIT } from '@/lib/mcp/rateLimit';
import {
  mcpBatchTooLarge,
  mcpBodyTooLarge,
  mcpBodyUnreadable,
  mcpRateLimited,
  readMcpBody,
  releaseWhenDone,
} from '@/lib/mcp/requestLimits';
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

  const body = await readMcpBody(req);
  if (body.kind === 'too_large') return done(mcpBodyTooLarge(), 'body_too_large');
  if (body.kind === 'unreadable') return done(mcpBodyUnreadable(), 'body_unreadable');
  const requests = body.kind === 'parsed' ? body.ids.length : 0;
  if (requests > MCP_BATCH_LIMIT) return done(mcpBatchTooLarge(), 'batch_too_large');

  // A POST counts its JSON-RPC requests toward both limits; a POST with none counts 1 toward the window only.
  const admission = admitMcpRequest(atDigest, Math.max(1, requests), requests);
  if (!admission.ok) {
    // A body that is not JSON has no request id to answer: one error with id null.
    const answer = body.kind === 'parsed' ? mcpRateLimited(body.ids, body.batch) : mcpRateLimited([null], false);
    return done(answer, admission.reason === 'window' ? 'rate_limited' : 'rate_limited_inflight');
  }
  const { release } = admission;
  req.signal?.addEventListener('abort', release, { once: true });

  const access = await checkAccess(cfg, { secret: cfg.secret, atDigest, resource: cfg.resource });
  if (access.kind === 'not_connected') {
    release();
    return done(mcpUnauthorized(resourceMetadataUrl(req), 'invalid_token'), 'not_connected');
  }
  if (access.kind !== 'ok') {
    release();
    return done(mcpUnavailable(), 'unavailable', { error: dbCode(access.code) });
  }

  // BACKLOG-4263 PR-5: whether this token's connection can change todos (granted mcp:todos AND the database's write
  // switch on). Any other answer, an error or an older database included, is read-only: read tools, read-only texts.
  const wa = await writeAccess(cfg, { secret: cfg.secret, atDigest, resource: cfg.resource });
  const canWrite = wa.kind === 'ok' && wa.write === true;

  const authInfo = { token: '', clientId: '', scopes: ['mcp:read'], extra: { atDigest, canWrite } };
  try {
    // The SDK answers a request with a streamed body while the tools still run, so the in-flight slots are
    // released when that body ends, not when fetch returns.
    const res =
      body.kind === 'parsed'
        ? await getMcpHandler().fetch(req, { authInfo, parsedBody: body.parsed })
        : await getMcpHandler().fetch(body.request, { authInfo });
    return done(releaseWhenDone(res, release), 'ok');
  } catch (err) {
    release();
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
