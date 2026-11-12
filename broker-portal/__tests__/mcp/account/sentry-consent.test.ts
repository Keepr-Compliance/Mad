/**
 * @jest-environment node
 *
 * BACKLOG-4238 — Sentry on the consent and AI apps pages, in the REAL server,
 * edge and client configs (init mocked): request data dropped on those paths,
 * the request id after /connect/ replaced by [id], credentials redacted, the
 * client config wired to the shared scrub, emails still scrubbed in the client.
 */

const mockInit = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  init: (...a: unknown[]) => mockInit(...a),
  replayIntegration: () => ({ name: 'Replay' }),
}));

import { PLANTED_PLAIN } from '../oauth/fixtures';

type Rec = Record<string, unknown>;
type Hooks = {
  beforeSend: (_e: Rec) => Rec | null;
  beforeSendTransaction: (_e: Rec) => Rec | null;
  beforeSendSpan: (_s: Rec) => Rec;
  beforeBreadcrumb: (_b: Rec) => Rec | null;
};

const CONFIGS = {
  server: '../../../sentry.server.config',
  edge: '../../../sentry.edge.config',
  client: '../../../sentry.client.config',
} as const;

function loadConfig(file: keyof typeof CONFIGS): Hooks {
  mockInit.mockReset();
  jest.isolateModules(() => {
    require(CONFIGS[file]);
  });
  expect(mockInit).toHaveBeenCalledTimes(1);
  return mockInit.mock.calls[0][0] as Hooks;
}

/** 22 base64url characters, including '-' and '_'. */
const REQUEST_ID = 'Rq4238Rq4238Rq-238_q42';
const ID_TAIL = '-238_q42';
const CONSENT_URL = `https://portal.test/dashboard/account/ai-apps/connect/${REQUEST_ID}`;
const CODE = `kpr_ac_${'K'.repeat(43)}`;
const NONCE_VALUE = 'nonce-value-4238-planted';

describe.each(['server', 'edge', 'client'] as const)('sentry.%s.config on the consent and AI apps pages', (file) => {
  let hooks: Hooks;
  beforeEach(() => {
    hooks = loadConfig(file);
  });

  it('wires all four hooks', () => {
    for (const h of ['beforeSend', 'beforeSendTransaction', 'beforeSendSpan', 'beforeBreadcrumb'] as const) {
      expect(typeof hooks[h]).toBe('function');
    }
  });

  it.each([`${CONSENT_URL}?x=1`, 'https://portal.test/dashboard/account/ai-apps'])(
    'an event from %s loses request data, headers, cookies and query',
    (url) => {
      const out = hooks.beforeSend({
        request: {
          url,
          headers: { cookie: `__Host-kpr_mcp_bind=${PLANTED_PLAIN}` },
          cookies: { '__Host-kpr_mcp_bind': PLANTED_PLAIN },
          data: { nonce: NONCE_VALUE },
          query_string: 'x=1',
        },
        transaction: `/dashboard/account/ai-apps/connect/${REQUEST_ID}`,
      });
      const s = JSON.stringify(out);
      expect(s).not.toContain(PLANTED_PLAIN);
      expect(s).not.toContain(NONCE_VALUE);
      expect(s).not.toContain(REQUEST_ID);
      expect(s).not.toContain(ID_TAIL);
      expect(s).not.toContain('x=1');
    }
  );

  it('the request URL and the transaction name read .../connect/[id]', () => {
    const out = hooks.beforeSend({
      request: { url: CONSENT_URL },
      transaction: `GET /dashboard/account/ai-apps/connect/${REQUEST_ID}`,
    })!;
    expect((out.request as Rec).url).toBe('/dashboard/account/ai-apps/connect/[id]');
    expect(out.transaction).toBe('GET /dashboard/account/ai-apps/connect/[id]');
  });

  it('a navigation breadcrumb to the consent page keeps no id and no query', () => {
    const out = hooks.beforeBreadcrumb({
      category: 'navigation',
      data: { from: '/dashboard/account', to: `/dashboard/account/ai-apps/connect/${REQUEST_ID}?x=1` },
    })!;
    expect((out.data as Rec).to).toBe('/dashboard/account/ai-apps/connect/[id]');
    expect(JSON.stringify(out)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(out)).not.toContain(ID_TAIL);
  });

  it('a breadcrumb carrying an authorization code has it redacted', () => {
    const out = hooks.beforeBreadcrumb({ message: `went to https://callback.example.test/cb?code=${CODE}`, data: { url: `https://callback.example.test/cb?code=${CODE}` } })!;
    expect(JSON.stringify(out)).not.toContain(CODE);
  });

  it('positive: a non-MCP breadcrumb is unchanged, query included', () => {
    const crumb = { category: 'navigation', data: { from: '/dashboard', to: '/dashboard/billing?tab=1' } };
    expect(hooks.beforeBreadcrumb(JSON.parse(JSON.stringify(crumb)))).toEqual(crumb);
  });

  it('a transaction on the consent page has the id replaced in its name and spans', () => {
    const out = hooks.beforeSendTransaction({
      transaction: `/dashboard/account/ai-apps/connect/${REQUEST_ID}`,
      contexts: { trace: { data: { 'url.full': `${CONSENT_URL}?x=1` } } },
      spans: [{ description: `GET /dashboard/account/ai-apps/connect/${REQUEST_ID}?x=1`, data: {} }],
    })!;
    expect(JSON.stringify(out)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(out)).not.toContain(ID_TAIL);
    expect(out.transaction).toBe('/dashboard/account/ai-apps/connect/[id]');
  });
});

describe('sentry.client.config keeps its email scrub', () => {
  it('an email in the message, an exception, a breadcrumb and user.email is replaced', () => {
    const hooks = loadConfig('client');
    const out = hooks.beforeSend({
      message: 'for person-4238@example.test',
      exception: { values: [{ value: 'person-4238@example.test failed' }] },
      breadcrumbs: [{ message: 'person-4238@example.test', data: { who: 'person-4238@example.test' } }],
      user: { email: 'person-4238@example.test' },
      request: { url: 'https://portal.test/dashboard' },
    });
    expect(JSON.stringify(out)).not.toContain('person-4238@example.test');
  });

  it('a breadcrumb on an event that the breadcrumb scrub drops is removed; others are kept', () => {
    const hooks = loadConfig('client');
    const out = hooks.beforeSend({
      request: { url: 'https://portal.test/dashboard' },
      breadcrumbs: [
        { category: 'navigation', data: { to: '/dashboard/billing' } },
        {
          category: 'fetch',
          data: {
            get url() {
              throw new Error('unreadable');
            },
            to: '/oauth/token',
          },
        },
      ],
    })!;
    expect((out.breadcrumbs as Rec[]).length).toBe(1);
  });
});
