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

const PAGE_TEXT: Record<400 | 503, string> = {
  400: 'This connection request is not valid. Go back to the app you came from and start again.\n',
  503: 'Keepr cannot take this connection request right now. Try again in a few minutes.\n',
};

/** A static plain-text page for the browser-facing authorize route. It never contains request values. */
export function errorPage(status: 400 | 503): Response {
  return new Response(PAGE_TEXT[status], {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** A 302 to `location`, with an optional Set-Cookie value. */
export function found(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers });
}

/**
 * The body as text, or null when it is longer than `limit` bytes (declared or
 * streamed) or is not valid UTF-8.
 */
export async function readBodyText(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The media type of a Content-Type value, lowercased, without parameters. */
export function mediaType(value: string | null): string | null {
  if (!value) return null;
  return value.split(';')[0].trim().toLowerCase();
}
