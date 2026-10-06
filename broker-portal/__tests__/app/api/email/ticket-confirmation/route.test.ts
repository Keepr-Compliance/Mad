/**
 * Tests for the ticket confirmation API route.
 *
 * BACKLOG-3712: a signed-in session caller sends only a ticket id; the
 * recipient, subject and link come from the ticket row, never the body.
 * Server callers with the internal secret keep their existing contract.
 *
 * @jest-environment node
 */

const mockSendConfirmation = jest.fn();
const mockGetUser = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn(() => ({ select: mockSelect }));

jest.mock('@/lib/email', () => ({
  sendTicketConfirmationEmail: mockSendConfirmation,
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

jest.mock('@sentry/nextjs', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { POST } from '@/app/api/email/ticket-confirmation/route';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = process.env;
// pii-allow-uuid: invented test id, not from any live row
const TICKET_ID = '11111111-2222-4333-8444-555555555555';

function makeRequest(body: Record<string, unknown>, secret?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-api-secret'] = secret;
  return new NextRequest('http://localhost/api/email/ticket-confirmation', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function storedTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    ticket_number: 7,
    subject: 'Stored subject',
    requester_email: 'owner@example.com',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

const FORGED = {
  ticketId: TICKET_ID,
  ticketNumber: 'TKT-9999',
  ticketSubject: 'Forged subject',
  requesterEmail: 'victim@evil.test',
  ticketLink: 'https://evil.test/phish',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    INTERNAL_API_SECRET: 'test-secret-123',
    NEXT_PUBLIC_APP_URL: 'https://app.test',
  };
  mockSendConfirmation.mockResolvedValue({ success: true });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'owner@example.com' } } });
  mockMaybeSingle.mockResolvedValue({ data: storedTicket(), error: null });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('POST /api/email/ticket-confirmation — session caller', () => {
  it('returns 401 with no session and no secret, and sends nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(makeRequest(FORGED));
    expect(res.status).toBe(401);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong secret and no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(makeRequest(FORGED, 'wrong'));
    expect(res.status).toBe(401);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('ignores a forged recipient, subject and link and uses the stored row', async () => {
    const res = await POST(makeRequest(FORGED));
    expect(res.status).toBe(200);
    expect(mockFrom).toHaveBeenCalledWith('support_tickets');
    expect(mockEq).toHaveBeenCalledWith('id', TICKET_ID);
    expect(mockSendConfirmation).toHaveBeenCalledTimes(1);
    expect(mockSendConfirmation).toHaveBeenCalledWith({
      recipientEmail: 'owner@example.com',
      ticketSubject: 'Stored subject',
      ticketNumber: 'TKT-0007',
      ticketLink: `https://app.test/support/${TICKET_ID}`,
    });
  });

  it('returns 404 when the caller cannot see the ticket (RLS returns no row)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeRequest({ ticketId: TICKET_ID }));
    expect(res.status).toBe(404);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('returns 400 without a valid ticket id', async () => {
    const res = await POST(makeRequest({ requesterEmail: 'victim@evil.test' }));
    expect(res.status).toBe(400);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('refuses an old ticket (409)', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: storedTicket({ created_at: new Date(Date.now() - 16 * 60_000).toISOString() }),
      error: null,
    });
    const res = await POST(makeRequest({ ticketId: TICKET_ID }));
    expect(res.status).toBe(409);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('accepts a ticket just inside the window', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: storedTicket({ created_at: new Date(Date.now() - 14 * 60_000).toISOString() }),
      error: null,
    });
    const res = await POST(makeRequest({ ticketId: TICKET_ID }));
    expect(res.status).toBe(200);
    expect(mockSendConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/email/ticket-confirmation — server caller (x-api-secret)', () => {
  it('sends with the fields the server caller derived, without a session lookup', async () => {
    const body = {
      ticketNumber: 'TKT-0042',
      ticketSubject: 'Subject',
      requesterEmail: 'requester@example.com',
      ticketLink: 'https://app.test/dashboard/support/x',
    };
    const res = await POST(makeRequest(body, 'test-secret-123'));
    expect(res.status).toBe(200);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSendConfirmation).toHaveBeenCalledWith({
      recipientEmail: 'requester@example.com',
      ticketSubject: 'Subject',
      ticketNumber: 'TKT-0042',
      ticketLink: 'https://app.test/dashboard/support/x',
    });
  });

  it('returns 400 when a field is missing', async () => {
    const res = await POST(makeRequest({ ticketNumber: 'TKT-1' }, 'test-secret-123'));
    expect(res.status).toBe(400);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it('does not treat an empty configured secret as valid', async () => {
    process.env.INTERNAL_API_SECRET = '';
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(makeRequest(FORGED, ''));
    expect(res.status).toBe(401);
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });
});
