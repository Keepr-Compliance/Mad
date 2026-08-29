/**
 * BACKLOG-2987 — THE PHONE RE-PRESENTS THE IDENTITY IT ALREADY HOLDS.
 *
 * WHAT WENT WRONG, and why the item's own control had to be reframed before it
 * could discriminate anything.
 *
 * The item says the phone "appears to call `registerDevice` on each sync". It
 * does not. `registerDevice` had exactly two callers, both inside a QR-scan
 * handler (`app/(main)/home.tsx`, `app/onboarding/pair-device.tsx`);
 * `backgroundSync.runSyncCycle` never registers, it reads the stored pairing. So
 * the item's control 1 as written — *sync twice without re-pairing, assert the
 * same device id* — is GREEN on the unfixed code and proves nothing.
 *
 * The id churned once per RE-PAIR, because both handlers sent the QR's
 * `deviceName` as the claim. The founder re-paired before each of his four
 * logged syncs (Force Re-import calls `stopServer()`, which forces a re-scan),
 * which is why the log reads as one new id per sync.
 *
 * So the discriminating control is PAIR -> RE-PAIR: given an identity already
 * held, assert the id presented at /register is that identity and not the name.
 * That is `presents the identity it already holds on a re-pair` below.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MUST GO RED (run, not asserted — see the PR body for results)
 * ---------------------------------------------------------------------------
 *  M1  In `deviceIdClaimFor`, return `fallbackDeviceId` unconditionally — i.e.
 *      restore exactly what both screens did before this item. The re-pair
 *      control and the survives-unpair control fail; the first-pair control
 *      stays green, which is the point: first-pair behaviour is UNCHANGED.
 *  M2  In `registerWithStoredIdentity`, drop the `adoptDeviceIdentity` call.
 *      Every "adopts" control fails.
 *  M3  In `adoptDeviceIdentity`, drop the `isMintedDeviceId` guard. The
 *      "refuses a name-derived echo" control fails.
 *  M4  In `registerWithStoredIdentity`, move `forceFullContactResync()` above
 *      the success check. The "does not force a resync on failure" control
 *      fails.
 *
 * NOTHING HERE IS A REAL DEVICE. The UUIDs are invented and the "device name"
 * is a placeholder.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// Stateful in-memory AsyncStorage (same rationale as the other service tests).
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k];
      }),
      __reset: () => {
        store = {};
      },
    },
  };
});
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

jest.mock('../syncService', () => ({
  registerDevice: jest.fn(),
}));

jest.mock('../contactSyncState', () => ({
  forceFullContactResync: jest.fn(async () => undefined),
}));

import { registerDevice } from '../syncService';
import { forceFullContactResync } from '../contactSyncState';
import {
  DEVICE_ID_STORAGE_KEY,
  isMintedDeviceId,
  getStoredDeviceIdentity,
  adoptDeviceIdentity,
  deviceIdClaimFor,
  registerWithStoredIdentity,
} from '../deviceIdentity';

const mockRegister = registerDevice as jest.MockedFunction<typeof registerDevice>;
const mockForceFull = forceFullContactResync as jest.MockedFunction<
  typeof forceFullContactResync
>;

/** An invented desktop-minted id. Not a real device. */
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const MINTED_A = '11111111-2222-4333-8444-555555555555';
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const MINTED_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** What the QR carries: a NAME. Never UUID-shaped. */
const QR_DEVICE_NAME = 'Test-Desktop';

const CONNECTION = { ip: '192.168.1.50', port: 8765, secret: 'f'.repeat(64) };

/** The `deviceId` actually put on the wire by the Nth register call. */
function claimOnCall(n: number): string {
  return (mockRegister.mock.calls[n][0] as { deviceId: string }).deviceId;
}

beforeEach(() => {
  resetStore();
  mockRegister.mockReset();
  mockForceFull.mockClear();
});

describe('isMintedDeviceId', () => {
  it('accepts the desktop UUID shape and rejects everything else', () => {
    expect(isMintedDeviceId(MINTED_A)).toBe(true);
    expect(isMintedDeviceId(MINTED_A.toUpperCase())).toBe(true);
    // The exact values the old code sent, and the near-misses that must not pass.
    expect(isMintedDeviceId(QR_DEVICE_NAME)).toBe(false);
    expect(isMintedDeviceId('')).toBe(false);
    expect(isMintedDeviceId(null)).toBe(false);
    expect(isMintedDeviceId(undefined)).toBe(false);
    expect(isMintedDeviceId(MINTED_A.slice(0, -1))).toBe(false);
    expect(isMintedDeviceId(`${MINTED_A}x`)).toBe(false);
    expect(isMintedDeviceId(MINTED_A.replace(/-/g, ''))).toBe(false);
  });
});

describe('the claim presented at /register', () => {
  it('falls back to the QR device name on a FIRST pair (minting is correct there)', async () => {
    expect(await deviceIdClaimFor(QR_DEVICE_NAME)).toBe(QR_DEVICE_NAME);
  });

  it('presents the identity it already holds once one has been adopted', async () => {
    await adoptDeviceIdentity(MINTED_A);
    expect(await deviceIdClaimFor(QR_DEVICE_NAME)).toBe(MINTED_A);
  });

  it('ignores a stored value that is not UUID-shaped', async () => {
    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, 'Pixel-8');
    expect(await getStoredDeviceIdentity()).toBeNull();
    expect(await deviceIdClaimFor(QR_DEVICE_NAME)).toBe(QR_DEVICE_NAME);
  });
});

describe('adoptDeviceIdentity', () => {
  it('stores a minted id and reports that it did', async () => {
    expect(await adoptDeviceIdentity(MINTED_A)).toBe(true);
    expect(await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(MINTED_A);
  });

  it('refuses a name-derived echo from a desktop that does not mint', async () => {
    expect(await adoptDeviceIdentity(QR_DEVICE_NAME)).toBe(false);
    expect(await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBeNull();
  });

  it('refuses an absent id', async () => {
    expect(await adoptDeviceIdentity(undefined)).toBe(false);
    expect(await adoptDeviceIdentity(null)).toBe(false);
    expect(await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBeNull();
  });
});

describe('registerWithStoredIdentity', () => {
  it('adopts the desktop-minted id on a FIRST pair', async () => {
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });

    const result = await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(claimOnCall(0)).toBe(QR_DEVICE_NAME);
    expect(result.adopted).toBe(true);
    expect(await getStoredDeviceIdentity()).toBe(MINTED_A);
  });

  it('presents the identity it already holds on a re-pair (THE CONTROL)', async () => {
    // First pair: the desktop mints.
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });
    await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    // Re-pair: the desktop honours the claim and echoes the SAME id back, which
    // is what `isMintedDeviceId(claimed) ? claimed : randomUUID()` does in
    // electron/services/localSyncService.ts.
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });
    await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(mockRegister).toHaveBeenCalledTimes(2);
    // The exact assertion the old code fails: it sent the NAME both times, so
    // the desktop minted twice and the contact stale-delete had nothing to match.
    expect(claimOnCall(1)).toBe(MINTED_A);
    expect(claimOnCall(1)).not.toBe(QR_DEVICE_NAME);
    // And the desktop's answer is the SAME identity across both pairings — the
    // property the founder's log shows violated four runs in a row.
    expect(claimOnCall(1)).toBe(MINTED_A);
    expect(await getStoredDeviceIdentity()).toBe(MINTED_A);
  });

  it('survives an unpair, because the identity is the PHONE\'s and not the pairing\'s', async () => {
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });
    await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    // What `pairingManager.unpairDevice` + `smsQueueService.resetAllSyncData`
    // remove on sign-out / account switch. Enumerated rather than invoked so the
    // assertion is about the KEY, and a future key added to that teardown that
    // happens to be this one would still be caught by the claim below.
    for (const key of [
      '@keepr/pairing',
      '@keepr/pairing-health',
      '@keepr/sms-queue',
      '@keepr/sync-stats',
      '@keepr/last-sync-timestamp',
      '@keepr/contact-fingerprints',
      '@keepr/contact-last-full-sync',
      '@keepr/contact-diff-supported',
    ]) {
      await AsyncStorage.removeItem(key);
    }

    expect(await getStoredDeviceIdentity()).toBe(MINTED_A);
    expect(await deviceIdClaimFor(QR_DEVICE_NAME)).toBe(MINTED_A);
  });

  it('adopts a REPLACEMENT id when the desktop mints a different one', async () => {
    await adoptDeviceIdentity(MINTED_A);
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_B });

    await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(claimOnCall(0)).toBe(MINTED_A);
    expect(await getStoredDeviceIdentity()).toBe(MINTED_B);
  });

  it('forces a FULL contact re-sync on a successful register, so the desktop stale-deletes', async () => {
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });
    await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);
    expect(mockForceFull).toHaveBeenCalledTimes(1);
  });

  it('does not adopt or force a resync when the register FAILS', async () => {
    await adoptDeviceIdentity(MINTED_A);
    mockRegister.mockResolvedValueOnce({
      success: false,
      error: 'Server responded with 403',
      errorType: 'server_error',
      status: 403,
    });

    const result = await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(result.success).toBe(false);
    expect(result.adopted).toBe(false);
    expect(result.status).toBe(403);
    expect(mockForceFull).not.toHaveBeenCalled();
    // The identity we held is untouched by a failed attempt.
    expect(await getStoredDeviceIdentity()).toBe(MINTED_A);
  });

  it('does not adopt when an OLD desktop answers without a deviceId', async () => {
    mockRegister.mockResolvedValueOnce({ success: true });

    const result = await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(result.adopted).toBe(false);
    expect(await getStoredDeviceIdentity()).toBeNull();
    // Pre-BACKLOG-2987 both screens gated the resync on `regResult.deviceId`
    // too; a desktop that mints nothing has no re-key to force.
    expect(mockForceFull).not.toHaveBeenCalled();
  });

  it('reports the claim it presented', async () => {
    await adoptDeviceIdentity(MINTED_A);
    mockRegister.mockResolvedValueOnce({ success: true, deviceId: MINTED_A });

    const result = await registerWithStoredIdentity(CONNECTION, QR_DEVICE_NAME);

    expect(result.claimedDeviceId).toBe(MINTED_A);
  });
});
