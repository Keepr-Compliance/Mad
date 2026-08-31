/**
 * BACKLOG-2800 — pairing primes the import window.
 *
 * `registerWithStoredIdentity` resets the message cursor on every successful
 * pair (BACKLOG-2995), so the FIRST sync cycle afterwards reads from epoch and
 * is bounded by the import window and nothing else. `getSyncWindowStart` fails
 * OPEN, so a phone that cannot reach Supabase on that cycle would read its whole
 * history — the very defect BACKLOG-2800 fixes. Priming during pairing, while
 * the user is demonstrably online, is what keeps that rung rare.
 *
 * The prime is an OPTIMISATION, not the correctness mechanism: both pairing
 * screens start a sync immediately after registering, so it can lose that race.
 * Correctness comes from `performSync` passing `{ forceRefresh: cursor === 0 }`,
 * which `backgroundSync.dateWindow-2800.test.ts` pins. This suite asserts the
 * prime happens, is ordered AFTER the cursor reset, and can never break pairing.
 */

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

jest.mock('../syncService', () => ({ registerDevice: jest.fn() }));
jest.mock('../contactSyncState', () => ({
  forceFullContactResync: jest.fn(async () => undefined),
  resetContactSyncState: jest.fn(async () => undefined),
}));

// The window prime and the cursor reset are both spied so their ORDER can be
// asserted — priming before the reset would fetch for a cursor that is about to
// be thrown away, which is harmless but not what the comment at the call site
// claims, and a reader should be able to trust that claim.
const order: string[] = [];
jest.mock('../syncWindow', () => ({
  primeSyncWindow: jest.fn(async () => {
    order.push('prime');
  }),
}));
jest.mock('../smsQueueService', () => ({
  resetMessageCursor: jest.fn(async () => {
    order.push('reset');
  }),
}));

import { registerDevice } from '../syncService';
import { primeSyncWindow } from '../syncWindow';
import { resetMessageCursor } from '../smsQueueService';
import { registerWithStoredIdentity } from '../deviceIdentity';

const mockRegister = registerDevice as jest.MockedFunction<typeof registerDevice>;
const mockPrime = primeSyncWindow as jest.MockedFunction<typeof primeSyncWindow>;
const mockReset = resetMessageCursor as jest.MockedFunction<
  typeof resetMessageCursor
>;

// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const MINTED = '11111111-2222-4333-8444-555555555555';

const CONNECTION = {
  ip: '10.0.0.2',
  port: 8765,
  secret: 'x'.repeat(64),
};

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
});

describe('registerWithStoredIdentity primes the import window (BACKLOG-2800)', () => {
  it('primes the window on a successful pair, AFTER clearing the cursor', async () => {
    mockRegister.mockResolvedValue({ success: true, deviceId: MINTED });

    await registerWithStoredIdentity(CONNECTION, 'phone');

    expect(mockPrime).toHaveBeenCalledTimes(1);
    // Priming before the reset would fetch against a cursor about to be
    // discarded; the call-site comment says "above has just put the cursor at
    // zero", and this keeps that true.
    expect(order).toEqual(['reset', 'prime']);
  });

  it('does NOT prime when registration failed — there is no pairing to serve', async () => {
    mockRegister.mockResolvedValue({ success: false, error: 'nope' });

    await registerWithStoredIdentity(CONNECTION, 'phone');

    expect(mockPrime).not.toHaveBeenCalled();
  });

  it('a prime failure NEVER breaks pairing (fail-open, like the cursor reset)', async () => {
    mockRegister.mockResolvedValue({ success: true, deviceId: MINTED });
    mockPrime.mockRejectedValue(new Error('offline'));

    // The whole point: pairing must still complete and report success. The
    // first sync then falls back to the cached/unwindowed ladder.
    const result = await registerWithStoredIdentity(CONNECTION, 'phone');

    expect(result.success).toBe(true);
    expect(result.deviceId).toBe(MINTED);
  });

  it('a cursor-reset failure still lets the window prime run', async () => {
    mockRegister.mockResolvedValue({ success: true, deviceId: MINTED });
    mockReset.mockRejectedValue(new Error('storage locked'));

    const result = await registerWithStoredIdentity(CONNECTION, 'phone');

    expect(result.success).toBe(true);
    expect(mockPrime).toHaveBeenCalledTimes(1);
  });
});
