/**
 * BACKLOG-3005 — sync behaviour must not depend on WHICH SCREEN you paired from.
 *
 * ## The ruling
 *
 * Founder, 2026-08-30: *"regardless of where you sync — onboarding or home
 * screen — after you just scan the QR code, or a returning user syncing, it
 * should ALWAYS do everything based on the setting in Keepr desktop."* And:
 * *"we had the same architecture issue on Keepr desktop so i know it's
 * possible, please fix it."*
 *
 * ## What he observed
 *
 * Paired from the HOME screen, window on All time: 500 of 2,317, then it
 * stopped. An hour earlier the identical binary drained all 2,317 — that time
 * he paired through ONBOARDING. Same phone, same setting, same build.
 *
 * ## Why coalescing rather than "raise home's cycle count"
 *
 * `home.tsx`'s auto-first-sync was pinned to one cycle so it would lose the
 * lock race to `first-sync.tsx` quickly. Raising the number reinstates the
 * race. The fix is ONE drain that the other caller JOINS — the shape
 * `electron/services/messagesSyncTrigger.ts` already uses on the desktop.
 *
 * ## DEPTH-AWARENESS IS THE POINT
 *
 * "A sync is running, join it" is WRONG: joining a single-pass run would hand a
 * full-drain caller 500 messages and report success — the same silent partial,
 * reached by another road. These controls therefore assert not just that
 * callers coalesce but that they coalesce ONLY onto a run deep enough for them.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage, SyncResult, PairingInfo } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';
import type { SmsReadResult } from '../smsReader';

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

// The OS background task's ACTUAL callback is pulled out of this mock in
// control 5, so the test asserts what the task does rather than re-implementing
// it. The spy must live INSIDE the factory: `defineTask` fires while
// `backgroundSync` is being imported, and babel hoists that import above any
// module-scope `const`, so an outer variable would still be in its TDZ.
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));
jest.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: { NewData: 1, NoData: 2, Failed: 3 },
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
  getStatusAsync: jest.fn(async () => 3),
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockReadSmsMessages = jest.fn<Promise<SmsReadResult>, [number, number?]>();
jest.mock('../smsReader', () => ({
  readSmsMessages: (since: number, maxCount?: number) =>
    mockReadSmsMessages(since, maxCount),
}));
const okRead = (messages: SyncMessage[] = []): SmsReadResult => ({
  ok: true,
  messages,
});

import type { SmsPermissionResult } from '../permissions';
const mockCheckSmsPermissions = jest.fn<Promise<SmsPermissionResult>, []>();
jest.mock('../permissions', () => ({
  checkSmsPermissions: () => mockCheckSmsPermissions(),
}));

jest.mock('../contactReader', () => ({ readContacts: async () => [] }));

const mockSendMessages =
  jest.fn<Promise<SyncResult>, [SyncMessage[], PairingInfo]>();
jest.mock('../syncService', () => ({
  sendMessages: (batch: SyncMessage[], pairing: PairingInfo) =>
    mockSendMessages(batch, pairing),
  sendContacts: async (): Promise<SyncResult> => ({ success: true }),
  pingDesktop: async () => true,
}));
jest.mock('../connectivity', () => ({
  isPhoneOnLocalNetwork: async () => true,
}));

// `syncWindow` reads Supabase; keep it resolvable and unwindowed.
jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

import {
  performSync,
  MAX_SYNC_CYCLES_PER_RUN,
  __resetInflightForTests,
} from '../backgroundSync';
import { MAX_QUEUE_SIZE } from '../smsQueueService';
import type { SyncOperationResult } from '../backgroundSync';

const PAIRING_STORAGE_KEY = '@keepr/pairing';

/**
 * The real background-fetch callback, captured at module load.
 *
 * Read BEFORE any `beforeEach` runs: `jest.clearAllMocks()` would wipe
 * `defineTask`'s recorded calls, and the registration only ever happens once,
 * when `backgroundSync` is first imported.
 */
const registeredTaskCallback = (
  jest.requireMock('expo-task-manager') as {
    defineTask: jest.Mock;
  }
).defineTask.mock.calls[0][1] as () => Promise<number>;

function msg(id: number, timestamp: number): SyncMessage {
  return {
    smsId: String(id),
    sender: `+1206555${String(100 + (id % 90)).padStart(4, '0')}`,
    body: `message ${id}`,
    timestamp,
    threadId: 't1',
    direction: 'inbound',
  };
}

/** `count` messages starting at id `from`, one millisecond apart. */
function block(from: number, count: number, startTs: number): SyncMessage[] {
  return Array.from({ length: count }, (_, i) => msg(from + i, startTs + i));
}

/** A read that is ALWAYS capacity-truncated, so a drain runs to its ceiling. */
function alwaysTruncating(): void {
  let n = 0;
  mockReadSmsMessages.mockImplementation(async () => {
    n += 1;
    return okRead(block(n * 10_000, MAX_QUEUE_SIZE, n * 1_000_000));
  });
}

/**
 * A read that truncates ONCE then exhausts — a two-cycle drain, so a full drain
 * is distinguishable from a single pass by the read count alone.
 */
function twoCycleDrain(): void {
  let n = 0;
  mockReadSmsMessages.mockImplementation(async () => {
    n += 1;
    return n === 1
      ? okRead(block(10_000, MAX_QUEUE_SIZE, 1_000_000))
      : okRead(block(20_000, 5, 2_000_000));
  });
}

/** A promise you settle by hand, to hold a run open across other callers. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function setPaired(): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_STORAGE_KEY,
    JSON.stringify({
      ip: '10.0.0.2',
      port: 8765,
      secret: 'x'.repeat(64),
      deviceName: 'desk',
    }),
  );
}

beforeEach(async () => {
  resetStore();
  jest.clearAllMocks();
  __resetInflightForTests();
  mockSendMessages.mockResolvedValue({ success: true });
  mockReadSmsMessages.mockResolvedValue(okRead([]));
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
  await setPaired();
});

afterEach(() => {
  __resetInflightForTests();
});

// ---------------------------------------------------------------------------
// 1. TWO CALLERS, ONE SYNC
// ---------------------------------------------------------------------------

describe('concurrent callers of the same depth coalesce', () => {
  /**
   * The founder's scenario: the home screen's auto-first-sync and onboarding's
   * first sync both fire after a pair. They must become ONE drain that both
   * observe — not a race where one wins and the other reports a skip.
   *
   * ASSERT ALL THREE. "Exactly one run" alone stays GREEN under the mutation,
   * because removing the coalescing makes the second caller lose the
   * AsyncStorage lock and return `skipped` — still one run. What the mutation
   * changes is the SECOND CALLER'S RESULT.
   *
   * MUTATION that must go red: make `inflightCoversRequirement` return false
   * always (no coalescing).
   */
  it('produces one run, and BOTH callers receive its real result', async () => {
    twoCycleDrain();

    const p1 = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    const p2 = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    const [r1, r2] = await Promise.all([p1, p2]);

    // The same run, not merely equal numbers.
    expect(r2).toBe(r1);
    expect(r1.skipped).toBeUndefined();
    expect(r2.skipped).toBeUndefined();
    // A drain happened, and only one of them.
    expect(r1.cyclesRun).toBe(2);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(2);
    expect(r2.sentMessages).toBe(MAX_QUEUE_SIZE + 5);
  });
});

// ---------------------------------------------------------------------------
// 2. DEPTH — THE PART A NAIVE FIX MISSES
// ---------------------------------------------------------------------------

describe('a full-drain caller never joins a shallower run', () => {
  /**
   * Joining a single-pass run would hand back 500 messages and report success:
   * the silent partial this item exists to remove, arrived at by another road.
   * The deeper caller must instead WAIT for the shallow run and then run its
   * own — sequential, so BACKLOG-2200's no-concurrent-runs rule holds.
   *
   * MUTATION that must go red: make the gate depth-blind
   * (`return existing !== null`).
   */
  it('waits for the single-pass run, then drains on its own', async () => {
    alwaysTruncating();

    const shallow = performSync(); // depth 1 — the OS task's shape
    const deep = performSync({ maxCycles: 3 });

    const rShallow = await shallow;
    const rDeep = await deep;

    // Not the same run.
    expect(rDeep).not.toBe(rShallow);
    // The shallow run did exactly one pass; the deep one got its full depth.
    expect(rShallow.cyclesRun).toBe(1);
    expect(rDeep.cyclesRun).toBe(3);
    expect(rDeep.skipped).toBeUndefined();
    // 1 + 3 reads: sequential runs, never concurrent.
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(4);
  });

  /**
   * The reverse direction is a legitimate join: a caller that needs one cycle
   * is fully satisfied by a run doing twenty — EXCEPT that a depth-1 caller is
   * the OS background task, which must never block. See control 5.
   */
  it('a DEEPER in-flight run does satisfy an equally-deep later caller', async () => {
    twoCycleDrain();

    const p1 = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    const p2 = performSync({ maxCycles: 2 });

    expect(await p2).toBe(await p1);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. userInitiated IS A SECOND DEPTH DIMENSION
// ---------------------------------------------------------------------------

describe('a userInitiated caller never joins', () => {
  /**
   * `userInitiated` makes the run re-read the import window through a fresh
   * cache (BACKLOG-3017), so its window can be WIDER than the in-flight run's.
   * Handing back the older run returns a scan that is shallower IN TIME even
   * though it is equally deep in cycles — the same defect one dimension over.
   *
   * Reachable in the field: the Sync Now busy-state poll is 3 seconds, so a tap
   * can land after the user widens the desktop setting but before the button
   * greys out.
   *
   * MUTATION that must go red: delete the `callerUserInitiated` exclusion from
   * `inflightCoversRequirement`.
   */
  it('runs its own sync after the in-flight one, with its own fresh window', async () => {
    alwaysTruncating();

    const background = performSync({ maxCycles: 2 });
    const tapped = performSync({ maxCycles: 2, userInitiated: true });

    const rBg = await background;
    const rTap = await tapped;

    expect(rTap).not.toBe(rBg);
    expect(rTap.skipped).toBeUndefined();
    expect(rTap.cyclesRun).toBe(2);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// 4. ONBOARDING WAITS FOR A JOIN INSTEAD OF TIMING OUT
// ---------------------------------------------------------------------------

describe('a long drain is joined, not retried against', () => {
  /**
   * `first-sync.tsx` retries a `skipped` result 5 times at 1500 ms and then
   * gives up. A drain legitimately takes minutes, so that budget used to turn a
   * healthy sync into a reported failure. Joining has NO budget: the caller
   * receives the drain's real result however long it takes.
   *
   * The deferred send holds the first run open well past 7.5 s of simulated
   * work; the joiner must still get the real numbers rather than a skip.
   *
   * MUTATION that must go red: no coalescing — the second caller loses the lock
   * and comes back `skipped`.
   */
  it('the joining caller gets the drain result, never a skip', async () => {
    twoCycleDrain();
    const gate = deferred();
    let firstSend = true;
    mockSendMessages.mockImplementation(async () => {
      if (firstSend) {
        firstSend = false;
        await gate.promise; // the drain is stuck here, holding the lock
      }
      return { success: true };
    });

    const homePairSync = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    const onboardingSync = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    let onboardingSettled = false;
    void onboardingSync.then(() => {
      onboardingSettled = true;
    });

    // While the drain is held open, the joiner has NOT given up.
    await Promise.resolve();
    expect(onboardingSettled).toBe(false);

    gate.resolve();
    const result = await onboardingSync;

    expect(result).toBe(await homePairSync);
    expect(result.skipped).toBeUndefined();
    expect(result.sentMessages).toBe(MAX_QUEUE_SIZE + 5);
  });
});

// ---------------------------------------------------------------------------
// 5. THE OS BACKGROUND TASK MUST NEVER BLOCK
// ---------------------------------------------------------------------------

describe('the OS background task stays single-pass and never waits', () => {
  /**
   * Expo documents a ~30 second budget for a background-fetch callback;
   * overrunning it gets the app terminated and future fetches delayed. Joining
   * a multi-minute drain would do exactly that.
   *
   * This is decided by the GATE, not by an assumption about which JS runtime
   * the task runs in. With the app alive, `defineTask`'s callback runs in the
   * app's own runtime and CAN see the in-memory registry — so "it is a separate
   * runtime" would not be a safe reason for it never to join.
   *
   * The callback under test is the REAL one, pulled out of the `defineTask`
   * mock rather than re-implemented here.
   *
   * MUTATION that must go red: let depth-1 callers join (drop the
   * `callerMaxCycles <= 1` exclusion).
   */
  it('the registered task settles while a drain is still running', async () => {
    // Hold the drain open INSIDE its first read. Gating the SEND instead would
    // be interleaving-dependent: the task's own run can win the lock before the
    // drain reaches a send, and then it is the TASK that blocks on the gate.
    // Once execution is inside the read, `acquireSyncLock` has demonstrably
    // already succeeded for the drain.
    const insideRead = deferred();
    const holdOpen = deferred();
    let reads = 0;
    mockReadSmsMessages.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        insideRead.resolve();
        await holdOpen.promise;
      }
      return okRead(block(reads * 10_000, MAX_QUEUE_SIZE, reads * 1_000_000));
    });

    const taskCallback = registeredTaskCallback;
    expect(typeof taskCallback).toBe('function');

    const drain = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    let drainSettled = false;
    void drain.then(() => {
      drainSettled = true;
    });

    await insideRead.promise; // the drain now holds the lock

    // The OS fires the task while the drain is stuck holding the lock.
    const taskResult = await taskCallback();

    // It came back — WITHOUT waiting for the drain.
    expect(drainSettled).toBe(false);
    expect(taskResult).toBeDefined();

    holdOpen.resolve();
    await drain;
  });

  /**
   * A depth-1 run must not EVICT a deeper in-flight entry from the registry.
   * If it did, the drain would become invisible and the next deep caller would
   * start a second run that the lock rejects — losing the join entirely.
   *
   * MUTATION that must go red: register unconditionally
   * (`inflightRun = { promise, maxCycles, userInitiated };` with no guard).
   */
  it('the task firing mid-drain leaves the drain joinable', async () => {
    const insideRead = deferred();
    const holdOpen = deferred();
    let reads = 0;
    mockReadSmsMessages.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        insideRead.resolve();
        await holdOpen.promise;
      }
      return reads < 3
        ? okRead(block(reads * 10_000, MAX_QUEUE_SIZE, reads * 1_000_000))
        : okRead(block(reads * 10_000, 3, reads * 1_000_000));
    });

    const drain = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    await insideRead.promise;

    await registeredTaskCallback(); // the OS task comes and goes

    // A later deep caller must still find the drain and JOIN it.
    const joiner = performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    holdOpen.resolve();
    expect(await joiner).toBe(await drain);
    expect((await joiner).skipped).toBeUndefined();
  });

  it('a bare performSync() is one pass even against an endless read', async () => {
    alwaysTruncating();
    const result = await performSync();
    expect(result.cyclesRun).toBe(1);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. THE TWO DEPTH RESOLUTIONS MUST AGREE
// ---------------------------------------------------------------------------

describe('the gate and the loop resolve maxCycles identically', () => {
  /**
   * `performSync` resolves the depth for its gate, and `runSyncCycles` resolves
   * it again for the loop. They are duplicated on purpose — `runSyncCycles` was
   * approved at `3adb4803f` and verified on hardware, and this item is
   * forbidden from moving it — so the duplication is pinned here instead.
   *
   * MUTATION that must go red: change the gate's expression (e.g. drop the
   * `Math.max(1, ...)` floor), then observe the depth-1 rule below break.
   */
  it.each([
    [undefined, 1],
    [0, 1],
    [-5, 1],
    [1, 1],
    [1.9, 1],
    [3, 3],
    [4.7, 4],
  ])('maxCycles %p runs %i cycle(s)', async (input, expected) => {
    alwaysTruncating();
    const result = await performSync(
      input === undefined ? {} : { maxCycles: input as number },
    );
    expect(result.cyclesRun).toBe(expected);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(expected);
  });

  /**
   * The GATE's own resolution: 1.9 must be treated as depth 1, which means it
   * must NOT join an in-flight drain (the depth-1 exclusion). If the gate
   * truncated differently from the loop this would join and read nothing.
   */
  it('a fractional depth that resolves to 1 obeys the depth-1 rule', async () => {
    alwaysTruncating();

    const drain = performSync({ maxCycles: 2 });
    const fractional = performSync({ maxCycles: 1.9 });

    const rDrain = await drain;
    const rFrac = await fractional;

    expect(rFrac).not.toBe(rDrain);
    expect(rFrac.cyclesRun ?? 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. THE REGISTRY MUST NOT LEAK BETWEEN RUNS
// ---------------------------------------------------------------------------

describe('the in-flight entry is cleared when its run settles', () => {
  it('a later caller starts a NEW run rather than joining a finished one', async () => {
    twoCycleDrain();

    const first = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    mockReadSmsMessages.mockClear();
    twoCycleDrain();
    const second = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    expect(second).not.toBe(first);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(2);
  });

  it('a failed run clears the entry too, so the next caller is not stuck', async () => {
    mockReadSmsMessages.mockImplementation(async () => {
      throw new Error('provider exploded');
    });
    const first = await performSync({ maxCycles: 2 });
    // A read failure is reported in the result, not thrown.
    expect(first.readError).toBeDefined();

    twoCycleDrain();
    const second = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    expect(second).not.toBe(first);
    expect(second.cyclesRun).toBe(2);
  });
});

export type { SyncOperationResult };
