/**
 * BACKLOG-2956 — the LAN guard at the syncService CHOKE POINT.
 *
 * The address check shipped scan-time only: `isPrivateLanIPv4` ran inside the two
 * QR-scan handlers and nowhere else. Two holes followed, both real:
 *
 *   1. a pairing saved by a build that predates the check survives an app
 *      upgrade completely unchecked;
 *   2. background sync never passes through a scan handler at all, so it was
 *      permanently unguarded.
 *
 * That matters because the app now ships a blanket `usesCleartextTraffic="true"`
 * — unavoidable, since Android's network-security-config has no CIDR syntax — so
 * this check is the only thing bounding what that flag opens up. A stored pairing
 * naming a public host would push message and contact payloads over plain HTTP to
 * the internet.
 *
 * WHAT THIS SUITE ASSERTS, and why it is shaped this way: the SR review of the
 * scan-time work found a version of these tests that swept the address ranges
 * thoroughly while nothing asserted the screens actually CALLED the check. The
 * range sweep lives in services/__tests__/lanAddress.test.ts. This file asserts
 * the CALL SITE — that every public entry point of syncService refuses to issue a
 * request — by spying on global `fetch` and requiring ZERO calls.
 *
 * All four public functions are covered, because all four funnel through the one
 * guarded `fetchWithTimeout`; a fifth added later is covered the day it is
 * written. The background-sync path has its own evidence in
 * services/__tests__/backgroundSync.test.ts (it drives the real `performSync`).
 *
 * MUTATION THAT MUST GO RED: delete the `if (host === null ||
 * !isPrivateLanIPv4(host))` block from `fetchWithTimeout` in
 * services/syncService.ts. Every refusal test fails; the private-address positive
 * controls stay green.
 */
// The full surface syncService uses. An incomplete Sentry mock is a silent trap
// here: `registerDevice` calls addBreadcrumb on its SUCCESS path, so omitting it
// makes the positive control throw, get caught, and report failure — which reads
// exactly like the guard refusing a private address.
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock('../encryption', () => ({
  encrypt: jest.fn(async () => ({ iv: 'iv', ciphertext: 'ct', tag: 'tag' })),
}));

jest.mock('../keyDerivation', () => ({
  deriveTransportKeys: jest.fn(async () => ({
    authToken: 'token',
    encryptionKey: 'key',
  })),
}));

jest.mock('../authService', () => ({
  getSession: jest.fn(async () => null),
}));

jest.mock('../contactSyncState', () => ({
  setContactDiffSupported: jest.fn(async () => undefined),
}));

import {
  sendMessages,
  sendContacts,
  registerDevice,
  pingDesktop,
} from '../syncService';
import type { PairingInfo, SyncMessage } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';

/** A stored pairing at `ip`. Nothing here is a real device or a real number. */
function pairingAt(ip: string): PairingInfo {
  return { ip, port: 8765, secret: 'a'.repeat(64), deviceId: 'device-1' };
}

const MESSAGE: SyncMessage = {
  smsId: '1',
  sender: '+12065550142',
  body: 'test body',
  timestamp: 1_000,
  threadId: 't1',
  direction: 'inbound',
};

const CONTACT: SyncContact = {
  id: 'c1',
  displayName: 'Test Contact',
  phones: [{ number: '+12065550143' }],
  emails: [],
};

/** A minimal ok Response for the positive controls. */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchSpy = jest.fn();

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchSpy;
});

beforeEach(() => {
  fetchSpy.mockReset();
  jest.clearAllMocks();
});

// Addresses that must be refused. `stored` names how each one gets there, since
// the point of the choke point is that it does not care how the address arrived.
const REFUSED: { address: string; why: string }[] = [
  { address: '8.8.8.8', why: 'a public address' },
  { address: '100.64.1.1', why: 'CGNAT — outside the permitted ranges' },
  { address: '11.0.0.1', why: 'just outside 10.0.0.0/8' },
  { address: '172.32.0.1', why: 'just outside 172.16.0.0/12' },
  { address: '192.169.0.1', why: 'just outside 192.168.0.0/16' },
  { address: 'evil.example.com', why: 'a hostname, which could resolve anywhere' },
  { address: '010.0.0.1', why: 'a non-canonical octal-looking form' },
];

describe('syncService LAN guard — refuses off-LAN destinations (BACKLOG-2956)', () => {
  describe.each(REFUSED)('a stored pairing at $address ($why)', ({ address }) => {
    it('sendMessages issues NO request and reports an invalid address', async () => {
      const result = await sendMessages([MESSAGE], pairingAt(address));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_address');
    });

    it('sendContacts issues NO request', async () => {
      const result = await sendContacts([CONTACT], pairingAt(address));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_address');
    });

    it('registerDevice issues NO request', async () => {
      const result = await registerDevice({
        ip: address,
        port: 8765,
        secret: 'a'.repeat(64),
        deviceId: 'device-1',
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_address');
    });

    it('pingDesktop issues NO request', async () => {
      const reachable = await pingDesktop(pairingAt(address));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reachable).toBe(false);
    });
  });

  it('the refusal message tells the user to re-pair, not to check their network', async () => {
    const result = await sendMessages([MESSAGE], pairingAt('8.8.8.8'));

    expect(result.error).toMatch(/pairing is no longer valid/i);
    // The reachability copy would be the wrong cause AND the wrong fix.
    expect(result.error).not.toMatch(/same network|desktop app is not running/i);
  });
});

// The positive controls matter as much as the refusals: without them the guard
// could be "refuse everything" and every test above would still pass.
describe('syncService LAN guard — private ranges still work (BACKLOG-2956)', () => {
  const PERMITTED = ['10.0.0.2', '172.16.5.5', '192.168.1.50', '169.254.10.1', '127.0.0.1'];

  it.each(PERMITTED)('sendMessages DOES issue a request to %s', async (address) => {
    fetchSpy.mockResolvedValue(okResponse({ success: true, received: 1 }));

    await sendMessages([MESSAGE], pairingAt(address));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`http://${address}:8765/sync/messages`);
  });

  it('pingDesktop DOES reach a private-range desktop', async () => {
    fetchSpy.mockResolvedValue(okResponse({ status: 'ok' }));

    const reachable = await pingDesktop(pairingAt('10.0.0.2'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(reachable).toBe(true);
  });

  it('registerDevice DOES reach a private-range desktop', async () => {
    fetchSpy.mockResolvedValue(okResponse({ success: true, deviceId: 'srv-1' }));

    const result = await registerDevice({
      ip: '192.168.1.50',
      port: 8765,
      secret: 'a'.repeat(64),
      deviceId: 'device-1',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
