/**
 * OAuth authorization endpoint (RFC 6749 section 4.1.1, OAuth 2.1) — BACKLOG-4238.
 *
 * GET only. The request is checked here first; any failure shows a static page
 * with no database call. A valid request is stored by mcp_authorize_begin and
 * the browser is sent to the consent page with a browser binding cookie. Only
 * the database's invalid_request / invalid_scope answers redirect back to the
 * client, and only to the redirect URI this request sent.
 */

import { bindingDigest, ipDigest, newBinding, toBytea } from '@/lib/mcp/oauth/crypto';
import { bindingFromCookieHeader } from '@/lib/mcp/oauth/binding';
import { clientIp } from '@/lib/mcp/oauth/clientIp';
import { withOAuthRoute, type LogFields } from '@/lib/mcp/oauth/guard';
import { errorPage, found } from '@/lib/mcp/oauth/http';
import { dbCode, errorNameTag } from '@/lib/mcp/oauth/log';
import { BINDING_COOKIE, CONSENT_PATH_PREFIX } from '@/lib/mcp/oauth/paths';
import { clientRedirect } from '@/lib/mcp/oauth/redirect';
import { authorizeBegin } from '@/lib/mcp/oauth/rpc';
import {
  canonicalResource,
  isClientId,
  isRedirectUriShape,
  isRequestId,
  normaliseScope,
  parseForm,
} from '@/lib/mcp/oauth/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY_BYTES = 4096;
const BINDING_MAX_AGE_S = 600;

const AUTHORIZE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'state',
  'resource',
] as const;

function page(log: LogFields, outcome: string, status: 400 | 503): Response {
  log.outcome = outcome;
  return errorPage(status);
}

/** The binding cookie's value when the request carries exactly one well-formed one. */
function existingBinding(req: Request): string | null {
  return bindingFromCookieHeader(req.headers.get('cookie'));
}

function bindingCookie(value: string): string {
  return `${BINDING_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${BINDING_MAX_AGE_S}`;
}

const route = withOAuthRoute(
  'authorize',
  ['GET'],
  async (req, cfg, log) => {
    const search = new URL(req.url).search;
    if (search.length > MAX_QUERY_BYTES + 1) return page(log, 'query_too_long', 400);

    const form = parseForm(new URLSearchParams(search), AUTHORIZE_PARAMS);
    if (form.duplicates.length > 0) return page(log, 'duplicate_parameter', 400);
    const p = form.values;

    const clientId = p.get('client_id');
    if (!isClientId(clientId)) return page(log, 'bad_client_id', 400);
    const redirectUri = p.get('redirect_uri');
    if (!isRedirectUriShape(redirectUri)) return page(log, 'bad_redirect_uri', 400);
    if (p.get('response_type') !== 'code') return page(log, 'bad_response_type', 400);
    const resource = p.get('resource');
    if (resource === undefined || !canonicalResource(resource, cfg.resource)) return page(log, 'bad_resource', 400);

    const state = p.get('state') ?? null;
    const binding = existingBinding(req) ?? newBinding();

    const result = await authorizeBegin(cfg, {
      secret: cfg.secret,
      clientId,
      redirectUri,
      codeChallenge: p.get('code_challenge') ?? null,
      codeChallengeMethod: p.get('code_challenge_method') ?? null,
      resource: cfg.resource,
      scope: normaliseScope(p.get('scope')),
      state,
      bindingSha256: bindingDigest(binding),
      ipSha256: toBytea(ipDigest(cfg.pepper, clientIp(req))),
    });

    switch (result.kind) {
      case 'ok':
        if (!isRequestId(result.requestId)) return page(log, 'bad_request_id', 503);
        log.outcome = 'consent';
        return found(`${cfg.issuer}${CONSENT_PATH_PREFIX}${result.requestId}`, bindingCookie(binding));
      case 'page':
        return page(log, result.error, result.error === 'invalid_client' ? 400 : 503);
      case 'redirect': {
        if (result.redirectUri !== redirectUri) return page(log, 'redirect_mismatch', 503);
        const location = clientRedirect(
          redirectUri,
          [
            ['error', result.error],
            ['state', state],
          ],
          cfg.issuer
        );
        if (location === null) return page(log, 'redirect_refused', 503);
        log.outcome = result.error;
        return found(location);
      }
      case 'transport':
        log.error = `${errorNameTag({ name: result.name })}:${dbCode(result.code)}`;
        return page(log, 'transport', 503);
    }
  },
  { onError: () => errorPage(503) }
);

export const GET = route.GET;
export const HEAD = route.HEAD;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
