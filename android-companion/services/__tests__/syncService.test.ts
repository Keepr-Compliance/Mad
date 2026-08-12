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
const mockEncrypt = jest.fn(async (_data: string, _key: Uint8Array) => ({ iv: 'iv', encrypted: 'enc', tag: 'tag' }));
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

// BACKLOG-2208: registerDevice persists the desktop's contactDiff capability.
const mockSetContactDiffSupported = jest.fn(async (_v: boolean) => undefined);
jest.mock('../contactSyncState', () => ({
  setContactDiffSupported: (v: boolean) => mockSetContactDiffSupported(v),
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

  // --- BACKLOG-2212: surface HTTP status + classify reachability failures -----

  it('surfaces the HTTP status on a non-ok response so 403 is distinguishable', async () => {
    mockFetchOnce({ ok: false, status: 403 });

    const result = await registerDevice(PAIRING);

    // The pairing UI keys off status === 403 to show the account message rather
    // than a reachability message.
    expect(result.status).toBe(403);
  });

  it('classifies a network failure (desktop unreachable) as connection_refused with no status', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('Network request failed'));

    const result = await registerDevice(PAIRING);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('connection_refused');
    // A transport failure never carries an HTTP status (there was no response).
    expect(result.status).toBeUndefined();
  });

  it('classifies a bounded-timeout abort (hung desktop) as timeout', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockRejectedValue(abort);

    const result = await registerDevice(PAIRING);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
  });

  it('omits identity fields gracefully when there is no session', async () => {
    mockGetSession.mockResolvedValue(null);
    mockFetchOnce({ ok: true, status: 200 });

    await registerDevice(PAIRING);

    const body = lastFetchBody();
    expect(body).not.toHaveProperty('supabaseUserId');
    expect(body).not.toHaveProperty('supabaseAccessToken');
  });

  // --- BACKLOG-2208: persist desktop contactDiff capability ------------------

  it('persists contactDiff=true when the desktop advertises the capability', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        deviceId: 'device-xyz',
        capabilities: { contactDiff: true },
      }),
    });

    await registerDevice(PAIRING);

    expect(mockSetContactDiffSupported).toHaveBeenCalledWith(true);
  });

  it('persists contactDiff=false when an OLD desktop advertises no capabilities', async () => {
    // Default mockFetchOnce json returns { success: true } — no capabilities.
    mockFetchOnce({ ok: true, status: 200 });

    await registerDevice(PAIRING);

    expect(mockSetContactDiffSupported).toHaveBeenCalledWith(false);
  });

  // --- BACKLOG-2210: surface the desktop-minted device identity --------------

  it('returns the desktop-assigned deviceId so the caller can adopt it', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        deviceId: '11111111-2222-3333-4444-555555555555',
        capabilities: { contactDiff: true },
      }),
    });

    const result = await registerDevice(PAIRING);

    expect(result.success).toBe(true);
    expect(result.deviceId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('omits deviceId (undefined) when an OLD desktop does not mint one', async () => {
    // Default json returns { success: true } — no deviceId field.
    mockFetchOnce({ ok: true, status: 200 });

    const result = await registerDevice(PAIRING);

    expect(result.deviceId).toBeUndefined();
  });
});

describe('sendMessages / sendContacts (BACKLOG-2224 soft backstop)', () => {
  const messages: SyncMessage[] = [
    { sender: '+15555550112', body: 'hi', timestamp: 1, direction: 'inbound' },
  ];
  const contacts: SyncContact[] = [
    { id: 'c1', displayName: 'Jane', phones: [{ number: '+15555550112' }], emails: [] },
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

  // --- BACKLOG-2208: isFullSync on the contact wire --------------------------

  it('sets isFullSync:true on the contact payload for a full sync', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    await sendContacts(contacts, PAIRING, true);

    const plaintext = JSON.parse(mockEncrypt.mock.calls[0][0] as string);
    expect(plaintext.isFullSync).toBe(true);
  });

  it('sets isFullSync:false on the contact payload for an incremental diff', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    await sendContacts(contacts, PAIRING, false);

    const plaintext = JSON.parse(mockEncrypt.mock.calls[0][0] as string);
    expect(plaintext.isFullSync).toBe(false);
  });

  it('OMITS isFullSync when not provided (legacy desktop treats it as full)', async () => {
    mockFetchOnce({ ok: true, status: 200 });

    await sendContacts(contacts, PAIRING);

    const plaintext = JSON.parse(mockEncrypt.mock.calls[0][0] as string);
    expect(plaintext).not.toHaveProperty('isFullSync');
  });
});
