/**
 * @jest-environment node
 *
 * BACKLOG-4238 — Sentry hooks in the REAL server and edge configs (init mocked).
 * Controls H17, H18, H24a, H24b, H25, H26 and the fail-closed cases.
 *
 * Shapes from the installed @sentry/core 10.76.2 types: ErrorEvent (message,
 * logentry, exception.values[].value, extra, tags, request.env), Breadcrumb
 * (message, data), SpanJSON (data, description), transaction contexts.trace.data
 * and spans[].
 */

const mockInit = jest.fn();
jest.mock('@sentry/nextjs', () => ({ init: (...a: unknown[]) => mockInit(...a) }));

import { PLANTED_KPR, PLANTED_PLAIN } from './fixtures';

type Rec = Record<string, unknown>;
type Hooks = {
  beforeSend: (_e: Rec) => Rec | null;
  beforeSendTransaction: (_e: Rec) => Rec | null;
  beforeSendSpan: (_s: Rec) => Rec;
  beforeBreadcrumb: (_b: Rec) => Rec | null;
};

function loadConfig(file: 'server' | 'edge'): Hooks {
  mockInit.mockReset();
  jest.isolateModules(() => {
    require(file === 'server' ? '../../../sentry.server.config' : '../../../sentry.edge.config');
  });
  expect(mockInit).toHaveBeenCalledTimes(1);
  return mockInit.mock.calls[0][0] as Hooks;
}

const KPR2 = `kpr_at_${'Q'.repeat(43)}`;

describe.each(['server', 'edge'] as const)('sentry.%s.config', (file) => {
  let hooks: Hooks;
  beforeEach(() => {
    hooks = loadConfig(file);
  });

  it('wires all four hooks', () => {
    for (const h of ['beforeSend', 'beforeSendTransaction', 'beforeSendSpan', 'beforeBreadcrumb'] as const) {
      expect(typeof hooks[h]).toBe('function');
    }
  });

  describe('H17: request scrub covers every OAuth route', () => {
    it.each([
      `https://portal.test/oauth/token?refresh_token=${PLANTED_PLAIN}`,
      `https://portal.test/oauth/register?x=${PLANTED_PLAIN}`,
      `https://portal.test/oauth/authorize?state=${PLANTED_PLAIN}`,
      `https://portal.test/oauth/metadata?x=${PLANTED_PLAIN}`,
      `https://portal.test/.well-known/oauth-authorization-server?x=${PLANTED_PLAIN}`,
      `https://portal.test/.well-known/oauth-protected-resource/api/mcp?x=${PLANTED_PLAIN}`,
    ])('%s', (url) => {
      const ev = {
        request: { url, headers: { cookie: PLANTED_PLAIN }, data: PLANTED_PLAIN, query_string: PLANTED_PLAIN, env: { REMOTE_ADDR: '203.0.113.7' } },
      };
      const out = hooks.beforeSend(ev);
      expect(JSON.stringify(out)).not.toContain(PLANTED_PLAIN);
      expect(JSON.stringify(out)).not.toContain('203.0.113.7');
    });
  });

  describe('H24a: request.env', () => {
    it('is removed on a scrubbed event', () => {
      const out = hooks.beforeSend({ request: { url: 'https://portal.test/oauth/token', env: { REMOTE_ADDR: '203.0.113.7' } } });
      expect((out!.request as Rec).env).toBeUndefined();
    });
    it('positive: is kept on another event', () => {
      const out = hooks.beforeSend({ request: { url: 'https://portal.test/dashboard', env: { REMOTE_ADDR: '203.0.113.7' } } });
      expect((out!.request as Rec).env).toEqual({ REMOTE_ADDR: '203.0.113.7' });
    });
  });

  describe('H18: credentials redacted on every event', () => {
    it.each(['https://portal.test/dashboard', 'https://portal.test/oauth/token'])('event from %s', (url) => {
      const ev = {
        request: { url },
        message: `m ${PLANTED_KPR}`,
        logentry: { message: `l ${PLANTED_KPR}`, params: [KPR2] },
        exception: { values: [{ type: 'Error', value: `v ${PLANTED_KPR}` }] },
        extra: { a: { b: [`x ${KPR2}`] } },
        tags: { t: `t ${PLANTED_KPR}` },
      };
      const out = hooks.beforeSend(ev)!;
      const text = JSON.stringify(out);
      expect(text).not.toContain(PLANTED_KPR);
      expect(text).not.toContain(KPR2);
      expect(out.message).toBe('m [redacted]');
      expect((out.logentry as Rec).message).toBe('l [redacted]');
      expect(((out.exception as Rec).values as Rec[])[0].value).toBe('v [redacted]');
      expect(out.tags).toEqual({ t: 't [redacted]' });
    });

    it('positive: an event with no credential is unchanged in content', () => {
      const ev = { request: { url: 'https://portal.test/dashboard' }, message: 'plain', extra: { a: 1, b: ['x'] }, tags: { t: 'v' } };
      expect(hooks.beforeSend(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
    });

    it('a cyclic extra and a throwing getter do not throw and are still redacted', () => {
      const extra: Rec = { k: PLANTED_KPR };
      extra.self = extra;
      Object.defineProperty(extra, 'bad', {
        enumerable: true,
        get() {
          throw new Error(PLANTED_PLAIN);
        },
      });
      const out = hooks.beforeSend({ request: { url: 'https://portal.test/dashboard' }, message: 'x', extra });
      expect(out).not.toBeNull();
      expect((out!.extra as Rec).self).toBe('[circular]');
      expect((out!.extra as Rec).bad).toBe('[unreadable]');
      const text = JSON.stringify(out);
      expect(text).not.toContain(PLANTED_KPR);
      expect(text).not.toContain(PLANTED_PLAIN);
    });
  });

  describe('H24b: breadcrumbs', () => {
    it.each([
      ['url', `https://project-ref.supabase.co/rest/v1/rpc/mcp_register_client?x=${PLANTED_PLAIN}`],
      ['url', `https://portal.test/oauth/token?refresh_token=${PLANTED_PLAIN}`],
      ['to', `/oauth/authorize?state=${PLANTED_PLAIN}`],
      ['from', `/oauth/authorize?state=${PLANTED_PLAIN}`],
    ])('an MCP %s loses its query', (key, value) => {
      const out = hooks.beforeBreadcrumb({ category: 'fetch', data: { [key]: value, method: 'POST' } })!;
      expect(JSON.stringify(out)).not.toContain(PLANTED_PLAIN);
      expect((out.data as Rec)[key]).toBe(value.slice(0, value.indexOf('?')));
    });

    it('a credential in the message or any data string is redacted', () => {
      const out = hooks.beforeBreadcrumb({ message: `m ${PLANTED_KPR}`, data: { nested: { v: [KPR2] }, url: 'https://x.example/a' } })!;
      expect(JSON.stringify(out)).not.toContain(PLANTED_KPR);
      expect(JSON.stringify(out)).not.toContain(KPR2);
    });

    it('positive: a non-MCP breadcrumb is unchanged, query included', () => {
      const crumb = { category: 'fetch', message: 'GET', data: { url: 'https://api.example/x?page=2', status_code: 200 } };
      expect(hooks.beforeBreadcrumb(JSON.parse(JSON.stringify(crumb)))).toEqual(crumb);
    });

    it('cyclic data and a throwing getter do not throw', () => {
      const data: Rec = { url: `https://portal.test/oauth/token?x=${PLANTED_PLAIN}`, k: PLANTED_KPR };
      data.self = data;
      Object.defineProperty(data, 'bad', {
        enumerable: true,
        get() {
          throw new Error('getter');
        },
      });
      const out = hooks.beforeBreadcrumb({ data });
      expect(out).not.toBeNull();
      expect((out!.data as Rec).self).toBe('[circular]');
      expect(JSON.stringify(out)).not.toContain(PLANTED_PLAIN);
      expect(JSON.stringify(out)).not.toContain(PLANTED_KPR);
    });

    it('fails closed: a breadcrumb whose processing throws is dropped when it is MCP', () => {
      const crumb: Rec = { data: { url: `https://portal.test/oauth/token?x=${PLANTED_PLAIN}` } };
      Object.defineProperty(crumb, 'message', {
        get() {
          throw new Error('getter');
        },
      });
      expect(hooks.beforeBreadcrumb(crumb)).toBeNull();
    });
  });

  describe('H25: transactions and spans', () => {
    function tx(name: string, url: string) {
      return {
        type: 'transaction',
        transaction: name,
        contexts: { trace: { data: { 'url.full': url, 'url.query': `refresh_token=${PLANTED_PLAIN}`, 'http.target': url.replace(/^https:\/\/[^/]+/, ''), k: PLANTED_KPR } } },
        spans: [
          { description: `POST ${url}`, data: { 'http.url': url, 'url.query': PLANTED_PLAIN, 'http.query': PLANTED_PLAIN } },
          { description: `POST https://project-ref.supabase.co/rest/v1/rpc/mcp_register_client?x=${PLANTED_PLAIN}`, data: { 'url.full': `https://project-ref.supabase.co/rest/v1/rpc/mcp_register_client?x=${PLANTED_PLAIN}` } },
        ],
      };
    }

    it('an /oauth/token transaction has no query or credential in trace data or span data', () => {
      const out = hooks.beforeSendTransaction(tx('POST /oauth/token', `https://portal.test/oauth/token?refresh_token=${PLANTED_PLAIN}`))!;
      expect(out).not.toBeNull();
      const text = JSON.stringify(out);
      expect(text).not.toContain(PLANTED_PLAIN);
      expect(text).not.toContain(PLANTED_KPR);
      const trace = (out.contexts as Rec).trace as Rec;
      expect((trace.data as Rec)['url.full']).toBe('https://portal.test/oauth/token');
      expect((trace.data as Rec)['url.query']).toBeUndefined();
    });

    it('an outgoing mcp_ RPC span loses its query inside a non-MCP transaction', () => {
      const out = hooks.beforeSendTransaction(tx('GET /dashboard', 'https://portal.test/dashboard?page=2'))!;
      const spans = out.spans as Rec[];
      expect(JSON.stringify(spans[1])).not.toContain(PLANTED_PLAIN);
      // positive: the non-MCP span and trace keep their query
      expect((spans[0].data as Rec)['http.url']).toBe('https://portal.test/dashboard?page=2');
      expect((((out.contexts as Rec).trace as Rec).data as Rec)['url.full']).toBe('https://portal.test/dashboard?page=2');
    });

    it('a child span of an MCP transaction loses the query in its data even when the span does not name an MCP path', () => {
      const ev = tx('POST /oauth/token', 'https://portal.test/oauth/token');
      (ev.spans as Rec[]).push({
        description: 'GET cache lookup',
        data: { 'http.url': `https://cache.example/lookup?k=${PLANTED_PLAIN}`, 'url.query': `k=${PLANTED_PLAIN}` },
      });
      const out = hooks.beforeSendTransaction(ev)!;
      const child = (out.spans as Rec[])[2];
      expect(JSON.stringify(child)).not.toContain(PLANTED_PLAIN);
      expect((child.data as Rec)['http.url']).toBe('https://cache.example/lookup');
      expect((child.data as Rec)['url.query']).toBeUndefined();
    });

    it('beforeSendSpan strips an MCP span and leaves a non-MCP span unchanged', () => {
      const mcp = hooks.beforeSendSpan({
        description: `GET /oauth/authorize?state=${PLANTED_PLAIN}`,
        data: { 'url.full': `https://portal.test/oauth/authorize?state=${PLANTED_PLAIN}`, 'url.query': PLANTED_PLAIN, k: KPR2 },
      });
      expect(mcp).toBeTruthy();
      expect(JSON.stringify(mcp)).not.toContain(PLANTED_PLAIN);
      expect(JSON.stringify(mcp)).not.toContain(KPR2);
      const other = { description: 'GET /dashboard?page=2', data: { 'url.full': 'https://portal.test/dashboard?page=2', 'url.query': 'page=2' } };
      expect(hooks.beforeSendSpan(JSON.parse(JSON.stringify(other)))).toEqual(other);
    });

    it('beforeSendSpan always returns the span; on failure an MCP span has its data cleared', () => {
      const span: Rec = { data: { 'url.full': `https://portal.test/oauth/token?x=${PLANTED_PLAIN}` } };
      Object.defineProperty(span, 'description', {
        configurable: true,
        get() {
          throw new Error('getter');
        },
      });
      const out = hooks.beforeSendSpan(span);
      expect(out).toBe(span);
      expect(out.data).toEqual({});
    });

    it('fails closed: an MCP transaction whose processing throws is dropped', () => {
      const ev = tx('POST /oauth/token', 'https://portal.test/oauth/token');
      Object.defineProperty(ev, 'spans', {
        get() {
          throw new Error('getter');
        },
      });
      expect(hooks.beforeSendTransaction(ev)).toBeNull();
    });

    it('positive: a non-MCP transaction whose processing throws is returned', () => {
      const ev = tx('GET /dashboard', 'https://portal.test/dashboard');
      Object.defineProperty(ev, 'spans', {
        get() {
          throw new Error('getter');
        },
      });
      expect(hooks.beforeSendTransaction(ev)).toBe(ev);
    });
  });

  describe('H26: transaction names', () => {
    it.each(['GET /oauth/token', 'middleware GET /oauth/authorize', '/oauth/register', 'POST /api/mcp', 'GET /.well-known/oauth-authorization-server'])(
      '%p is scrubbed',
      (name) => {
        const out = hooks.beforeSendTransaction({ transaction: name, request: { headers: { cookie: PLANTED_PLAIN } } })!;
        expect(JSON.stringify(out)).not.toContain(PLANTED_PLAIN);
      }
    );
    it.each(['GET /oauthx', 'GET /dashboard', 'middleware GET /dashboard'])('positive: %p is kept', (name) => {
      const out = hooks.beforeSendTransaction({ transaction: name, request: { headers: { cookie: PLANTED_PLAIN } } })!;
      expect(((out.request as Rec).headers as Rec).cookie).toBe(PLANTED_PLAIN);
    });
  });

  describe('fail closed: beforeSend', () => {
    it('an MCP event whose processing throws is dropped', () => {
      const ev: Rec = { request: { url: 'https://portal.test/oauth/token' } };
      Object.defineProperty(ev, 'message', {
        get() {
          throw new Error('getter');
        },
      });
      expect(hooks.beforeSend(ev)).toBeNull();
    });
    it('another event whose processing throws is dropped', () => {
      const ev: Rec = { request: { url: 'https://portal.test/dashboard' } };
      Object.defineProperty(ev, 'message', {
        get() {
          throw new Error('getter');
        },
      });
      expect(hooks.beforeSend(ev)).toBeNull();
    });

    it('positive: another event that does not throw is returned', () => {
      const ev: Rec = { request: { url: 'https://portal.test/dashboard' }, message: 'plain' };
      expect(hooks.beforeSend(ev)).toBe(ev);
    });
  });

  describe('events that cannot be classified', () => {
    function unreadableRequest(ev: Rec): Rec {
      Object.defineProperty(ev, 'request', {
        get() {
          throw new Error('getter');
        },
      });
      return ev;
    }

    it('a transaction whose request cannot be read is dropped', () => {
      expect(hooks.beforeSendTransaction(unreadableRequest({ type: 'transaction', transaction: 'GET /dashboard' }))).toBeNull();
    });

    it('an event whose request cannot be read is dropped', () => {
      expect(hooks.beforeSend(unreadableRequest({ message: 'x' }))).toBeNull();
    });
  });
});

describe('sentry.server.config breadcrumbs on an event', () => {
  let hooks: Hooks;
  beforeEach(() => {
    hooks = loadConfig('server');
  });

  it('a breadcrumb that the breadcrumb scrub drops is removed from the event; others are kept', () => {
    const dropped: Rec = { category: 'fetch', data: { url: `https://portal.test/oauth/token?x=${PLANTED_PLAIN}` } };
    let reads = 0;
    let message = 'GET';
    Object.defineProperty(dropped, 'message', {
      enumerable: true,
      get() {
        reads += 1;
        if (reads === 1) throw new Error('getter');
        return message;
      },
      set(v: string) {
        message = v;
      },
    });
    const kept: Rec = { category: 'fetch', message: 'GET', data: { url: 'https://api.example/x?page=2' } };
    const out = hooks.beforeSend({ request: { url: 'https://portal.test/dashboard' }, breadcrumbs: [dropped, kept] });
    expect(out).not.toBeNull();
    const crumbs = out!.breadcrumbs as Rec[];
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toBe(kept);
    expect((crumbs[0].data as Rec).url).toBe('https://api.example/x?page=2');
    expect(JSON.stringify(out)).not.toContain(PLANTED_PLAIN);
  });
});
