/**
 * OAuth authorization server metadata (RFC 8414) — BACKLOG-4238.
 *
 * Served at /.well-known/oauth-authorization-server through a rewrite in
 * next.config.mjs. No database call. Every value derives from
 * MCP_PUBLIC_ORIGIN, never from the request.
 */

import { withOAuthRoute } from '@/lib/mcp/oauth/guard';
import { oauthJson } from '@/lib/mcp/oauth/http';
import { AUTHORIZE_PATH, REGISTER_PATH, TOKEN_PATH } from '@/lib/mcp/oauth/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const route = withOAuthRoute('metadata', ['GET', 'HEAD'], async (_req, cfg) =>
  oauthJson(200, {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${cfg.issuer}${TOKEN_PATH}`,
    registration_endpoint: `${cfg.issuer}${REGISTER_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:read'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  })
);

export const GET = route.GET;
export const HEAD = route.HEAD;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
