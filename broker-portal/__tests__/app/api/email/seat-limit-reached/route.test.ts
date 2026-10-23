/**
 * BACKLOG-3851 PR-2c: the seat-limit email route and template.
 *
 * Secret callers only (the scim Edge Function). The template's copy must not promise
 * that Entra's retry adds the person.
 *
 * @jest-environment node
 */

const mockSend = jest.fn();

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual('@/lib/email/templates/seat-limit-reached');
  return {
    buildSeatLimitReachedEmail: actual.buildSeatLimitReachedEmail,
    sendSeatLimitReachedEmail: mockSend,
  };
});

jest.mock('@sentry/nextjs', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { POST } from '@/app/api/email/seat-limit-reached/route';
import { buildSeatLimitReachedEmail } from '@/lib/email/templates/seat-limit-reached';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = process.env;
const BODY = {
  recipients: ['it@example.test', 'it2@example.test'],
  personLabel: 'Seat <b>Fixture</b>',
  brokerageName: 'Happyhomey & Co',
  used: 2,
  maxSeats: 2,
  kind: 'add',
};

function req(body: unknown, secret?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-api-secret'] = secret;
  return new NextRequest('http://localhost/api/email/seat-limit-reached', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, INTERNAL_API_SECRET: 'test-secret-123' };
  mockSend.mockResolvedValue({ success: true });
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('POST /api/email/seat-limit-reached', () => {
  it('401 without the secret, with a wrong one, and when the secret is not configured', async () => {
    expect((await POST(req(BODY))).status).toBe(401);
    expect((await POST(req(BODY, 'wrong'))).status).toBe(401);
    delete process.env.INTERNAL_API_SECRET;
    expect((await POST(req(BODY, ''))).status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends one email per recipient with the given fields', async () => {
    const res = await POST(req(BODY, 'test-secret-123'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, sent: 2 });
    expect(mockSend.mock.calls.map((c) => c[0].recipientEmail)).toEqual(['it@example.test', 'it2@example.test']);
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'it@example.test', personLabel: 'Seat <b>Fixture</b>', brokerageName: 'Happyhomey & Co',
      used: 2, maxSeats: 2, kind: 'add',
    });
  });

  it('400 on a malformed body', async () => {
    for (const bad of [
      { ...BODY, recipients: [] },
      { ...BODY, recipients: ['not-an-email'] },
      { ...BODY, recipients: Array.from({ length: 21 }, (_, i) => `a${i}@example.test`) },
      { ...BODY, kind: 'other' },
      { ...BODY, used: '2' },
      { ...BODY, personLabel: '' },
    ]) {
      expect((await POST(req(bad, 'test-secret-123'))).status).toBe(400);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports a failed send as success:false', async () => {
    mockSend.mockResolvedValueOnce({ success: false, error: 'graph' });
    const res = await POST(req(BODY, 'test-secret-123'));
    expect(await res.json()).toEqual({ success: false, sent: 1 });
  });
});

describe('buildSeatLimitReachedEmail', () => {
  const base = { recipientEmail: 'it@example.test', personLabel: 'Seat <b>Fixture</b>', brokerageName: 'Happyhomey & Co', used: 2, maxSeats: 2 };

  it('add: names the person, brokerage and counts; escapes HTML; no promise that a retry adds them', () => {
    const e = buildSeatLimitReachedEmail({ ...base, kind: 'add' });
    expect(e.subject).toBe('A person from your directory could not be added to Keepr');
    expect(e.text).toContain('tried to add Seat <b>Fixture</b> in Happyhomey & Co on Keepr, but every license is in use (2 of 2). Keepr did not add them.');
    expect(e.html).toContain('Seat &lt;b&gt;Fixture&lt;/b&gt;');
    expect(e.html).toContain('Happyhomey &amp; Co');
    expect(e.html).not.toContain('<b>Fixture</b>');
    for (const body of [e.text, e.html]) {
      expect(body).not.toMatch(/retry (will )?adds?|will add them|adds them/i);
    }
  });

  it('reactivate: re-activate wording', () => {
    const e = buildSeatLimitReachedEmail({ ...base, kind: 'reactivate', maxSeats: null });
    expect(e.subject).toBe('A person from your directory could not be re-activated in Keepr');
    expect(e.text).toContain('tried to re-activate Seat <b>Fixture</b> in Happyhomey & Co on Keepr, but every license is in use. Keepr did not re-activate them.');
  });
});
