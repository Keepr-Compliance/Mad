/**
 * @jest-environment node
 *
 * BACKLOG-3711: send-ticket-confirmation Edge Function handler.
 *
 * Lives under tests/ (not supabase/functions/**) because jest's CI testMatch
 * runs <rootDir>/tests/** and does not run supabase/functions/**.
 * fetch is injected and fully mocked: no network.
 */

import {
  handleRequest,
  resetWebhookSecretCache,
  timingSafeEqual,
  WEBHOOK_SECRET_HEADER,
  type HandlerDeps,
} from '../../supabase/functions/send-ticket-confirmation/handler';

const SECRET = 'a'.repeat(64);
// pii-allow-uuid: invented test id, not from any live row
const TICKET_ID = '11111111-2222-4333-8444-555555555555';
const STORED = {
  id: TICKET_ID,
  ticket_number: 42,
  subject: 'Stored subject',
  requester_email: 'requester@example.com',
};

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://proj.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  BROKER_PORTAL_URL: 'https://broker.test',
  INTERNAL_API_SECRET: 'internal-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeDeps(opts: { secret?: unknown; secretStatus?: number; rows?: unknown[] } = {}) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/rest/v1/rpc/ticket_webhook_secret')) {
      return jsonResponse(opts.secret === undefined ? SECRET : opts.secret, opts.secretStatus ?? 200);
    }
    if (url.includes('/rest/v1/support_tickets')) {
      return jsonResponse(opts.rows ?? [STORED]);
    }
    if (url === 'https://broker.test/api/email/ticket-confirmation') {
      return jsonResponse({ success: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const deps: HandlerDeps = { getEnv: (n) => ENV[n], fetch: fetchMock as unknown as typeof fetch };
  return { deps, fetchMock };
}

function webhookRequest(headers: Record<string, string>, record: Record<string, unknown> = {}): Request {
  return new Request('https://fn.test/send-ticket-confirmation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      type: 'INSERT',
      record: {
        id: TICKET_ID,
        ticket_number: 42,
        subject: 'Forged subject',
        requester_email: 'victim@evil.test',
        ...record,
      },
    }),
  });
}

function emailCalls(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/email/ticket-confirmation'));
}

beforeEach(() => {
  resetWebhookSecretCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('send-ticket-confirmation handler', () => {
  it('rejects a request with no secret header (401) and sends nothing', async () => {
    const { deps, fetchMock } = makeDeps();
    const res = await handleRequest(webhookRequest({}), deps);
    expect(res.status).toBe(401);
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });

  it('rejects a wrong secret (401) and sends nothing', async () => {
    const { deps, fetchMock } = makeDeps();
    const res = await handleRequest(webhookRequest({ [WEBHOOK_SECRET_HEADER]: 'b'.repeat(64) }), deps);
    expect(res.status).toBe(401);
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });

  it('fails closed when the stored secret cannot be loaded', async () => {
    const { deps, fetchMock } = makeDeps({ secretStatus: 403, secret: { message: 'denied' } });
    const res = await handleRequest(webhookRequest({ [WEBHOOK_SECRET_HEADER]: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });

  it('fails closed when the stored secret is empty', async () => {
    const { deps, fetchMock } = makeDeps({ secret: null });
    const res = await handleRequest(webhookRequest({ [WEBHOOK_SECRET_HEADER]: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });

  it('with the right secret, sends to the STORED requester and subject, not the payload', async () => {
    const { deps, fetchMock } = makeDeps();
    const res = await handleRequest(webhookRequest({ [WEBHOOK_SECRET_HEADER]: SECRET }), deps);
    expect(res.status).toBe(200);
    const calls = emailCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-secret']).toBe('internal-secret');
    expect(JSON.parse(String(init.body))).toEqual({
      ticketId: TICKET_ID,
      ticketNumber: 'TKT-0042',
      ticketSubject: 'Stored subject',
      requesterEmail: 'requester@example.com',
      ticketLink: `https://broker.test/dashboard/support/${TICKET_ID}`,
    });
  });

  it('skips when the ticket id does not exist', async () => {
    const { deps, fetchMock } = makeDeps({ rows: [] });
    const res = await handleRequest(webhookRequest({ [WEBHOOK_SECRET_HEADER]: SECRET }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'ticket not found' });
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });

  it('skips a non-uuid ticket id without querying', async () => {
    const { deps, fetchMock } = makeDeps();
    const res = await handleRequest(
      webhookRequest({ [WEBHOOK_SECRET_HEADER]: SECRET }, { id: 'x&select=*' }),
      deps
    );
    expect(await res.json()).toEqual({ skipped: true, reason: 'missing ticket id' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('support_tickets'))).toBe(false);
  });

  it('rejects non-POST methods', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(new Request('https://fn.test/x', { method: 'GET' }), deps);
    expect(res.status).toBe(405);
  });
});

describe('timingSafeEqual', () => {
  it.each([
    ['abc', 'abc', true],
    ['abc', 'abd', false],
    ['abc', 'abcd', false],
    ['abcd', 'abc', false],
    ['', 'a', false],
    ['', '', true],
  ])('%p vs %p -> %p', (a, b, expected) => {
    expect(timingSafeEqual(a, b)).toBe(expected);
  });
});
