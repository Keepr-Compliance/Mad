/**
 * BACKLOG-3703: /api/support/notify is staff-only and builds the outgoing
 * email from the ticket row. fetch and Supabase are mocked: no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  user: null as null | { id: string; user_metadata?: Record<string, unknown> },
  hasPerm: true as unknown,
  ticket: null as null | Record<string, unknown>,
  agents: [] as Array<{ user_id: string; email: string }>,
  rpcCalls: [] as Array<[string, unknown]>,
  eqCalls: [] as Array<[string, unknown]>,
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: vi.fn(async () => ({
    user: state.user,
    supabase: {
      rpc: vi.fn(async (name: string, args: unknown) => {
        state.rpcCalls.push([name, args]);
        if (name === 'has_permission') return { data: state.hasPerm, error: null };
        if (name === 'support_list_agents') return { data: state.agents, error: null };
        return { data: null, error: { message: 'unexpected rpc' } };
      }),
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn((col: string, val: unknown) => {
            state.eqCalls.push([col, val]);
            return { maybeSingle: vi.fn(async () => ({ data: state.ticket, error: null })) };
          }),
        })),
      })),
    },
  })),
}));

import { POST } from '../route';

// pii-allow-uuid: invented test id, not from any live row
const TICKET_ID = '11111111-2222-4333-8444-555555555555';
const STAFF = { id: 'staff-1', user_metadata: { full_name: 'Sam Staff' } };

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://admin.test/api/support/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sent(): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  };
}

const FORGED = {
  ticketId: TICKET_ID,
  ticketNumber: 'TKT-9999',
  ticketSubject: 'Forged subject',
  requesterEmail: 'victim@evil.test',
  customerEmail: 'victim@evil.test',
  agentEmail: 'victim@evil.test',
  ticketLink: 'https://evil.test/phish',
  ticketUrl: 'https://evil.test/phish',
  newStatus: 'resolved',
};

beforeEach(() => {
  state.user = STAFF;
  state.hasPerm = true;
  state.ticket = {
    id: TICKET_ID,
    ticket_number: 12,
    subject: 'Stored subject',
    status: 'open',
    priority: 'high',
    requester_email: 'customer@example.com',
    requester_name: 'Casey Customer',
    assignee_id: 'agent-1',
  };
  state.agents = [{ user_id: 'agent-1', email: 'agent@keepr.test' }];
  state.rpcCalls = [];
  state.eqCalls = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  process.env.BROKER_PORTAL_URL = 'https://broker-internal.test';
  process.env.INTERNAL_API_SECRET = 'secret-xyz';
  process.env.NEXT_PUBLIC_BROKER_PORTAL_URL = 'https://app.test';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/support/notify — auth', () => {
  it('returns 401 when not signed in, and forwards nothing', async () => {
    state.user = null;
    const res = await POST(req({ type: 'confirmation', ...FORGED }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a signed-in user without support.view, and forwards nothing', async () => {
    state.hasPerm = false;
    const res = await POST(req({ type: 'confirmation', ...FORGED }));
    expect(res.status).toBe(403);
    expect(state.rpcCalls[0]).toEqual([
      'has_permission',
      { check_user_id: 'staff-1', required_permission: 'support.view' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a null permission result as denied', async () => {
    state.hasPerm = null;
    const res = await POST(req({ type: 'confirmation', ...FORGED }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/notify — validation', () => {
  it('rejects an unknown type (400)', async () => {
    const res = await POST(req({ type: 'anything', ticketId: TICKET_ID }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing ticket id (400)', async () => {
    const res = await POST(req({ type: 'reply' }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the ticket does not exist', async () => {
    state.ticket = null;
    const res = await POST(req({ type: 'reply', ticketId: TICKET_ID }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/notify — staff caller, forged fields ignored', () => {
  it('confirmation: recipient, subject and link come from the ticket row', async () => {
    const res = await POST(req({ type: 'confirmation', ...FORGED }));
    expect(res.status).toBe(200);
    expect(state.eqCalls).toEqual([['id', TICKET_ID]]);
    const s = sent();
    expect(s.url).toBe('https://broker-internal.test/api/email/ticket-confirmation');
    expect(s.headers['x-api-secret']).toBe('secret-xyz');
    expect(s.body).toEqual({
      ticketNumber: 'TKT-0012',
      ticketSubject: 'Stored subject',
      requesterEmail: 'customer@example.com',
      ticketLink: `https://app.test/dashboard/support/${TICKET_ID}`,
    });
  });

  it('reply: customer email from the row, agent name from the session', async () => {
    const res = await POST(req({ type: 'reply', ...FORGED, agentName: 'Forged', replyPreview: 'Hello' }));
    expect(res.status).toBe(200);
    const s = sent();
    expect(s.url).toBe('https://broker-internal.test/api/email/ticket-notification');
    expect(s.body).toEqual({
      type: 'reply',
      ticketId: TICKET_ID,
      ticketNumber: 'TKT-0012',
      ticketSubject: 'Stored subject',
      customerEmail: 'customer@example.com',
      agentName: 'Sam Staff',
      replyPreview: 'Hello',
      ticketUrl: `https://app.test/dashboard/support/${TICKET_ID}`,
    });
  });

  it('reply: caps the preview length', async () => {
    await POST(req({ type: 'reply', ticketId: TICKET_ID, replyPreview: 'x'.repeat(5000) }));
    expect((sent().body.replyPreview as string).length).toBe(203);
  });

  it('assignment: agent email is the stored assignee, not the body', async () => {
    const res = await POST(req({ type: 'assignment', ...FORGED }));
    expect(res.status).toBe(200);
    const s = sent();
    expect(s.body).toEqual({
      type: 'assignment',
      ticketId: TICKET_ID,
      ticketNumber: 'TKT-0012',
      ticketSubject: 'Stored subject',
      agentEmail: 'agent@keepr.test',
      customerName: 'Casey Customer',
      priority: 'high',
      ticketUrl: `https://admin.test/support/${TICKET_ID}`,
    });
  });

  it('assignment: skips when the ticket has no assignee', async () => {
    state.ticket = { ...state.ticket, assignee_id: null };
    const res = await POST(req({ type: 'assignment', ...FORGED }));
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ticket_resolved: refuses when the stored ticket is not resolved/closed', async () => {
    const res = await POST(req({ type: 'ticket_resolved', ...FORGED }));
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ticket_resolved: uses the stored status and requester', async () => {
    state.ticket = { ...state.ticket, status: 'closed' };
    const res = await POST(req({ type: 'ticket_resolved', ...FORGED, resolutionSummary: 'Fixed' }));
    expect(res.status).toBe(200);
    const s = sent();
    expect(s.url).toBe('https://broker-internal.test/api/email/ticket-resolved');
    expect(s.body).toEqual({
      ticketId: TICKET_ID,
      ticketNumber: 'TKT-0012',
      ticketSubject: 'Stored subject',
      customerEmail: 'customer@example.com',
      resolutionSummary: 'Fixed',
      ticketUrl: `https://app.test/support/${TICKET_ID}`,
      newStatus: 'closed',
    });
  });
});
