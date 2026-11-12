/**
 * Responses for the OAuth routes (BACKLOG-4238).
 *
 * Every response carries Cache-Control: no-store; JSON responses also carry
 * Pragma: no-cache. No CORS headers.
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export const ALL_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const;

export function oauthJson(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** A HEAD answer: the GET response's status and headers with no body. */
export function withoutBody(res: Response): Response {
  return new Response(null, { status: res.status, headers: res.headers });
}

export function oauthError(status: number, error: string, extra: Record<string, string> = {}): Response {
  return oauthJson(status, { error }, extra);
}

export function methodNotAllowed(allowed: readonly HttpMethod[]): Response {
  return oauthError(405, 'method_not_allowed', { Allow: allowed.join(', ') });
}
