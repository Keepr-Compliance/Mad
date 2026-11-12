/**
 * Protected resource metadata (RFC 9728) for the MCP endpoint — BACKLOG-4237.
 *
 * Served under /api/mcp; the 401 from /api/mcp names this address in
 * WWW-Authenticate, so no well-known path is needed.
 */

import { authorizationServerIssuer, mcpEnabled, resourceUrl } from '@/lib/mcp/config';
import { mcpNotFound, mcpUnavailable } from '@/lib/mcp/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!mcpEnabled()) return mcpNotFound();
  const issuer = authorizationServerIssuer();
  if (!issuer) return mcpUnavailable();

  return new Response(
    JSON.stringify({
      resource: resourceUrl(req),
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Keepr',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}
