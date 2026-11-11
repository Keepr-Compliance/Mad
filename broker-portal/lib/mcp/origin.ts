/**
 * Origin check for the MCP endpoint (BACKLOG-4237).
 *
 * A request with no Origin header passes. A request WITH an Origin header
 * passes only when that origin is listed, exactly, in MCP_ALLOWED_ORIGINS
 * (comma-separated). The default list is empty.
 */

export function allowedOrigins(): string[] {
  return (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  return allowedOrigins().includes(origin);
}
