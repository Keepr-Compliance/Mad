/**
 * Protected resource metadata (RFC 9728) for the MCP endpoint — BACKLOG-4237, BACKLOG-4238.
 *
 * The 401 from /api/mcp names this address in WWW-Authenticate. It is also
 * served at /.well-known/oauth-protected-resource/api/mcp through a rewrite in
 * next.config.mjs. The authorization server is this portal.
 */

import { withOAuthRoute } from '@/lib/mcp/oauth/guard';
import { oauthJson } from '@/lib/mcp/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const route = withOAuthRoute('resource-metadata', ['GET', 'HEAD'], async (_req, cfg) =>
  oauthJson(200, {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: ['mcp:read'],
    bearer_methods_supported: ['header'],
    resource_name: 'Keepr',
  })
);

export const GET = route.GET;
export const HEAD = route.HEAD;
export const POST = route.POST;
export const PUT = route.PUT;
export const PATCH = route.PATCH;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
