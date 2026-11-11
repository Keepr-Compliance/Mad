/**
 * MCP endpoint — BACKLOG-4237.
 *
 * Order of checks: MCP_ENABLED (404) → method (405 for anything but POST) →
 * Origin (403) → Bearer token with a client_id claim (401) → SDK handler.
 */

import { mcpEnabled, resourceMetadataUrl } from '@/lib/mcp/config';
import {
  mcpForbiddenOrigin,
  mcpMethodNotAllowed,
  mcpNotFound,
  mcpUnauthorized,
  mcpUnavailable,
} from '@/lib/mcp/errors';
import { isOriginAllowed } from '@/lib/mcp/origin';
import { getMcpHandler } from '@/lib/mcp/server';
import { bearerToken, verifyMcpToken } from '@/lib/mcp/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!mcpEnabled()) return mcpNotFound();
  if (!isOriginAllowed(req.headers.get('origin'))) return mcpForbiddenOrigin();

  const token = bearerToken(req);
  if (!token) return mcpUnauthorized(resourceMetadataUrl(req));

  const verified = await verifyMcpToken(token);
  if (!verified.ok) {
    if (verified.reason === 'unavailable') return mcpUnavailable();
    return mcpUnauthorized(resourceMetadataUrl(req), 'invalid_token');
  }

  try {
    return await getMcpHandler().fetch(req, { authInfo: verified.authInfo });
  } catch (err) {
    console.error('[mcp] request failed:', (err as Error).name);
    return mcpUnavailable();
  }
}

function notPost(_req: Request): Response {
  return mcpEnabled() ? mcpMethodNotAllowed() : mcpNotFound();
}

export const GET = notPost;
export const PUT = notPost;
export const PATCH = notPost;
export const DELETE = notPost;
// Next answers OPTIONS itself (204) unless the route exports it.
export const OPTIONS = notPost;
