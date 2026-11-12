/**
 * Fixed HTTP responses for the MCP endpoint (BACKLOG-4237).
 *
 * Bodies are static strings. None of these responses carries a CORS header.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

function json(status: number, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export function mcpNotFound(): Response {
  return json(404, 'not_found');
}

export function mcpMethodNotAllowed(): Response {
  return json(405, 'method_not_allowed', { Allow: 'POST' });
}

export function mcpForbiddenOrigin(): Response {
  return json(403, 'forbidden_origin');
}

/** 401 that tells an MCP client where to start sign-in (RFC 9728 section 5.1). */
export function mcpUnauthorized(resourceMetadataUrl: string, error?: 'invalid_token'): Response {
  const params = [`resource_metadata="${resourceMetadataUrl}"`];
  if (error) params.unshift(`error="${error}"`);
  return json(401, error ?? 'unauthorized', { 'WWW-Authenticate': `Bearer ${params.join(', ')}` });
}

export function mcpUnavailable(): Response {
  return json(503, 'unavailable');
}
