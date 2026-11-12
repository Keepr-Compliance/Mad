/**
 * Sentry scrub for the MCP endpoint and /oauth paths (BACKLOG-4237).
 *
 * For an event or transaction whose request is under /api/mcp or /oauth, the
 * request headers, cookies, body and query string are removed. Other events
 * are returned unchanged.
 */

interface ScrubbableEvent {
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    data?: unknown;
    query_string?: unknown;
  };
  transaction?: string;
}

const SCRUBBED_PREFIXES = ['/api/mcp', '/oauth'];

function pathOf(url: string): string | null {
  try {
    return new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return null;
  }
}

function underScrubbedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SCRUBBED_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`));
}

/** The transaction name is "<METHOD> <route>" for server transactions. */
function transactionPath(name: string): string {
  const space = name.indexOf(' ');
  return space >= 0 ? name.slice(space + 1) : name;
}

export function isScrubbedRequestEvent(event: ScrubbableEvent): boolean {
  const url = event.request?.url;
  if (url) {
    const path = pathOf(url);
    if (path === null || underScrubbedPath(path)) return true;
  }
  if (event.transaction && underScrubbedPath(transactionPath(event.transaction))) return true;
  return false;
}

export function scrubMcpRequest<E extends ScrubbableEvent>(event: E): E {
  if (!isScrubbedRequestEvent(event) || !event.request) return event;
  delete event.request.headers;
  delete event.request.cookies;
  delete event.request.data;
  delete event.request.query_string;
  if (event.request.url) {
    const path = pathOf(event.request.url);
    event.request.url = path ?? '[scrubbed]';
  }
  return event;
}
