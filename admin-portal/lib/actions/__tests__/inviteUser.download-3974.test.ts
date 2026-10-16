/**
 * BACKLOG-3974: an individual (no-organization) invite posts the invitee's
 * name to the broker-portal download-invite route, so the email's To line
 * shows "First Last" instead of the bare address. fetch is stubbed (tests
 * never touch the network); the session client is a minimal stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'staff-user' } } }) },
    rpc: vi.fn(),
  }),
}));

import { inviteUser } from '../inviteUser';

const fetchMock = vi.fn();
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
  process.env = { ...ORIGINAL_ENV, BROKER_PORTAL_URL: 'http://broker.test', INTERNAL_API_SECRET: 'secret' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = ORIGINAL_ENV;
});

function postedBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  expect(url).toBe('http://broker.test/api/email/send-download-invite');
  return JSON.parse(init.body);
}

describe('individual download invite', () => {
  it('posts the invitee name as recipientName', async () => {
    const result = await inviteUser({
      email: 'Invitee@Fixture.Example.Test',
      firstName: ' Pat ',
      lastName: 'Example',
      role: 'agent',
      organizationId: null,
    });
    expect(result).toEqual({ success: true, emailSent: true, flow: 'download' });
    expect(postedBody()).toEqual({
      recipientEmail: 'invitee@fixture.example.test',
      downloadUrl: 'https://keeprcompliance.com',
      recipientName: 'Pat Example',
    });
  });
});
