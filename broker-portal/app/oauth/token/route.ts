/**
 * OAuth token endpoint (RFC 6749 section 3.2, OAuth 2.1) — BACKLOG-4238.
 *
 * POST only, application/x-www-form-urlencoded body of at most 8 KiB, no query
 * string. Public clients only: no Authorization header, no client secret or
 * assertion. Every request check answers without a database call. Grants:
 * authorization_code (mcp_exchange_code) and refresh_token (mcp_refresh). The
 * route never retries a database call.
 */

import { digest, newToken } from '@/lib/mcp/oauth/crypto';
import { withOAuthRoute, type LogFields } from '@/lib/mcp/oauth/guard';
import { mediaType, oauthError, oauthJson, readBodyText } from '@/lib/mcp/oauth/http';
import { dbCode, errorNameTag, filterKeys, TOKEN_LOG_KEYS } from '@/lib/mcp/oauth/log';
import { exchangeCode, refreshTokens, type TokenResult } from '@/lib/mcp/oauth/rpc';
import {
  canonicalResource,
  isClientId,
  isCodeVerifier,
  isCredential,
  normaliseScope,
  parseForm,
} from '@/lib/mcp/oauth/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOKEN_BODY_BYTES = 8 * 1024;

function refuse(log: LogFields, outcome: string, error: string, status = 400, extra: Record<string, string> = {}): Response {
  log.outcome = outcome;
  return oauthError(status, error, extra);
}

function answer(log: LogFields, result: TokenResult, accessToken: string, refreshToken: string): Response {
  switch (result.kind) {
    case 'ok':
      log.outcome = 'issued';
      return oauthJson(200, {
        access_token: accessToken,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
        refresh_token: refreshToken,
        scope: result.scope,
      });
    case 'error':
      if (result.error === 'rate_limited') return refuse(log, 'rate_limited', 'invalid_request', 429, { 'Retry-After': '60' });
      return refuse(log, result.error, result.error);
    case 'transport':
      log.error = `${errorNameTag({ name: result.name })}:${dbCode(result.code)}`;
      return refuse(log, 'transport', 'temporarily_unavailable', 503, { 'Retry-After': '2' });
  }
}

const route = withOAuthRoute('token', ['POST'], async (req, cfg, log) => {
  if (new URL(req.url).search !== '') return refuse(log, 'query_refused', 'invalid_request');
  if (req.headers.has('authorization')) {
    return refuse(log, 'authorization_header', 'invalid_client', 401, { 'WWW-Authenticate': 'Basic realm="keepr"' });
  }
  if (mediaType(req.headers.get('content-type')) !== 'application/x-www-form-urlencoded') {
    return refuse(log, 'bad_content_type', 'invalid_request');
  }
  const text = await readBodyText(req, MAX_TOKEN_BODY_BYTES);
  if (text === null) return refuse(log, 'bad_body', 'invalid_request');

  const form = parseForm(new URLSearchParams(text), TOKEN_LOG_KEYS);
  Object.assign(log, filterKeys(form.names, TOKEN_LOG_KEYS));
  const p = form.values;
  const grant = p.get('grant_type');
  log.grant = grant === 'authorization_code' || grant === 'refresh_token' ? grant : 'other';

  if (form.duplicates.includes('resource')) return refuse(log, 'duplicate_parameter', 'invalid_target');
  if (form.duplicates.length > 0) return refuse(log, 'duplicate_parameter', 'invalid_request');
  if (p.has('client_secret') || p.has('client_assertion') || p.has('client_assertion_type')) {
    return refuse(log, 'client_credentials', 'invalid_client');
  }

  const clientId = p.get('client_id');
  if (clientId === undefined) return refuse(log, 'missing_client_id', 'invalid_request');
  if (!isClientId(clientId)) return refuse(log, 'bad_client_id', 'invalid_client');

  if (grant === undefined) return refuse(log, 'missing_grant_type', 'invalid_request');
  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return refuse(log, 'unsupported_grant_type', 'unsupported_grant_type');
  }

  const resource = p.get('resource');
  if (resource !== undefined && !canonicalResource(resource, cfg.resource)) {
    return refuse(log, 'bad_resource', 'invalid_target');
  }
  const scope = p.get('scope');
  if (scope !== undefined && normaliseScope(scope) !== 'mcp:read') return refuse(log, 'bad_scope', 'invalid_scope');

  const accessToken = newToken('at');
  const refreshToken = newToken('rt');

  if (grant === 'authorization_code') {
    const code = p.get('code');
    if (code === undefined) return refuse(log, 'missing_code', 'invalid_request');
    if (!isCredential('ac', code)) return refuse(log, 'bad_code', 'invalid_grant');
    const verifier = p.get('code_verifier');
    if (!isCodeVerifier(verifier)) return refuse(log, 'bad_code_verifier', 'invalid_request');
    const result = await exchangeCode(cfg, {
      secret: cfg.secret,
      codeDigest: digest(cfg.pepper, code),
      codeVerifier: verifier,
      clientId,
      redirectUri: p.get('redirect_uri') ?? null,
      resource: cfg.resource,
      atDigest: digest(cfg.pepper, accessToken),
      rtDigest: digest(cfg.pepper, refreshToken),
    });
    return answer(log, result, accessToken, refreshToken);
  }

  const presented = p.get('refresh_token');
  if (presented === undefined) return refuse(log, 'missing_refresh_token', 'invalid_request');
  if (!isCredential('rt', presented)) return refuse(log, 'bad_refresh_token', 'invalid_grant');
  const result = await refreshTokens(cfg, {
    secret: cfg.secret,
    rtDigest: digest(cfg.pepper, presented),
    clientId,
    resource: cfg.resource,
    newAtDigest: digest(cfg.pepper, accessToken),
    newRtDigest: digest(cfg.pepper, refreshToken),
  });
  return answer(log, result, accessToken, refreshToken);
});

export const GET = route.GET;
export const HEAD = route.HEAD;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
