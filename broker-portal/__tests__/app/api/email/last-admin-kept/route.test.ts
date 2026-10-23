/**
 * BACKLOG-4027: the last-admin email route and template.
 *
 * Secret callers only (the scim and directory-sync Edge Functions).
 *
 * @jest-environment node
 */

const mockSend = jest.fn();

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual('@/lib/email/templates/last-admin-kept');
  return {
    buildLastAdminKeptEmail: actual.buildLastAdminKeptEmail,
    sendLastAdminKeptEmail: mockSend,
  };
});

jest.mock('@sentry/nextjs', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { POST } from '@/app/api/email/last-admin-kept/route';
import { buildLastAdminKeptEmail } from '@/lib/email/templates/last-admin-kept';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = process.env;
const BODY = {
  recipients: ['support@example.test', 'it@example.test'],
  personLabel: 'Ada <b>Admin</b>',
  brokerageName: 'Example & Co',
  kind: 'deactivate',
  source: 'scim',
};

function req(body: unknown, secret?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-api-secret'] = secret;
  return new NextRequest('http://localhost/api/email/last-admin-kept', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, INTERNAL_API_SECRET: 'test-secret-4027' };
  mockSend.mockResolvedValue({ success: true });
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('POST /api/email/last-admin-kept', () => {
  it('401 without the secret, with a wrong one, and when the secret is not configured', async () => {
    expect((await POST(req(BODY))).status).toBe(401);
    expect((await POST(req(BODY, 'wrong'))).status).toBe(401);
    delete process.env.INTERNAL_API_SECRET;
    expect((await POST(req(BODY, ''))).status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends one email per recipient with the given fields', async () => {
    const res = await POST(req(BODY, 'test-secret-4027'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, sent: 2 });
    expect(mockSend.mock.calls.map((c) => c[0])).toEqual([
      { recipientEmail: 'support@example.test', personLabel: 'Ada <b>Admin</b>', brokerageName: 'Example & Co', kind: 'deactivate', source: 'scim' },
      { recipientEmail: 'it@example.test', personLabel: 'Ada <b>Admin</b>', brokerageName: 'Example & Co', kind: 'deactivate', source: 'scim' },
    ]);
  });

  it('400 on a malformed body', async () => {
    for (const bad of [
      { ...BODY, recipients: [] },
      { ...BODY, recipients: ['not-an-email'] },
      { ...BODY, recipients: Array.from({ length: 11 }, (_, i) => `a${i}@example.test`) },
      { ...BODY, kind: 'other' },
      { ...BODY, source: 'jit' },
      { ...BODY, personLabel: '' },
      { ...BODY, brokerageName: 3 },
    ]) {
      expect((await POST(req(bad, 'test-secret-4027'))).status).toBe(400);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports a failed send as success:false', async () => {
    mockSend.mockResolvedValueOnce({ success: false, error: 'graph' });
    const res = await POST(req(BODY, 'test-secret-4027'));
    expect(await res.json()).toEqual({ success: false, sent: 1 });
  });
});

describe('buildLastAdminKeptEmail', () => {
  const base = { recipientEmail: 'it@example.test', personLabel: 'Ada <b>Admin</b>', brokerageName: 'Example & Co' };

  it('deactivate via provisioning: names the person and brokerage, says how to finish; escapes HTML', () => {
    const e = buildLastAdminKeptEmail({ ...base, kind: 'deactivate', source: 'scim' });
    expect(e.subject).toBe('Keepr kept the last admin of Example & Co');
    expect(e.text).toContain("Your identity provider's provisioning tried to deactivate Ada <b>Admin</b>, the last active admin of Example & Co in Keepr. Keepr kept them as an active admin.");
    expect(e.text).toContain('make someone else an admin on the Users page in Keepr');
    expect(e.html).toContain('Ada &lt;b&gt;Admin&lt;/b&gt;');
    expect(e.html).not.toContain('<b>Admin</b>');
  });

  it('demote via directory sync', () => {
    const e = buildLastAdminKeptEmail({ ...base, kind: 'demote', source: 'directory_sync' });
    expect(e.text).toContain("directory sync tried to change the role of Ada <b>Admin</b>");
  });
});
