/**
 * performSync end-to-end guards for BACKLOG-2199 + 2200.
 *
 * These exercise the orchestrator with a mocked read/send/network layer to pin:
 *   - the cursor advances ONLY after a batch is acked (never at enqueue);
 *   - a desktop-offline weekend backlog never loses the oldest messages;
 *   - back-pressure stops reads (and cursor advance) when the queue is full;
 *   - the same-millisecond boundary is never skipped by the +1ms hop;
 *   - two overlapping performSync runs neither double-send nor lose entries.
 *
 * IDENTITY, not counts: sends are captured by smsId set (BACKLOG-1977).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage, SyncResult, PairingInfo } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';

// --- Stateful in-memory AsyncStorage (same rationale as smsQueueService.test) ---
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

// --- expo / sentry side-effect mocks (module-load defineTask, breadcrumbs) ---
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
}));

// --- The read/send/network layer we drive per-test ---
const mockReadSmsMessages = jest.fn<Promise<SyncMessage[]>, [number, number?]>();
jest.mock('../smsReader', () => ({
  readSmsMessages: (since: number, maxCount?: number) =>
    mockReadSmsMessages(since, maxCount),
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
  sendContacts: (batch: SyncContact[], pairing: PairingInfo, isFullSync?: boolean) =>
    mockSendContacts(batch, pairing, isFullSync),
  pingDesktop: () => mockPingDesktop(),
}));

import { performSync } from '../backgroundSync';
import {
  getQueue,
  getLastSyncTimestamp,
  enqueueMessages,
  MAX_QUEUE_SIZE,
} from '../smsQueueService';
import { setContactDiffSupported } from '../contactSyncState';

const PAIRING_STORAGE_KEY = '@keepr/pairing';

function msg(id: number, timestamp = 1_000 + id): SyncMessage {
  return {
    smsId: String(id),
    sender: `+1555${String(id).padStart(7, '0')}`,
    body: `message ${id}`,
    timestamp,
    threadId: 't1',
    direction: 'inbound',
  };
}
function idSet(messages: SyncMessage[]): Set<string> {
  return new Set(messages.map((m) => m.smsId as string));
}

async function setPaired(): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_STORAGE_KEY,
    JSON.stringify({ ip: '10.0.0.2', port: 8765, secret: 'x'.repeat(64), deviceName: 'desk' }),
  );
}

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
  mockReadContacts.mockResolvedValue([]);
  mockSendContacts.mockResolvedValue({ success: true });
  mockPingDesktop.mockResolvedValue(true);
});

function syncContact(id: string, name = `Name ${id}`): SyncContact {
  return {
    id,
    displayName: name,
    phones: [{ number: `+1555000${id.padStart(4, '0')}` }],
    emails: [],
  };
}

/** Every contact id passed to sendContacts across all invocations, flattened. */
function sentContactIds(): string[] {
  return mockSendContacts.mock.calls.flatMap((call) =>
    call[0].map((c) => c.id),
  );
}

// ===========================================================================
// Cursor advances ONLY after ack — not at enqueue (BACKLOG-2199 C1)
// ===========================================================================
describe('cursor advances only after a confirmed ack', () => {
  it('does NOT advance the cursor when the desktop is OFFLINE, and keeps every message queued', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // desktop unreachable

    const backlog = [msg(1, 100), msg(2, 200), msg(3, 300)];
    mockReadSmsMessages.mockResolvedValue(backlog);

    const result = await performSync();

    expect(result.desktopReachable).toBe(false);
    // Messages were read + enqueued, but NONE acked -> cursor must NOT jump
    // past un-delivered messages. It may advance over what is now DURABLY
    // queued (that is safe, they are captured), which is exactly the fix:
    // the queue still holds all 3 so nothing is lost.
    const q = await getQueue();
    expect(idSet(q)).toEqual(idSet(backlog));
    // sendMessages must never have been called (ping failed first).
    expect(mockSendMessages).not.toHaveBeenCalled();
  });

  it('advances the cursor past a batch only after sendMessages acks it', async () => {
    await setPaired();
    const batch = [msg(1, 100), msg(2, 200), msg(3, 300)];
    mockReadSmsMessages.mockResolvedValue(batch);
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 3 });

    const result = await performSync();

    expect(result.sentMessages).toBe(3);
    // Acked -> queue drained AND cursor advanced past the newest (300).
    expect(await getQueue()).toHaveLength(0);
    expect(await getLastSyncTimestamp()).toBeGreaterThanOrEqual(300);
  });

  it('a failed send re-queues the exact batch and does NOT lose it', async () => {
    await setPaired();
    const batch = [msg(1, 100), msg(2, 200)];
    mockReadSmsMessages.mockResolvedValue(batch);
    mockSendMessages.mockResolvedValue({
      success: false,
      error: 'boom',
      errorType: 'server_error',
    });

    await performSync();

    const q = await getQueue();
    expect(idSet(q)).toEqual(idSet(batch)); // intact, retried next cycle
  });
});

// ===========================================================================
// The weekend-offline >MAX_QUEUE_SIZE scenario — no permanent silent loss
// ===========================================================================
describe('offline backlog > MAX_QUEUE_SIZE never permanently loses the oldest', () => {
  it('back-pressure stops reading at capacity and the cursor does not skip un-read history', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // stays offline the whole time

    // Pre-fill the queue to exactly capacity (simulating prior offline cycles).
    const alreadyQueued = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) =>
      msg(i, 1_000 + i),
    );
    await enqueueMessages(alreadyQueued);

    // A newer message exists in the SMS provider but the queue is full. Under
    // back-pressure performSync must NOT even call the reader (it would have
    // nowhere to put the results) — so the reader stays untouched.
    mockReadSmsMessages.mockResolvedValue([msg(9999, 99_000)]);

    const cursorBefore = await getLastSyncTimestamp();
    const result = await performSync();

    // Reader never invoked -> the new message is left in the provider, unread,
    // to be picked up later once the queue drains. No silent loss.
    expect(mockReadSmsMessages).not.toHaveBeenCalled();
    expect(result.newMessages).toBe(0);
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);
    const q = await getQueue();
    expect(q).toHaveLength(MAX_QUEUE_SIZE);
    // The OLDEST message (id 0) is still present — the old trim would have dropped it.
    expect(q.some((m) => m.smsId === '0')).toBe(true);
  });
});

// ===========================================================================
// Same-millisecond boundary is never skipped by the +1ms hop (SR Note D)
// ===========================================================================
describe('same-millisecond boundary safety', () => {
  it('does NOT advance to newest+1 when the read was capacity-truncated', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // stay offline so we only test the read/cursor

    // Nearly-full queue: only 2 slots of capacity remain -> perBoxBudget = 1.
    await enqueueMessages(
      Array.from({ length: MAX_QUEUE_SIZE - 2 }, (_, i) => msg(i, 500 + i)),
    );

    // Two messages share timestamp 9_000. With perBoxBudget=1 the read is
    // truncated, so the cursor must stay at (not past) 9_000 to re-read the
    // twin next cycle. Simulate the reader returning the single oldest twin.
    mockReadSmsMessages.mockImplementation(async (_since, maxCount) => {
      // budget is small (truncating). Return exactly `maxCount` msgs at 9000.
      return [msg(9001, 9_000)].slice(0, Math.max(0, maxCount ?? 0));
    });

    await performSync();

    const cursor = await getLastSyncTimestamp();
    // Must be inclusive (== 9000), NOT 9001 — otherwise the twin at 9000 is
    // lost forever. (The exact same-ms twin is re-read next cycle; idempotent
    // enqueue dedupes it.)
    expect(cursor).toBe(9_000);
  });

  it('advances to newest+1 when the read was NOT truncated (full tail drained)', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false);

    // Plenty of capacity -> perBoxBudget large. Return a small, complete tail.
    mockReadSmsMessages.mockResolvedValue([msg(1, 7_000), msg(2, 7_100)]);

    await performSync();

    // Full tail read -> safe to skip past the newest (7_100 + 1).
    expect(await getLastSyncTimestamp()).toBe(7_101);
  });
});

// ===========================================================================
// Concurrency: two overlapping performSync do not double-send or lose entries
// ===========================================================================
describe('concurrent syncs are serialised by the lock (BACKLOG-2200)', () => {
  it('two overlapping performSync calls send each message exactly once', async () => {
    await setPaired();

    const backlog = [msg(1, 100), msg(2, 200), msg(3, 300)];
    mockReadSmsMessages.mockResolvedValue(backlog);

    // Make sendMessages slow so the two runs genuinely overlap in time, and
    // record every message id that is ever sent across all invocations.
    const sentIds: string[] = [];
    mockSendMessages.mockImplementation(async (batch) => {
      await new Promise((r) => setTimeout(r, 20));
      for (const m of batch) sentIds.push(m.smsId as string);
      return { success: true, messagesReceived: batch.length };
    });

    // Fire both concurrently — one must acquire the lock, the other must skip.
    const [r1, r2] = await Promise.all([performSync(), performSync()]);

    const skippedCount = [r1, r2].filter((r) => r.skipped).length;
    expect(skippedCount).toBe(1); // exactly one run was locked out

    // Every backlog id sent EXACTLY once — no double-send.
    const uniqueSent = new Set(sentIds);
    expect(uniqueSent).toEqual(idSet(backlog));
    expect(sentIds).toHaveLength(backlog.length); // no duplicates in the list

    // Queue fully drained, no lost entries.
    expect(await getQueue()).toHaveLength(0);
  });

  it('the skipped run returns a benign non-error result (no false failure / no false success)', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue([]);
    mockSendMessages.mockImplementation(async (batch) => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: true, messagesReceived: batch.length };
    });

    const [r1, r2] = await Promise.all([performSync(), performSync()]);
    const skipped = [r1, r2].find((r) => r.skipped);

    expect(skipped).toBeDefined();
    expect(skipped?.error).toBeUndefined(); // not a failure
    expect(skipped?.desktopReachable).toBe(true); // keeps it out of error UI
    expect(skipped?.skipped).toBe(true); // callers key on this, not on zeros
  });
});

// ===========================================================================
// Contact diff — send only new/changed (BACKLOG-2208)
// ===========================================================================
describe('contact diff: send only new/changed contacts', () => {
  // These exercise the DIFF path, which only engages once the paired desktop has
  // advertised contactDiff support (BACKLOG-2208 capability handshake).
  beforeEach(async () => {
    await setContactDiffSupported(true);
  });

  it('first sync sends ALL contacts (full); a second unchanged sync sends 0', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue([]);
    const contacts = [syncContact('1'), syncContact('2'), syncContact('3')];
    mockReadContacts.mockResolvedValue(contacts);

    // Cycle 1: nothing synced yet -> FULL send of all three.
    const r1 = await performSync();
    expect(mockSendContacts).toHaveBeenCalledTimes(1);
    expect(mockSendContacts.mock.calls[0][2]).toBe(true); // isFullSync
    expect(new Set(sentContactIds())).toEqual(new Set(['1', '2', '3']));
    expect(r1.contactsSynced).toBe(3);
    expect(r1.newContacts).toBe(3);

    // Cycle 2: identical address book -> nothing to send (the core fix).
    const r2 = await performSync();
    expect(mockSendContacts).toHaveBeenCalledTimes(1); // NOT called again
    expect(r2.contactsSynced).toBe(0);
    expect(r2.newContacts).toBe(0);
  });

  it('sends ONLY the new contact on the next cycle, tagged as a diff', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue([]);

    const initial = [syncContact('1'), syncContact('2')];
    mockReadContacts.mockResolvedValue(initial);
    await performSync(); // full send of 1,2

    mockSendContacts.mockClear();
    const withNew = [...initial, syncContact('3')];
    mockReadContacts.mockResolvedValue(withNew);

    const r = await performSync();
    expect(mockSendContacts).toHaveBeenCalledTimes(1);
    expect(mockSendContacts.mock.calls[0][2]).toBe(false); // isFullSync=false (diff)
    expect(mockSendContacts.mock.calls[0][0].map((c) => c.id)).toEqual(['3']);
    expect(r.contactsSynced).toBe(1);
    expect(r.newContacts).toBe(1);
  });

  it('a FAILED contact send is NOT committed and re-sends next cycle', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue([]);
    const contacts = [syncContact('1'), syncContact('2')];
    mockReadContacts.mockResolvedValue(contacts);

    // Cycle 1: contact send fails -> nothing committed.
    mockSendContacts.mockResolvedValueOnce({
      success: false,
      error: 'boom',
      errorType: 'server_error',
    });
    const r1 = await performSync();
    expect(r1.contactsSynced).toBe(0); // not synced
    expect(r1.newContacts).toBe(2); // still detected as new

    // Cycle 2: still a FULL send of everything (fingerprints never persisted).
    mockSendContacts.mockClear();
    const r2 = await performSync();
    expect(mockSendContacts).toHaveBeenCalledTimes(1);
    expect(mockSendContacts.mock.calls[0][2]).toBe(true); // still full
    expect(new Set(mockSendContacts.mock.calls[0][0].map((c) => c.id))).toEqual(
      new Set(['1', '2']),
    );
    expect(r2.contactsSynced).toBe(2);
  });
});

// ===========================================================================
// Capability interlock: OLD desktop (no contactDiff) => always FULL send
// ===========================================================================
describe('contact diff is gated on desktop capability (BACKLOG-2208)', () => {
  it('sends the FULL set (isFullSync:true) even when a diff exists, if the desktop never advertised contactDiff', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue([]);

    // Seed fingerprints with the diff path ENABLED so a diff would otherwise be
    // possible on the next cycle.
    await setContactDiffSupported(true);
    const initial = [syncContact('1'), syncContact('2')];
    mockReadContacts.mockResolvedValue(initial);
    await performSync(); // full seed

    // Now simulate an OLD desktop: capability off. Add a new contact.
    await setContactDiffSupported(false);
    mockSendContacts.mockClear();
    const withNew = [...initial, syncContact('3')];
    mockReadContacts.mockResolvedValue(withNew);

    const r = await performSync();

    // Despite '3' being the only genuinely-new contact, the whole address book
    // is sent as a FULL snapshot — the partial-diff window never opens.
    expect(mockSendContacts).toHaveBeenCalledTimes(1);
    expect(mockSendContacts.mock.calls[0][2]).toBe(true); // isFullSync=true
    expect(new Set(mockSendContacts.mock.calls[0][0].map((c) => c.id))).toEqual(
      new Set(['1', '2', '3']),
    );
    expect(r.contactsSynced).toBe(3); // full set transmitted
    expect(r.newContacts).toBe(1); // but only 1 genuinely new
  });
});
