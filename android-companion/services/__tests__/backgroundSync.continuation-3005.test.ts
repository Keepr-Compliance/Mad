/**
 * BACKLOG-3005 — one tap of Sync Now drains the history.
 *
 * Founder: *"we can have a cap for pagination reason but we can't ask the user
 * to keep clicking sync... who does that? no one."*
 *
 * `MAX_QUEUE_SIZE = 500` stays — it is back-pressure on a queue held as one
 * JSON blob in AsyncStorage. The defect was that each cycle ESTABLISHED that
 * more history sat above the cursor and then discarded the fact, so only the
 * 15-minute timer or another tap resumed the drain.
 *
 * ## Why this suite mocks `../smsReader` and the 3017 suite does not
 *
 * What is under test here is the LOOP: how many cycles run, what stops them,
 * and how their results merge. Driving `readSmsMessages` directly is the only
 * way to state "read 1 was truncated, read 3 was not" as a premise rather than
 * arranging a fixture that happens to produce it. The window/`minDate` half is
 * covered where it belongs — against the real reader and a transcribed native
 * module — in `backgroundSync.dateWindow-2800.test.ts` and
 * `backgroundSync.windowWidening-3017.test.ts`, and the composition of 3017's
 * cursor rewind with this loop is proved there too.
 *
 * IDENTITY, not counts: message sets are asserted by smsId.
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
// An incomplete Sentry mock reads as the feature not firing — `emitOutcome`
// swallows its own errors, so every run would silently take the swallow path.
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

const mockReadContacts = jest.fn<Promise<SyncContact[]>, []>();
jest.mock('../contactReader', () => ({
  readContacts: () => mockReadContacts(),
}));

const mockSendMessages =
  jest.fn<Promise<SyncResult>, [SyncMessage[], PairingInfo]>();
const mockSendContacts =
  jest.fn<Promise<SyncResult>, [SyncContact[], PairingInfo, boolean?]>();
const mockPingDesktop = jest.fn(async () => true);
jest.mock('../syncService', () => ({
  sendMessages: (batch: SyncMessage[], pairing: PairingInfo) =>
    mockSendMessages(batch, pairing),
  sendContacts: (
    batch: SyncContact[],
    pairing: PairingInfo,
    isFullSync?: boolean,
  ) => mockSendContacts(batch, pairing, isFullSync),
  pingDesktop: () => mockPingDesktop(),
}));

const mockIsPhoneOnLocalNetwork = jest.fn(async () => true);
jest.mock('../connectivity', () => ({
  isPhoneOnLocalNetwork: () => mockIsPhoneOnLocalNetwork(),
}));

import { performSync, MAX_SYNC_CYCLES_PER_RUN } from '../backgroundSync';
import {
  getQueue,
  getLastSyncTimestamp,
  renewSyncLock,
  acquireSyncLock,
  MAX_QUEUE_SIZE,
  SYNC_LOCK_TTL_MS,
} from '../smsQueueService';
import { setContactDiffSupported } from '../contactSyncState';

const PAIRING_STORAGE_KEY = '@keepr/pairing';
const SYNC_LOCK_KEY = '@keepr/sync-lock';

/** A message at a given id/timestamp. Numbers are +1 <area> 555-01xx. */
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

function ids(messages: SyncMessage[]): Set<string> {
  return new Set(messages.map((m) => m.smsId as string));
}

/** Every smsId handed to the transport since the last mock clear. */
function sentIds(): Set<string> {
  const out = new Set<string>();
  for (const [batch] of mockSendMessages.mock.calls) {
    batch.forEach((m) => out.add(m.smsId as string));
  }
  return out;
}

function syncContact(id: string): SyncContact {
  return {
    id,
    displayName: `Name ${id}`,
    phones: [{ number: `+1206555${id.padStart(4, '0')}` }],
    emails: [],
  };
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

async function storedLock(): Promise<{ nonce: string; acquiredAt: number } | null> {
  const raw = await AsyncStorage.getItem(SYNC_LOCK_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(async () => {
  resetStore();
  jest.clearAllMocks();
  mockReadContacts.mockResolvedValue([]);
  mockSendContacts.mockResolvedValue({ success: true });
  mockSendMessages.mockResolvedValue({ success: true });
  mockPingDesktop.mockResolvedValue(true);
  mockIsPhoneOnLocalNetwork.mockResolvedValue(true);
  mockReadSmsMessages.mockResolvedValue(okRead([]));
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
  await setPaired();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. THE CONTROL THIS ITEM EXISTS FOR
// ---------------------------------------------------------------------------

describe('one run drains a backlog larger than the queue', () => {
  /**
   * MUTATION that must go red: stop continuing on truncation (delete the
   * `readWasTruncated` continuation) — only the first 500 arrive, which is the
   * bug exactly as reported.
   */
  it('delivers all 1,250 messages in ONE performSync, by identity', async () => {
    const b1 = block(1, MAX_QUEUE_SIZE, 10_000);
    const b2 = block(1_001, MAX_QUEUE_SIZE, 20_000);
    const b3 = block(2_001, 250, 30_000);
    mockReadSmsMessages
      .mockResolvedValueOnce(okRead(b1)) // truncated at the ceiling
      .mockResolvedValueOnce(okRead(b2)) // truncated at the ceiling
      .mockResolvedValueOnce(okRead(b3)); // short -> exhausted

    const result = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    expect(result.cyclesRun).toBe(3);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(3);
    expect(sentIds()).toEqual(ids([...b1, ...b2, ...b3]));
    expect(await getQueue()).toEqual([]);
  });

  it('sums the per-cycle message counts rather than reporting the last cycle', async () => {
    mockReadSmsMessages
      .mockResolvedValueOnce(okRead(block(1, MAX_QUEUE_SIZE, 10_000)))
      .mockResolvedValueOnce(okRead(block(1_001, 250, 20_000)));

    const result = await performSync({ maxCycles: 5 });

    expect(result.cyclesRun).toBe(2);
    expect(result.newMessages).toBe(MAX_QUEUE_SIZE + 250);
    expect(result.sentMessages).toBe(MAX_QUEUE_SIZE + 250);
  });
});

// ---------------------------------------------------------------------------
// 2. THE CEILING
// ---------------------------------------------------------------------------

describe('a read that never exhausts still terminates', () => {
  /** MUTATION that must go red: delete the `maxCycles` bound — runaway. */
  it('runs exactly maxCycles times and no more', async () => {
    let n = 0;
    mockReadSmsMessages.mockImplementation(async () => {
      n += 1;
      return okRead(block(n * 10_000, MAX_QUEUE_SIZE, n * 1_000_000));
    });

    const result = await performSync({ maxCycles: 3 });

    expect(result.cyclesRun).toBe(3);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 3. THE SPIN — and why the stop is `===`, not `<=`
// ---------------------------------------------------------------------------

describe('a same-millisecond block does not spin', () => {
  /**
   * When at least `remainingCapacity` messages share ONE millisecond the cursor
   * advance is inclusive, so `nextCursor === cursorBefore` and the next read is
   * byte-identical forever. Without the stop that burns the whole ceiling.
   *
   * MUTATION that must go red: delete the cursor-did-not-move stop — 20 reads.
   */
  it('reads twice and stops, rather than burning the ceiling', async () => {
    const twins = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) =>
      msg(9_000 + i, 5_000),
    );
    mockReadSmsMessages.mockResolvedValue(okRead(twins));

    const result = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    expect(mockReadSmsMessages).toHaveBeenCalledTimes(2);
    expect(result.cyclesRun).toBe(2);
    expect(await getLastSyncTimestamp()).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// 4. AN INTERRUPTION STOPS THE RUN AND LOSES NOTHING
// ---------------------------------------------------------------------------

describe('a transport failure mid-drain', () => {
  /**
   * MUTATION that must go red: drop the error stop — the loop keeps reading
   * past a failed send.
   */
  it('stops, requeues the failed batch intact, and loses nothing across the union', async () => {
    const b1 = block(1, MAX_QUEUE_SIZE, 10_000);
    const b2 = block(1_001, MAX_QUEUE_SIZE, 20_000);

    // Counted on the READ, because one cycle makes many send calls
    // (MAX_BATCH_SIZE = 50 against a MAX_QUEUE_SIZE = 500 cycle).
    let cycle = 0;
    mockReadSmsMessages.mockImplementation(async () => {
      cycle += 1;
      if (cycle === 1) return okRead(b1);
      if (cycle === 2) return okRead(b2);
      return okRead([]);
    });

    mockSendMessages.mockImplementation(async () =>
      cycle === 1
        ? { success: true }
        : { success: false, error: 'boom', errorType: 'unknown' },
    );

    const result = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    expect(result.cyclesRun).toBe(2);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(2);
    expect(result.error).toBe('boom');
    // Only cycle 1's batch was acked.
    expect(result.sentMessages).toBe(MAX_QUEUE_SIZE);
    // Cycle 2's batch is back in the queue, by identity — nothing dropped.
    expect(ids(await getQueue())).toEqual(ids(b2));
    // ZERO LOSS across the union of delivered and still-queued.
    expect(new Set([...sentIds(), ...ids(await getQueue())])).toEqual(
      ids([...b1, ...b2]),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE LOCK — the landmine a multi-cycle run walks into
// ---------------------------------------------------------------------------

describe('renewSyncLock', () => {
  it('refreshes the timestamp and KEEPS the nonce, so release still matches', async () => {
    const nonce = (await acquireSyncLock(1_000)) as string;
    expect(nonce).not.toBeNull();

    expect(await renewSyncLock(nonce, 500_000)).toBe(true);

    const lock = await storedLock();
    expect(lock?.nonce).toBe(nonce);
    expect(lock?.acquiredAt).toBe(500_000);
  });

  it('returns false for a foreign nonce and does NOT overwrite the holder', async () => {
    await acquireSyncLock(1_000);
    const before = await storedLock();

    expect(await renewSyncLock('not-mine', 2_000)).toBe(false);
    expect(await storedLock()).toEqual(before);
  });

  it('returns false when there is no lock at all', async () => {
    expect(await renewSyncLock('anything', 2_000)).toBe(false);
  });
});

describe('a long run holds its lock against a concurrent sync', () => {
  /**
   * `acquireSyncLock` stamps `acquiredAt` ONCE and nothing refreshed it, so any
   * caller arriving more than SYNC_LOCK_TTL_MS later force-breaks the lock as
   * stale. A multi-cycle run outliving that window would have its lock stolen
   * MID-RUN, reintroducing the concurrent read-modify-write race on the queue
   * and cursor that BACKLOG-2200 exists to prevent.
   *
   * MUTATION that must go red: remove the `renewSyncLock` call from the loop —
   * the concurrent run treats the lock as stale, acquires it, and both run.
   */
  it('a second performSync is SKIPPED even past the TTL, because the lock was renewed', async () => {
    let clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);

    // Distinct timestamps per cycle so the cursor advances and the run continues.
    let cycle = 0;
    mockReadSmsMessages.mockImplementation(async () => {
      cycle += 1;
      return okRead(block(cycle * 10_000, MAX_QUEUE_SIZE, cycle * 1_000_000));
    });

    let concurrent: Awaited<ReturnType<typeof performSync>> | undefined;
    let fired = false;
    mockSendMessages.mockImplementation(async () => {
      if (cycle === 1 && !fired) {
        // Cycle 1 is slow: the clock passes the stale-recovery TTL.
        clock = 1_000_000 + SYNC_LOCK_TTL_MS + 30_000;
      }
      if (cycle === 2 && !fired) {
        // Cycle 2 is running, past the ORIGINAL acquisition + TTL. A background
        // task fires right now. `fired` also stops the mutated (no-renew) case
        // from recursing, since the nested run drives these same mocks.
        fired = true;
        concurrent = await performSync();
      }
      return { success: true };
    });

    await performSync({ maxCycles: 3 });

    expect(concurrent).toBeDefined();
    expect(concurrent?.skipped).toBe(true);
  });
});

describe('a stolen lock stops the run', () => {
  /**
   * MUTATION that must go red: re-acquire instead of breaking when the renewal
   * fails — the run resumes on state another holder is mutating.
   */
  it('breaks without re-acquiring, leaving the thief`s lock untouched', async () => {
    mockReadSmsMessages.mockResolvedValue(
      okRead(block(1, MAX_QUEUE_SIZE, 10_000)),
    );

    let sendCall = 0;
    mockSendMessages.mockImplementation(async () => {
      sendCall += 1;
      if (sendCall === 1) {
        // Another context force-breaks the lock and takes it.
        await AsyncStorage.setItem(
          SYNC_LOCK_KEY,
          JSON.stringify({ nonce: 'foreign-holder', acquiredAt: Date.now() }),
        );
      }
      return { success: true };
    });

    const result = await performSync({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });

    expect(result.cyclesRun).toBe(1);
    expect(mockReadSmsMessages).toHaveBeenCalledTimes(1);
    // A re-acquire would have replaced this nonce; `releaseSyncLock` no-ops on a
    // mismatch, so the thief's lock must still be standing.
    expect((await storedLock())?.nonce).toBe('foreign-holder');
  });
});

// ---------------------------------------------------------------------------
// 6. THE DEFAULT IS THE SAFETY PROPERTY
// ---------------------------------------------------------------------------

describe('continuation is strictly opt-in', () => {
  /**
   * The OS background task (a documented ~30s budget — overrunning gets the app
   * terminated and future fetches delayed) and the AppState catch-up (fires on
   * every foreground transition) both call `performSync()` with no options.
   *
   * MUTATION that must go red: default `maxCycles` to MAX_SYNC_CYCLES_PER_RUN.
   */
  it('performSync() with no options reads exactly once against a truncated read', async () => {
    mockReadSmsMessages.mockResolvedValue(
      okRead(block(1, MAX_QUEUE_SIZE, 10_000)),
    );

    const result = await performSync();

    expect(mockReadSmsMessages).toHaveBeenCalledTimes(1);
    expect(result.cyclesRun).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. THE CONTACT COUNTS SURVIVE THE MERGE
// ---------------------------------------------------------------------------

describe('contact counts are summed, not overwritten by a later empty cycle', () => {
  /**
   * Cycle 1 sends the contact diff; every later cycle sends nothing. `home.tsx`
   * renders `result.contactsSynced > 0 ? result.newContacts : 0`, so
   * last-cycle-wins would announce "0 new contacts" after a successful sync.
   *
   * MUTATION that must go red: take `contactsSynced`/`newContacts` from the
   * last cycle instead of summing.
   */
  it('keeps cycle 1`s non-zero contact numbers across a multi-cycle drain', async () => {
    await setContactDiffSupported(true);
    mockReadContacts.mockResolvedValue([
      syncContact('1'),
      syncContact('2'),
      syncContact('3'),
    ]);
    mockReadSmsMessages
      .mockResolvedValueOnce(okRead(block(1, MAX_QUEUE_SIZE, 10_000)))
      .mockResolvedValueOnce(okRead(block(1_001, 10, 20_000)));

    const result = await performSync({ maxCycles: 5 });

    expect(result.cyclesRun).toBe(2);
    expect(result.contactsSynced).toBe(3);
    expect(result.newContacts).toBe(3);
    // The surface that would have shown "0 new contacts".
    expect(result.contactsSynced > 0 ? result.newContacts : 0).toBe(3);
  });
});
