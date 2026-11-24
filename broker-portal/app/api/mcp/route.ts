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
 * lib/mcp/rateLimit.ts (60 JSON-RPC requests per 60 s, 4 in flight): a token
 * that has counters is counted, or refused, before mcp_check_access; counters
 * are created only for a token mcp_check_access accepted. The counters are in
 * memory and count per server instance: they bound one instance's load from
 * one connection, not a caller spread over many instances.
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
import { checkAccess, messageAccess, writeAccess } from '@/lib/mcp/oauth/rpc';
import { isCredential } from '@/lib/mcp/oauth/validate';
import { isOriginAllowed } from '@/lib/mcp/origin';
import { admitKnownMcpRequest, admitMcpRequest, MCP_BATCH_LIMIT, type Refusal } from '@/lib/mcp/rateLimit';
import {
  mcpBatchTooLarge,
  mcpBodyTooLarge,
  mcpBodyUnreadable,
  endSlotWithResponse,
  mcpRateLimited,
  readMcpBody,
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

  // A POST counts its JSON-RPC requests toward both limits; a POST with none counts 1 toward each.
  const windowCost = Math.max(1, requests);
  const inFlightCost = Math.max(1, requests);
  const refuse = (reason: Refusal) => {
    // A body that is not JSON has no request id to answer: one error with id null.
    const answer = body.kind === 'parsed' ? mcpRateLimited(body.ids, body.batch) : mcpRateLimited([null], false);
    return done(answer, reason === 'window' ? 'rate_limited' : 'rate_limited_inflight');
  };
  // A token that already has counters is counted (or refused) before the database; counters are created only for
  // a token mcp_check_access accepted.
  let admission = admitKnownMcpRequest(atDigest, windowCost, inFlightCost);
  if (admission && !admission.ok) return refuse(admission.reason);

  const access = await checkAccess(cfg, { secret: cfg.secret, atDigest, resource: cfg.resource });
  if (access.kind !== 'ok' && admission?.ok) admission.slot.release();
  if (access.kind === 'not_connected') {
    return done(mcpUnauthorized(resourceMetadataUrl(req), 'invalid_token'), 'not_connected');
  }
  if (access.kind !== 'ok') return done(mcpUnavailable(), 'unavailable', { error: dbCode(access.code) });

  if (!admission) {
    admission = admitMcpRequest(atDigest, windowCost, inFlightCost);
    if (!admission.ok) return refuse(admission.reason);
  }
  const { slot } = admission;

  // BACKLOG-4263 PR-5: whether this token's connection can change todos (granted mcp:todos AND the database's write
  // switch on). Any other answer, an error or an older database included, is read-only: read tools, read-only texts.
  try {
    // BACKLOG-4263 P10: whether it may read the emails and texts of its deals (mcp_message_access), asked on every
    // request beside writeAccess. Only exactly {ok:true, messages:true} is true; anything else lists no message tools.
    const args = { secret: cfg.secret, atDigest, resource: cfg.resource };
    const [wa, ma] = await Promise.all([writeAccess(cfg, args), messageAccess(cfg, args)]);
    const canWrite = wa.kind === 'ok' && wa.write === true;
    const canReadMessages = ma.kind === 'ok' && ma.messages === true;
    const authInfo = { token: '', clientId: '', scopes: ['mcp:read'], extra: { atDigest, canWrite, canReadMessages } };
    // The SDK answers with a streamed body while the tools still run, so the in-flight slot ends with that body,
    // not when fetch returns.
    const res =
      body.kind === 'parsed'
        ? await getMcpHandler().fetch(req, { authInfo, parsedBody: body.parsed })
        : await getMcpHandler().fetch(body.request, { authInfo });
    return done(noStore(endSlotWithResponse(res, slot, req.signal)), 'ok');
  } catch (err) {
    slot.release();
    console.error('[mcp] request failed:', (err as Error).name);
    return done(mcpUnavailable(), 'error', { error: errorNameTag(err) });
  }
}

/** BACKLOG-4263 P10: every answer from the SDK says it must not be stored (event streams keep no-transform). */
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  const stream = (headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream');
  headers.set('Cache-Control', stream ? 'no-store, no-transform' : 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
