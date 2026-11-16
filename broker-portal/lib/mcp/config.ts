/**
 * MCP endpoint configuration (BACKLOG-4237, BACKLOG-4238). Read per request so
 * a changed environment takes effect on the next cold start without code
 * changes.
 */

import { isStrongSecret } from './secretStrength';

/**
 * MCP_PUBLIC_ORIGIN as an origin, or null when it is unset or is not an https
 * origin with no path, query, fragment or credentials.
 */
export function configuredOrigin(): string | null {
  const raw = process.env.MCP_PUBLIC_ORIGIN;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash || raw.includes('?') || raw.includes('#')) return null;
  return url.origin;
}

let weakSecretLogged = false;

/**
 * True when MCP_PORTAL_SECRET is set but fails the strength rule
 * (lib/mcp/secretStrength.ts). An unset secret is reported by oauthConfig()
 * as missing instead.
 */
function portalSecretRefused(): boolean {
  const raw = process.env.MCP_PORTAL_SECRET;
  if (!raw || isStrongSecret(raw)) return false;
  if (!weakSecretLogged) {
    weakSecretLogged = true;
    console.error('[mcp] MCP_PORTAL_SECRET does not meet the strength rule; MCP stays off');
  }
  return true;
}

/**
 * The endpoint exists only when MCP_ENABLED is exactly "true", MCP_PUBLIC_ORIGIN
 * is an https origin, and MCP_PORTAL_SECRET is not a set-but-weak value.
 */
export function mcpEnabled(): boolean {
  return process.env.MCP_ENABLED === 'true' && configuredOrigin() !== null && !portalSecretRefused();
}

/**
 * Public origin of this deployment: MCP_PUBLIC_ORIGIN. There is no fallback to
 * the request's Host. Callers check mcpEnabled() first.
 */
export function publicOrigin(_req: Request): string {
  const origin = configuredOrigin();
  if (origin === null) throw new Error('MCP_PUBLIC_ORIGIN is not configured');
  return origin;
}

export const MCP_PATH = '/api/mcp';
export const MCP_RESOURCE_METADATA_PATH = '/api/mcp/resource-metadata';

export function resourceMetadataUrl(req: Request): string {
  return `${publicOrigin(req)}${MCP_RESOURCE_METADATA_PATH}`;
}
