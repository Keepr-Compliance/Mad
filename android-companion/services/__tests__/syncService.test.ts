/**
 * BACKLOG-2224 — phone-side identity on the sync wire.
 *
 * Proves the companion attaches its Supabase identity so the desktop can
 * enforce account-match:
 *   - registerDevice() sends supabaseUserId + supabaseAccessToken (authoritative
 *     desktop check) and surfaces a 403 as a failed result.
 *   - sendMessages() / sendContacts() embed supabaseUserId in the (pre-encrypt)
 *     payload (soft backstop).
 */

import type { PairingInfo } from '../../types/sync';

// --- Mocks for syncService's dependencies -------------------------------------

const mockGetSession = jest.fn();
jest.mock('../authService', () => ({
  getSession: () => mockGetSession(),
}));

// Capture the plaintext handed to encrypt() so we can assert on the payload.
const mockEncrypt = jest.fn(async () => ({ iv: 'iv', encrypted: 'enc', tag: 'tag' }));
jest.mock('../encryption', () => ({
  encrypt: (data: string, key: Uint8Array) => mockEncrypt(data, key),
}));

jest.mock('../keyDerivation', () => ({
  deriveTransportKeys: jest.fn(async () => ({
    authToken: 'auth-token',
    encryptionKey: new Uint8Array(32),
  })),
}));

jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

import { registerDevice, sendMessages, sendContacts } from '../syncService';
import type { SyncMessage } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';

const PAIRING: PairingInfo = {
  ip: '192.168.1.5',
  port: 51000,
  secret: 'a'.repeat(64),
  deviceId: 'device-xyz',
};

function mockFetchOnce(response: Partial<Response> & { status?: number }) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => ({ success: true }),
    text: async () => 'error body',
    ...response,
  });
}

function lastFetchBody(): Record<string, unknown> {
  const call = (global as unknown as { fetch: jest.Mock }).fetch.mock.calls[0];
  return JSON.parse(call[1].body as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: 'user-A' },
    access_token: 'access-A',
  });
});

describe('registerDevice (BACKLOG-2224 identity)', () => {
  it('includes supabaseUserId + supabaseAccessToken in the register body', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    const result = await registerDevice(PAIRING);

    expect(result.success).toBe(true);
    const body = lastFetchBody();
    expect(body.supabaseUserId).toBe('user-A');
    expect(body.supabaseAccessToken).toBe('access-A');
    expect(body.deviceId).toBe('device-xyz');
  });

  it('surfaces a desktop 403 (account mismatch) as a failed result', async () => {
    mockFetchOnce({ ok: false, status: 403 });

    const result = await registerDevice(PAIRING);

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
    expect(result.errorType).toBe('server_error');
  });

  it('omits identity fields gracefully when there is no session', async () => {
    mockGetSession.mockResolvedValue(null);
    mockFetchOnce({ ok: true, status: 200 });

    await registerDevice(PAIRING);

    const body = lastFetchBody();
    expect(body).not.toHaveProperty('supabaseUserId');
    expect(body).not.toHaveProperty('supabaseAccessToken');
  });
});

describe('sendMessages / sendContacts (BACKLOG-2224 soft backstop)', () => {
  const messages: SyncMessage[] = [
    { sender: '+15551234567', body: 'hi', timestamp: 1, direction: 'inbound' },
  ];
  const contacts: SyncContact[] = [
    { id: 'c1', displayName: 'Jane', phones: [{ number: '+15551234567' }], emails: [] },
  ];

  it('embeds supabaseUserId in the encrypted message payload', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    await sendMessages(messages, PAIRING);

    const plaintext = JSON.parse(mockEncrypt.mock.calls[0][0] as string);
    expect(plaintext.supabaseUserId).toBe('user-A');
    expect(plaintext.deviceId).toBe('device-xyz');
  });

  it('embeds supabaseUserId in the encrypted contact payload', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    await sendContacts(contacts, PAIRING);

    const plaintext = JSON.parse(mockEncrypt.mock.calls[0][0] as string);
    expect(plaintext.supabaseUserId).toBe('user-A');
  });
});
