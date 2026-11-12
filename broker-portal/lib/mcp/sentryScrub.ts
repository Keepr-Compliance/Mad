/**
 * Sentry scrub for the MCP endpoint and the OAuth server (BACKLOG-4237, BACKLOG-4238).
 *
 * - Request events under /api/mcp or /oauth (or /.well-known/oauth-*): request
 *   headers, cookies, body, query string and env are removed; the URL is
 *   reduced to its path.
 * - Every event: Keepr OAuth credentials are redacted from exception values,
 *   message, logentry, extra and tags.
 * - Breadcrumbs and spans: an MCP URL loses its query; credentials are
 *   redacted everywhere.
 * - Each hook catches its own failure. On an MCP event it fails closed (the
 *   event or breadcrumb is dropped, a span's data is cleared); otherwise the
 *   input is returned unchanged, except that scrubEvent with
 *   `dropOnFailure` drops every event whose processing throws.
 *
 * Loaded by the edge config too: no Node APIs.
 */

import { redactKpr } from './oauth/redact';

interface ScrubbableEvent {
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  transaction?: string;
}

const SCRUBBED_PREFIXES = ['/api/mcp', '/oauth'];
const WELL_KNOWN_OAUTH_PREFIX = '/.well-known/oauth-';
const RPC_PATH_MARKER = '/rest/v1/rpc/mcp_';

const MAX_DEPTH = 10;

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

/** A path or URL of the MCP endpoint, the OAuth server, its discovery documents, or an outgoing mcp_ RPC. */
export function isMcpPath(urlOrPath: string): boolean {
  const path = pathOf(urlOrPath);
  if (path === null) return false;
  const lower = path.toLowerCase();
  return underScrubbedPath(path) || lower.startsWith(WELL_KNOWN_OAUTH_PREFIX) || lower.includes(RPC_PATH_MARKER);
}

/**
 * A transaction name is scrubbed when ANY whitespace-separated token of it is
 * an MCP path: "GET /oauth/token", "middleware GET /oauth/authorize", "/oauth/register".
 */
export function isMcpTransactionName(name: string): boolean {
  return name
    .split(/\s+/)
    .filter((t) => t.startsWith('/') || /^https?:\/\//i.test(t))
    .some((t) => isMcpPath(t));
}

export function isScrubbedRequestEvent(event: ScrubbableEvent): boolean {
  const url = event.request?.url;
  if (url) {
    const path = pathOf(url);
    if (path === null || isMcpPath(url)) return true;
  }
  if (event.transaction && isMcpTransactionName(event.transaction)) return true;
  return false;
}

export function scrubMcpRequest<E extends ScrubbableEvent>(event: E): E {
  if (!isScrubbedRequestEvent(event) || !event.request) return event;
  delete event.request.headers;
  delete event.request.cookies;
  delete event.request.data;
  delete event.request.query_string;
  delete event.request.env;
  if (event.request.url) {
    const path = pathOf(event.request.url);
    event.request.url = path ?? '[scrubbed]';
  }
  return event;
}

/** Entries copied per object or array; Sentry's own normalisation keeps 1000 by default. */
const MAX_BREADTH = 1000;
/** Objects and arrays copied per redactDeep call, so shared references cannot multiply the work. */
const MAX_NODES = 5000;

const TRUNCATED = '[truncated]';

/**
 * Copy of `value` with every string passed through redactKpr. Depth-, breadth-
 * and size-limited; only a reference back to an ancestor is a cycle
 * ('[circular]'), so a value shared by two siblings is copied twice; a
 * property whose read throws becomes '[unreadable]'.
 */
export function redactDeep(value: unknown): unknown {
  return redactNode(value, 0, new WeakSet(), { nodes: 0 });
}

function redactNode(value: unknown, depth: number, ancestors: WeakSet<object>, budget: { nodes: number }): unknown {
  if (typeof value === 'string') return redactKpr(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (ancestors.has(value)) return '[circular]';
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return TRUNCATED;
  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      const out = value.slice(0, MAX_BREADTH).map((v) => redactNode(v, depth + 1, ancestors, budget));
      if (value.length > MAX_BREADTH) out.push(TRUNCATED);
      return out;
    } finally {
      ancestors.delete(value);
    }
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  ancestors.add(value);
  try {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_BREADTH)) {
      let v: unknown;
      try {
        v = (value as Record<string, unknown>)[key];
      } catch {
        out[redactKpr(key)] = '[unreadable]';
        continue;
      }
      out[redactKpr(key)] = redactNode(v, depth + 1, ancestors, budget);
    }
    if (keys.length > MAX_BREADTH) out[TRUNCATED] = keys.length - MAX_BREADTH;
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function stripQuery(value: string): string {
  const q = value.indexOf('?');
  return q >= 0 ? value.slice(0, q) : value;
}

/** Strips the query from every URL- or path-valued string in an MCP span's or breadcrumb's data. */
function stripMcpQueries(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(data)) {
    const k = key.toLowerCase();
    if (k === 'url.query' || k === 'http.query') continue;
    if (typeof v === 'string' && v.includes('?') && (v.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(v))) {
      out[key] = stripQuery(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function descriptionTokensMcp(description: unknown): boolean {
  return typeof description === 'string' && isMcpTransactionName(description);
}

function dataHasMcpUrl(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return Object.values(data as Record<string, unknown>).some(
    (v) => typeof v === 'string' && (v.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) && isMcpPath(v)
  );
}

function stripDescriptionQueries(description: string): string {
  return description
    .split(/(\s+)/)
    .map((t) => (isMcpPath(t) ? stripQuery(t) : t))
    .join('');
}

type Rec = Record<string, unknown>;

/** Redacts credentials from the free-text fields of any event. */
function redactEventFields(event: Rec): void {
  if (typeof event.message === 'string') event.message = redactKpr(event.message);
  const logentry = event.logentry as Rec | undefined;
  if (logentry && typeof logentry.message === 'string') logentry.message = redactKpr(logentry.message);
  if (logentry && Array.isArray(logentry.params)) logentry.params = redactDeep(logentry.params);
  const values = (event.exception as { values?: Rec[] } | undefined)?.values;
  if (Array.isArray(values)) {
    for (const ex of values) {
      if (typeof ex.value === 'string') ex.value = redactKpr(ex.value);
    }
  }
  if (event.extra) event.extra = redactDeep(event.extra);
  if (event.tags) event.tags = redactDeep(event.tags);
}

function mcpEventOrUnknown(event: unknown): boolean {
  try {
    return isScrubbedRequestEvent(event as ScrubbableEvent);
  } catch {
    return true;
  }
}

export interface ScrubEventOptions {
  /** Drop the event when processing throws, MCP or not. */
  dropOnFailure?: boolean;
}

/**
 * beforeSend body: request scrub plus credential redaction. Fails closed on an
 * MCP event; with `dropOnFailure`, on every event.
 */
export function scrubEvent<E>(event: E, more?: (_e: E) => E | null, options: ScrubEventOptions = {}): E | null {
  try {
    scrubMcpRequest(event as ScrubbableEvent);
    redactEventFields(event as Rec);
    return more ? more(event) : event;
  } catch {
    if (options.dropOnFailure) return null;
    return mcpEventOrUnknown(event) ? null : event;
  }
}

function scrubSpanData(span: Rec, mcp: boolean): void {
  const data = span.data;
  if (data && typeof data === 'object') {
    const stripped = mcp ? stripMcpQueries(data as Rec) : (data as Rec);
    span.data = redactDeep(stripped);
  }
  if (typeof span.description === 'string') {
    span.description = redactKpr(mcp ? stripDescriptionQueries(span.description) : span.description);
  }
}

function spanIsMcp(span: Rec): boolean {
  return descriptionTokensMcp(span.description) || dataHasMcpUrl(span.data);
}

/** beforeSendTransaction body. Fails closed (drops) on an MCP transaction. */
export function scrubTransaction<E>(event: E): E | null {
  try {
    scrubMcpRequest(event as ScrubbableEvent);
    const ev = event as Rec;
    const txMcp = isScrubbedRequestEvent(event as ScrubbableEvent);
    const trace = (ev.contexts as Rec | undefined)?.trace as Rec | undefined;
    if (trace) scrubSpanData(trace, txMcp || dataHasMcpUrl(trace.data));
    if (Array.isArray(ev.spans)) {
      for (const span of ev.spans as Rec[]) scrubSpanData(span, txMcp || spanIsMcp(span));
    }
    redactEventFields(ev);
    return event;
  } catch {
    return mcpEventOrUnknown(event) ? null : event;
  }
}

/** beforeSendSpan body. Always returns the span; on failure an MCP span's data is cleared. */
export function scrubSpan<S>(span: S): S {
  const s = span as unknown as Rec;
  let mcp = true;
  try {
    mcp = spanIsMcp(s);
    scrubSpanData(s, mcp);
    return span;
  } catch {
    if (mcp) {
      try {
        s.data = {};
        delete s.description;
      } catch {
        // nothing more can be done; the span is still returned
      }
    }
    return span;
  }
}

function breadcrumbIsMcp(crumb: Rec): boolean {
  const data = crumb.data as Rec | undefined;
  if (!data) return false;
  return ['url', 'to', 'from'].some((k) => typeof data[k] === 'string' && isMcpPath(data[k] as string));
}

/** beforeBreadcrumb body. Fails closed (drops) on an MCP breadcrumb. */
export function scrubBreadcrumb<B>(crumb: B): B | null {
  const c = crumb as unknown as Rec;
  let mcp = true;
  try {
    mcp = breadcrumbIsMcp(c);
    if (typeof c.message === 'string') c.message = redactKpr(c.message);
    if (c.data && typeof c.data === 'object') {
      const data = c.data as Rec;
      if (mcp) {
        for (const k of ['url', 'to', 'from']) {
          if (typeof data[k] === 'string') data[k] = stripQuery(data[k] as string);
        }
      }
      c.data = redactDeep(data);
    }
    return crumb;
  } catch {
    return mcp ? null : crumb;
  }
}
