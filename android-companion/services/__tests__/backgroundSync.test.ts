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
import type { SmsReadResult } from '../smsReader';

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
// BACKLOG-2206: readSmsMessages now returns a discriminated SmsReadResult, so a
// read FAILURE (`{ ok: false }`) is distinguishable from a genuine empty inbox
// (`{ ok: true, messages: [] }`). `okRead`/`failRead` build those explicitly.
const mockReadSmsMessages = jest.fn<Promise<SmsReadResult>, [number, number?]>();
jest.mock('../smsReader', () => ({
  readSmsMessages: (since: number, maxCount?: number) =>
    mockReadSmsMessages(since, maxCount),
}));
const okRead = (messages: SyncMessage[] = []): SmsReadResult => ({
  ok: true,
  messages,
});
const failRead = (
  reason: 'module_unavailable' | 'permission_denied' | 'query_failed' | 'parse_failed',
  message: string = reason,
): SmsReadResult => ({ ok: false, error: { reason, message } });

// --- SMS permission gate (BACKLOG-2209). The proactive re-check at the START of
// each sync cycle calls checkSmsPermissions(); default is GRANTED so every
// pre-existing test keeps reading. `revokeSms()`/`grantSms()` flip it per-case. ---
import type { SmsPermissionResult } from '../permissions';
const mockCheckSmsPermissions = jest.fn<Promise<SmsPermissionResult>, []>();
jest.mock('../permissions', () => ({
  checkSmsPermissions: () => mockCheckSmsPermissions(),
}));
const grantSms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
};
const revokeSms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'denied',
    receiveSms: 'denied',
    allGranted: false,
  });
};

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

// --- Phone connectivity (BACKLOG-2296). The sync error classifier consults the
// phone's OWN Wi-Fi state to tell "phone offline" (case b) from "desktop down"
// (case a). Default TRUE (on Wi-Fi) so every pre-existing test keeps its
// desktop-down classification; the 2296 cases flip it to false (off Wi-Fi). ---
const mockIsPhoneOnLocalNetwork = jest.fn(async () => true);
jest.mock('../connectivity', () => ({
  isPhoneOnLocalNetwork: () => mockIsPhoneOnLocalNetwork(),
}));

import * as Sentry from '@sentry/react-native';
import { performSync } from '../backgroundSync';
import {
  getQueue,
  getLastSyncTimestamp,
  getSyncStats,
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

/** BACKLOG-2210: stored pairing that HAS adopted a desktop-minted deviceId. */
async function setPairedWithDeviceId(deviceId: string): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_STORAGE_KEY,
    JSON.stringify({
      ip: '10.0.0.2',
      port: 8765,
      secret: 'x'.repeat(64),
      deviceName: 'desk',
      deviceId,
    }),
  );
}

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
  mockReadContacts.mockResolvedValue([]);
  mockSendContacts.mockResolvedValue({ success: true });
  mockPingDesktop.mockResolvedValue(true);
  // Default the SMS read to a genuine empty inbox so tests that only exercise the
  // send/reachability path don't accidentally throw in the read step. Cases that
  // care about reads override this with mockResolvedValueOnce / mockResolvedValue.
  mockReadSmsMessages.mockResolvedValue(okRead([]));
  // BACKLOG-2296: default to "phone IS on Wi-Fi" so a failed reach classifies as
  // desktop-down (case a) unless a test explicitly says the phone is off Wi-Fi.
  mockIsPhoneOnLocalNetwork.mockResolvedValue(true);
  // BACKLOG-2209: default to a GRANTED SMS permission so the proactive check is a
  // no-op for every pre-existing test; the 2209 cases below flip it to revoked.
  grantSms();
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
    mockReadSmsMessages.mockResolvedValue(okRead(backlog));

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
    mockReadSmsMessages.mockResolvedValue(okRead(batch));
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
    mockReadSmsMessages.mockResolvedValue(okRead(batch));
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
    mockReadSmsMessages.mockResolvedValue(okRead([msg(9999, 99_000)]));

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
      return okRead([msg(9001, 9_000)].slice(0, Math.max(0, maxCount ?? 0)));
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
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 7_000), msg(2, 7_100)]));

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
    mockReadSmsMessages.mockResolvedValue(okRead(backlog));

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
    mockReadSmsMessages.mockResolvedValue(okRead([]));
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
    mockReadSmsMessages.mockResolvedValue(okRead([]));
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
    mockReadSmsMessages.mockResolvedValue(okRead([]));

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
    mockReadSmsMessages.mockResolvedValue(okRead([]));
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
    mockReadSmsMessages.mockResolvedValue(okRead([]));

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

// ===========================================================================
// Read FAILURE is never conflated with zero-results (BACKLOG-2206)
// ===========================================================================
describe('SMS read failure vs zero-results (BACKLOG-2206)', () => {
  it('a read failure does NOT count as a successful sync: freshness unchanged, 2203 streak +1, cursor held, readError surfaced', async () => {
    await setPaired();

    // Baseline: a healthy empty-inbox cycle stamps lastSuccessfulSyncAt and
    // clears the failure streak, so we can prove the failure cycle does not.
    mockReadSmsMessages.mockResolvedValueOnce(okRead([]));
    await performSync();
    const healthy = await getSyncStats();
    expect(healthy.lastSuccessfulSyncAt).not.toBeNull();
    expect(healthy.consecutiveFailures).toBe(0);
    const cursorBefore = await getLastSyncTimestamp();

    // Now the read FAILS (permission revoked mid-run). Desktop is still up.
    mockReadSmsMessages.mockResolvedValueOnce(
      failRead('permission_denied', 'READ_SMS permission denied'),
    );
    const result = await performSync();

    // Surfaced as a read error (user-facing state), NOT a false "all synced".
    expect(result.readError?.reason).toBe('permission_denied');
    // Captured for diagnosis.
    expect(Sentry.captureException).toHaveBeenCalled();

    const failed = await getSyncStats();
    // Staleness clock NOT reset — lastSuccessfulSyncAt is byte-identical.
    expect(failed.lastSuccessfulSyncAt).toBe(healthy.lastSuccessfulSyncAt);
    // The 2203 failure streak advanced by exactly one.
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.firstFailureTime).not.toBeNull();
    // Cursor did not advance over history we never actually read.
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);
  });

  it('a genuine empty inbox with a reachable desktop IS a success (freshness advances, no readError)', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue(okRead([]));

    const result = await performSync();

    expect(result.readError).toBeUndefined();
    expect(result.desktopReachable).toBe(true);
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).not.toBeNull(); // advanced
    expect(stats.consecutiveFailures).toBe(0); // healthy
  });

  it('still flushes already-queued messages on a read failure, but the cycle stays unhealthy', async () => {
    await setPaired();
    // A message queued by a prior cycle is still deliverable this cycle.
    await enqueueMessages([msg(1, 100)]);
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });
    // This cycle's read fails outright (native module gone — the 1448 class).
    mockReadSmsMessages.mockResolvedValue(failRead('module_unavailable'));

    const result = await performSync();

    // The already-queued message WAS delivered (delivery is orthogonal to read).
    expect(result.sentMessages).toBe(1);
    // ...but the read failure still marks the cycle as not a healthy reach.
    expect(result.readError?.reason).toBe('module_unavailable');
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).toBeNull(); // never advanced (read failed)
    expect(stats.consecutiveFailures).toBe(1);
  });

  it('a read failure when the desktop is ALSO unreachable extends the streak and carries the readError', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // desktop down
    mockReadSmsMessages.mockResolvedValue(failRead('query_failed', 'cursor error'));

    const result = await performSync();

    // Connection error is the primary (more actionable) message...
    expect(result.desktopReachable).toBe(false);
    expect(result.errorType).toBe('connection_refused');
    // ...but the read failure is still carried for surfacing/diagnosis.
    expect(result.readError?.reason).toBe('query_failed');
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).toBeNull();
    expect(stats.consecutiveFailures).toBe(1);
  });
});

// ===========================================================================
// Identity source: sync uses the adopted deviceId, not deviceName (BACKLOG-2210)
// ===========================================================================
describe('loadPairingInfo prefers the desktop-minted deviceId (BACKLOG-2210)', () => {
  const MINTED = '11111111-2222-3333-4444-555555555555';

  it('uses the adopted UUID as the sync-payload deviceId when present', async () => {
    await setPairedWithDeviceId(MINTED);
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 100)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });

    await performSync();

    expect(mockSendMessages).toHaveBeenCalledTimes(1);
    // The identity carried on the wire is the minted UUID, not the desktop name.
    expect(mockSendMessages.mock.calls[0][1].deviceId).toBe(MINTED);
  });

  it('falls back to deviceName for a legacy pairing that never adopted an id', async () => {
    await setPaired(); // stored WITHOUT a deviceId field
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 100)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });

    await performSync();

    expect(mockSendMessages).toHaveBeenCalledTimes(1);
    expect(mockSendMessages.mock.calls[0][1].deviceId).toBe('desk');
  });
});

// ===========================================================================
// Distinguish desktop-down (a) vs phone-offline (b) on a failed reach
// (BACKLOG-2296). The classifier checks the PHONE's own Wi-Fi state FIRST so an
// offline phone is never wrongly told "desktop not running", while a 403 account
// rejection (2284) is never reclassified as a reachability failure.
// ===========================================================================
describe('desktop-down vs phone-offline classification (BACKLOG-2296)', () => {
  it('ping fails + phone IS on Wi-Fi → connection_refused (case a, "reach Keepr"), NOT phone_offline', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // desktop unreachable
    mockIsPhoneOnLocalNetwork.mockResolvedValue(true); // phone on Wi-Fi

    const result = await performSync();

    expect(result.desktopReachable).toBe(false);
    expect(result.errorType).toBe('connection_refused');
    expect(result.error).toMatch(/reach Keepr/i);
  });

  it('ping fails + phone is OFF Wi-Fi → phone_offline (case b, "not connected to Wi-Fi")', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false); // ping cannot succeed off-Wi-Fi
    mockIsPhoneOnLocalNetwork.mockResolvedValue(false); // phone has no Wi-Fi

    const result = await performSync();

    expect(result.desktopReachable).toBe(false);
    // The founder's core fix: NOT misreported as "desktop not running".
    expect(result.errorType).toBe('phone_offline');
    expect(result.error).toMatch(/not connected to Wi-Fi/i);
    expect(result.error).not.toMatch(/desktop app is not running/i);
  });

  it('read failure + phone OFF Wi-Fi → phone_offline (still carries the readError)', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(false);
    mockIsPhoneOnLocalNetwork.mockResolvedValue(false);
    mockReadSmsMessages.mockResolvedValue(failRead('query_failed', 'cursor error'));

    const result = await performSync();

    expect(result.errorType).toBe('phone_offline');
    // The read failure is still surfaced/diagnosed alongside the offline cause.
    expect(result.readError?.reason).toBe('query_failed');
    const stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(1);
  });

  it('ping passes but a batch send fails at the transport level while the phone drops Wi-Fi → phone_offline', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(true); // reached at ping time
    await enqueueMessages([msg(1, 100)]);
    // The send then fails as a transport error...
    mockSendMessages.mockResolvedValue({
      success: false,
      error: 'Desktop app is not running. Open Keepr on your computer and try again.',
      errorType: 'connection_refused',
    });
    // ...and the phone is found to be off Wi-Fi by the time we re-check.
    mockIsPhoneOnLocalNetwork.mockResolvedValue(false);

    const result = await performSync();

    expect(result.errorType).toBe('phone_offline');
    expect(result.error).toMatch(/not connected to Wi-Fi/i);
  });

  it('a 403 account rejection (server_error) is NEVER reclassified, even if the phone is off Wi-Fi (2284 guard)', async () => {
    await setPaired();
    mockPingDesktop.mockResolvedValue(true); // desktop reached and answered
    await enqueueMessages([msg(1, 100)]);
    // The desktop authoritatively rejects the account with a 403 → server_error.
    mockSendMessages.mockResolvedValue({
      success: false,
      error: 'Server responded with 403: account mismatch',
      errorType: 'server_error',
    });
    // Even with the phone reported off Wi-Fi, a server_error must stay put.
    mockIsPhoneOnLocalNetwork.mockResolvedValue(false);

    const result = await performSync();

    expect(result.errorType).toBe('server_error');
    expect(result.errorType).not.toBe('phone_offline');
    // The connectivity classifier must not even be consulted for a server_error.
    expect(mockIsPhoneOnLocalNetwork).not.toHaveBeenCalled();
  });

  it('a healthy sync (desktop reachable, on Wi-Fi) surfaces NO disconnected error', async () => {
    await setPaired();
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 100)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });

    const result = await performSync();

    expect(result.desktopReachable).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.errorType).toBeUndefined();
  });
});

// ===========================================================================
// Proactive SMS-permission re-check each sync cycle (BACKLOG-2209)
//
// If the user REVOKES READ_SMS in Android Settings after pairing, reads would
// otherwise fail mid-run (2206) or silently return [] on some OEMs — looking
// like "no new messages". 2209 adds the PROACTIVE half: check the permission at
// the START of every cycle, BEFORE any read. A revocation is funneled through
// the SAME `permission_denied` SmsReadError surface 2206 built (NOT a parallel
// signal), so it is counted as a failed reach and drives the SAME banner.
// ===========================================================================
describe('proactive SMS-permission re-check (BACKLOG-2209)', () => {
  it('permission revoked → short-circuits the cycle: NO read attempted, health held (freshness held, streak +1, cursor held), readError surfaced via the 2206 surface', async () => {
    await setPaired();

    // Baseline: one healthy granted cycle stamps freshness + clears the streak,
    // so we can prove the revoked cycle neither advances freshness nor the cursor.
    grantSms();
    mockReadSmsMessages.mockResolvedValueOnce(okRead([msg(1, 500)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });
    await performSync();
    const healthy = await getSyncStats();
    expect(healthy.lastSuccessfulSyncAt).not.toBeNull();
    expect(healthy.consecutiveFailures).toBe(0);
    const cursorBefore = await getLastSyncTimestamp();

    // Now the user revokes SMS access in Settings. Desktop is still reachable.
    revokeSms();
    mockReadSmsMessages.mockClear();
    const result = await performSync();

    // The native read is NEVER attempted — we short-circuited before it.
    expect(mockReadSmsMessages).not.toHaveBeenCalled();
    expect(result.newMessages).toBe(0);

    // Surfaced through the EXACT 2206 result surface (same discriminated type /
    // reason), NOT a parallel field — this is what feeds the home banner.
    expect(result.readError?.reason).toBe('permission_denied');
    // Captured for diagnosis (tagged source: proactive_check in the impl).
    expect(Sentry.captureException).toHaveBeenCalled();

    const failed = await getSyncStats();
    // Not a healthy reach: freshness clock NOT reset (byte-identical)...
    expect(failed.lastSuccessfulSyncAt).toBe(healthy.lastSuccessfulSyncAt);
    // ...the 2203 streak advanced by exactly one...
    expect(failed.consecutiveFailures).toBe(1);
    // ...and the cursor did NOT move over history we never read.
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);
  });

  it('permission revoked but the desktop is reachable → still flushes already-queued messages, but the cycle stays unhealthy', async () => {
    await setPaired();
    // A message queued by an earlier cycle is still deliverable this cycle.
    await enqueueMessages([msg(1, 100)]);
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });

    revokeSms();
    const result = await performSync();

    // Delivery is orthogonal to the read: the queued message WAS sent...
    expect(result.sentMessages).toBe(1);
    // ...but the proactive permission failure keeps the cycle unhealthy, and the
    // read was never attempted.
    expect(mockReadSmsMessages).not.toHaveBeenCalled();
    expect(result.readError?.reason).toBe('permission_denied');
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).toBeNull(); // never advanced
    expect(stats.consecutiveFailures).toBe(1);
  });

  it('permission granted → a normal sync runs (the read IS attempted, no readError)', async () => {
    await setPaired();
    grantSms();
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 700), msg(2, 800)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 2 });

    const result = await performSync();

    expect(mockReadSmsMessages).toHaveBeenCalledTimes(1);
    expect(result.readError).toBeUndefined();
    expect(result.sentMessages).toBe(2);
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).not.toBeNull();
    expect(stats.consecutiveFailures).toBe(0);
  });

  it('re-grant after a revocation → the banner state clears and sync resumes (read attempted again, no readError, streak reset)', async () => {
    await setPaired();

    // Cycle 1: revoked — short-circuit, unhealthy, readError set.
    revokeSms();
    const revoked = await performSync();
    expect(revoked.readError?.reason).toBe('permission_denied');
    expect((await getSyncStats()).consecutiveFailures).toBe(1);

    // Cycle 2: the user re-grants in Settings. The very next cycle must resume:
    // the read is attempted again, the readError is cleared (banner state gone),
    // and the healthy reach resets the failure streak.
    grantSms();
    mockReadSmsMessages.mockResolvedValue(okRead([msg(9, 9_000)]));
    mockSendMessages.mockResolvedValue({ success: true, messagesReceived: 1 });

    const resumed = await performSync();

    expect(mockReadSmsMessages).toHaveBeenCalledTimes(1);
    expect(resumed.readError).toBeUndefined();
    expect(resumed.sentMessages).toBe(1);
    const stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(0); // recovered
    expect(stats.lastSuccessfulSyncAt).not.toBeNull();
  });

  it('does NOT read when revoked even with plenty of queue capacity (proactive gate precedes the back-pressure/read path)', async () => {
    await setPaired();
    revokeSms();
    // Reader would return data if called — assert it is never consulted.
    mockReadSmsMessages.mockResolvedValue(okRead([msg(1, 100)]));

    const result = await performSync();

    expect(mockReadSmsMessages).not.toHaveBeenCalled();
    expect(result.readError?.reason).toBe('permission_denied');
    expect(result.newMessages).toBe(0);
  });
});
