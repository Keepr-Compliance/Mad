/**
 * OAuth dynamic client registration (RFC 7591) — BACKLOG-4238.
 *
 * POST only, JSON body of at most 16 KiB, no query string. Every shape check
 * answers without a database call. Whether a redirect URI is allowed is
 * decided by the database (mcp_register_client). Public clients only: the
 * token endpoint auth method is always 'none' and no secret is issued.
 */

import { ipDigest, newClientId, toBytea } from '@/lib/mcp/oauth/crypto';
import { clientIp } from '@/lib/mcp/oauth/clientIp';
import { withOAuthRoute, type LogFields } from '@/lib/mcp/oauth/guard';
import { oauthError, oauthJson } from '@/lib/mcp/oauth/http';
import { dbCode, errorNameTag, filterKeys, REGISTER_LOG_KEYS } from '@/lib/mcp/oauth/log';
import { registerClient } from '@/lib/mcp/oauth/rpc';
import { clientNameFor, isRedirectUriShape, isSubsetOf } from '@/lib/mcp/oauth/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REGISTER_BODY_BYTES = 16 * 1024;

const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const RESPONSE_TYPES = ['code'] as const;

/** The body as text, or null when it is longer than `limit` bytes or is not valid UTF-8. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

function refuse(log: LogFields, outcome: string, error: string): Response {
  log.outcome = outcome;
  return oauthError(400, error);
}

const route = withOAuthRoute('register', ['POST'], async (req, cfg, log) => {
  // 1. no query string
  if (new URL(req.url).search !== '') return refuse(log, 'query_refused', 'invalid_request');

  // 2. JSON object of at most 16 KiB
  if (!isJsonContentType(req.headers.get('content-type'))) {
    return refuse(log, 'bad_content_type', 'invalid_client_metadata');
  }
  const text = await readBody(req, MAX_REGISTER_BODY_BYTES);
  if (text === null) return refuse(log, 'bad_body', 'invalid_client_metadata');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(log, 'bad_json', 'invalid_client_metadata');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse(log, 'bad_json', 'invalid_client_metadata');
  }
  const meta = body as Record<string, unknown>;
  Object.assign(log, filterKeys(Object.keys(meta), REGISTER_LOG_KEYS));

  // 3. redirect_uris: 1-3, each a well-formed https URI
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 3 || !uris.every(isRedirectUriShape)) {
    return refuse(log, 'invalid_redirect_uri', 'invalid_redirect_uri');
  }
  const redirectUris = uris as string[];

  // 4. grant and response types
  if (!isSubsetOf(meta.grant_types, GRANT_TYPES) || !isSubsetOf(meta.response_types, RESPONSE_TYPES)) {
    return refuse(log, 'invalid_client_metadata', 'invalid_client_metadata');
  }

  // 5. token_endpoint_auth_method is always 'none' (RFC 7591 section 3.2.1): not read.

  // 6. client name
  const clientName = clientNameFor(meta.client_name, redirectUris[0]);
  if (clientName === null) return refuse(log, 'invalid_client_metadata', 'invalid_client_metadata');

  // 7. everything else is ignored and not echoed

  const result = await registerClient(cfg, {
    secret: cfg.secret,
    clientId: newClientId(),
    clientName,
    redirectUris,
    ipSha256: toBytea(ipDigest(cfg.pepper, clientIp(req))),
  });

  switch (result.kind) {
    case 'ok':
      log.outcome = 'registered';
      return oauthJson(201, {
        client_id: result.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: result.clientName,
        redirect_uris: result.redirectUris,
        grant_types: [...GRANT_TYPES],
        response_types: [...RESPONSE_TYPES],
        token_endpoint_auth_method: 'none',
        scope: 'mcp:read',
      });
    case 'error':
      log.outcome = result.error;
      if (result.error === 'rate_limited') {
        return oauthError(429, 'temporarily_unavailable', { 'Retry-After': '3600' });
      }
      if (result.error === 'busy') return oauthError(503, 'temporarily_unavailable', { 'Retry-After': '1' });
      return oauthError(400, result.error);
    case 'transport':
      log.outcome = 'transport';
      log.error = `${errorNameTag({ name: result.name })}:${dbCode(result.code)}`;
      return oauthError(503, 'temporarily_unavailable');
  }
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
