/**
 * MCP endpoint configuration (BACKLOG-4237). Read per request so a changed
 * environment takes effect on the next cold start without code changes.
 */

/** The endpoint exists only when MCP_ENABLED is exactly "true". */
export function mcpEnabled(): boolean {
  return process.env.MCP_ENABLED === 'true';
}

/** Public origin of this deployment: MCP_PUBLIC_ORIGIN when set, else the request's own origin. */
export function publicOrigin(req: Request): string {
  const configured = process.env.MCP_PUBLIC_ORIGIN;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(req.url).origin;
}

export const MCP_PATH = '/api/mcp';
export const MCP_RESOURCE_METADATA_PATH = '/api/mcp/resource-metadata';

export function resourceUrl(req: Request): string {
  return `${publicOrigin(req)}${MCP_PATH}`;
}

export function resourceMetadataUrl(req: Request): string {
  return `${publicOrigin(req)}${MCP_RESOURCE_METADATA_PATH}`;
}

/** The authorization server issuer: the Supabase Auth base URL. */
export function authorizationServerIssuer(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  try {
    return `${new URL(base).origin}/auth/v1`;
  } catch {
    return null;
  }
}
