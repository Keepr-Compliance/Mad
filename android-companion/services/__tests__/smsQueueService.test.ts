/**
 * Lossless / race-free SMS sync — behavioural guards for BACKLOG-2199 + 2200.
 *
 * These tests pin the CORRECTED invariants of the sync pipeline:
 *
 *   INVARIANT: a message moves *behind* the read cursor only once it is durably
 *   captured in the queue (never dropped), and it leaves the pipeline for good
 *   only once its batch is sent AND acknowledged by the desktop. Exactly one
 *   sync mutates the queue/cursor at a time.
 *
 * They assert IDENTITY (exact message ID-SETs), never bare counts — a matching
 * count with the wrong IDs is a false pass (founder directive / BACKLOG-1977).
 *
 * BACKLOG-2199 (C1): the cursor used to advance at ENQUEUE time and the queue
 *   trimmed its OLDEST entries at MAX_QUEUE_SIZE — so an offline desktop + a
 *   large backlog silently lost the oldest un-synced messages. Fixed: enqueue
 *   is idempotent and never trims; back-pressure bounds reads; the cursor
 *   advances only over durably-captured messages.
 * BACKLOG-2200 (C2): performSync had no cross-context lock, so overlapping runs
 *   double-sent a batch or clobbered each other's queue write. Fixed: a
 *   persisted best-effort mutex serialises the whole cycle.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage } from '../../types/sync';

// ---------------------------------------------------------------------------
// Stateful in-memory AsyncStorage mock.
//
// A realistic store is essential here: the bugs under test are non-atomic
// read-modify-write races, so the mock must actually persist between calls
// (a plain jest.fn() returning undefined would hide the very behaviour we test).
// ---------------------------------------------------------------------------
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
      // Test-only helper to reset between cases.
      __reset: () => {
        store = {};
      },
    },
  };
});

// Convenience typed handle to the mock's reset helper.
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

import {
  enqueueMessages,
  dequeueBatch,
  requeueMessages,
  getQueue,
  readQueue,
  clearQueue,
  QueueUnreadableError,
  getQueueSize,
  getLastSyncTimestamp,
  setLastSyncTimestamp,
  getRemainingQueueCapacity,
  isQueueAtCapacity,
  acquireSyncLock,
  releaseSyncLock,
  messageIdentity,
  recordSyncAttempt,
  getSyncStats,
  MAX_QUEUE_SIZE,
  MAX_BATCH_SIZE,
  SYNC_LOCK_TTL_MS,
} from '../smsQueueService';
import { rawToSyncMessage, type RawSmsRecord } from '../smsReader';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a SyncMessage with a stable smsId so tests can assert exact ID-SETs. */
function msg(id: number, timestamp = 1_000 + id): SyncMessage {
  return {
    smsId: String(id),
    sender: `+1555000${String(id).padStart(4, '0')}`,
    body: `message ${id}`,
    timestamp,
    threadId: 't1',
    direction: 'inbound',
  };
}

/** Extract the exact set of smsIds from a message array. */
function idSet(messages: SyncMessage[]): Set<string> {
  return new Set(messages.map((m) => m.smsId as string));
}

/** Build N messages with ids [start .. start+n-1]. */
function makeMany(n: number, start = 0): SyncMessage[] {
  return Array.from({ length: n }, (_, i) => msg(start + i));
}

/**
 * The one storage key the queue lives under. The module keeps it private, so
 * this is a transcription — and it is self-checking: if it ever stopped
 * matching, `withUnreadableQueue` below would inject no failure at all and the
 * BACKLOG-3070 controls would fail rather than pass vacuously. Pinned directly
 * in `a genuinely absent key ...` too.
 */
const QUEUE_KEY = '@keepr/sms-queue';

/**
 * Run `fn` with the QUEUE's storage read failing, then restore the working
 * store so the surviving bytes can be read back and asserted.
 *
 * Two distinct real failure paths, both of which reached the same swallowed
 * `catch` before BACKLOG-3070:
 *   - an `Error` -> `AsyncStorage.getItem` REJECTS (the device shape is
 *     `SQLiteBlobTooBigException: Row too big to fit into CursorWindow`);
 *   - a `string` -> bytes come back but `JSON.parse` cannot use them.
 *
 * Only the queue key is affected; every other key passes through to the real
 * in-memory store, so nothing else in the call is disturbed.
 */
async function withUnreadableQueue<T>(
  failure: Error | string,
  fn: () => Promise<T>,
): Promise<T> {
  const getItem = AsyncStorage.getItem as jest.Mock;
  const working = getItem.getMockImplementation() as (
    k: string,
  ) => Promise<string | null>;
  getItem.mockImplementation(async (k: string) => {
    if (k === QUEUE_KEY) {
      if (failure instanceof Error) throw failure;
      return failure;
    }
    return working(k);
  });
  try {
    return await fn();
  } finally {
    getItem.mockImplementation(working);
  }
}

/** The stored queue as it actually sits on disk, read back after a failure. */
async function storedQueue(): Promise<SyncMessage[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return JSON.parse(raw as string) as SyncMessage[];
}

/** The device's own words for the read that BACKLOG-3070 exists for. */
const cursorWindowFailure = (): Error =>
  new Error('Row too big to fit into CursorWindow');

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});

// ===========================================================================
// 1. enqueue -> dequeue -> requeue preserves the EXACT message ID-SET
// ===========================================================================
describe('queue round-trip preserves the exact message ID-SET (identity, not count)', () => {
  it('dequeue then requeue on failure loses no message and adds none', async () => {
    const original = makeMany(10);
    await enqueueMessages(original);

    const batch = await dequeueBatch();
    // Simulate a send FAILURE — the batch must return intact.
    await requeueMessages(batch);

    const finalQueue = await getQueue();

    // Exact ID-SET equality — same messages, no loss, no duplication.
    expect(idSet(finalQueue)).toEqual(idSet(original));
    expect(finalQueue).toHaveLength(original.length);
  });

  it('requeue restores FIFO order (failed batch goes back to the front, oldest-first)', async () => {
    await enqueueMessages(makeMany(3)); // ids 0,1,2 (oldest-first)

    const batch = await dequeueBatch(); // [0,1,2]
    await requeueMessages(batch);

    const q = await getQueue();
    expect(q.map((m) => m.smsId)).toEqual(['0', '1', '2']);
  });

  it('a partial drain (dequeue one batch, ack it) leaves exactly the remainder', async () => {
    const all = makeMany(MAX_BATCH_SIZE + 10); // 60 messages
    await enqueueMessages(all);

    const first = await dequeueBatch(); // 50 messages, acked (not requeued)
    expect(first).toHaveLength(MAX_BATCH_SIZE);

    const remaining = await getQueue();
    // The acked batch is gone; the remaining 10 are exactly the tail.
    const expectedRemainder = idSet(all.slice(MAX_BATCH_SIZE));
    expect(idSet(remaining)).toEqual(expectedRemainder);
  });
});

// ===========================================================================
// 2. Overflow NEVER drops an un-acked message (BACKLOG-2199 core)
// ===========================================================================
describe('overflow never silently drops un-synced messages', () => {
  it('enqueue does NOT trim the queue when it exceeds MAX_QUEUE_SIZE', async () => {
    const oversized = makeMany(MAX_QUEUE_SIZE + 50); // 550 messages
    await enqueueMessages(oversized);

    const q = await getQueue();
    // The OLD behaviour trimmed to 500 dropping the oldest 50. The FIX keeps
    // every message — overflow is handled by back-pressure upstream, not drops.
    expect(q).toHaveLength(MAX_QUEUE_SIZE + 50);
    expect(idSet(q)).toEqual(idSet(oversized));

    // Critically: the OLDEST messages (ids 0..49) are still present.
    const oldestIds = new Set(makeMany(50).map((m) => m.smsId as string));
    for (const id of oldestIds) {
      expect(q.some((m) => m.smsId === id)).toBe(true);
    }
  });

  it('requeue does NOT trim either', async () => {
    await enqueueMessages(makeMany(MAX_QUEUE_SIZE)); // exactly full
    const extra = makeMany(30, MAX_QUEUE_SIZE); // ids 500..529, disjoint
    await requeueMessages(extra);

    const q = await getQueue();
    expect(q).toHaveLength(MAX_QUEUE_SIZE + 30);
    // The prepended extras and the original set both survive in full.
    expect(idSet(q)).toEqual(
      idSet([...makeMany(MAX_QUEUE_SIZE), ...extra]),
    );
  });

  it('back-pressure signals when the queue is at capacity (so callers stop reading)', async () => {
    expect(await isQueueAtCapacity()).toBe(false);
    expect(await getRemainingQueueCapacity()).toBe(MAX_QUEUE_SIZE);

    await enqueueMessages(makeMany(MAX_QUEUE_SIZE));
    expect(await isQueueAtCapacity()).toBe(true);
    expect(await getRemainingQueueCapacity()).toBe(0);
  });
});

// ===========================================================================
// 3. Idempotent enqueue — a boundary re-read cannot double-capture a message
// ===========================================================================
describe('idempotent enqueue', () => {
  it('skips messages whose identity is already queued', async () => {
    const first = makeMany(5); // ids 0..4
    const appended = await enqueueMessages(first);
    expect(appended).toBe(5);

    // Re-enqueue an overlapping window (ids 3..7): 3,4 already queued.
    const overlap = makeMany(5, 3); // ids 3..7
    const appended2 = await enqueueMessages(overlap);
    expect(appended2).toBe(3); // only 5,6,7 are new

    const q = await getQueue();
    expect(idSet(q)).toEqual(idSet(makeMany(8))); // ids 0..7, no dupes
    expect(q).toHaveLength(8);
  });

  it('de-dupes duplicates WITHIN a single enqueue batch', async () => {
    const dup = [msg(1), msg(1), msg(2)];
    const appended = await enqueueMessages(dup);
    expect(appended).toBe(2);
    expect((await getQueue()).map((m) => m.smsId)).toEqual(['1', '2']);
  });

  it('falls back to sender|timestamp|body identity when smsId is absent', () => {
    const withId = { ...msg(1), smsId: '1' };
    const withoutId: SyncMessage = {
      sender: '+15550001',
      body: 'hi',
      timestamp: 42,
      direction: 'inbound',
    };
    expect(messageIdentity(withId)).toBe('id:1');
    expect(messageIdentity(withoutId)).toBe('c:+15550001|42|hi');
  });
});

// ===========================================================================
// 3b. Re-sync of the SAME underlying SMS is a no-op through the real read path
//     (BACKLOG-2202). Exercises rawToSyncMessage -> enqueueMessages end-to-end
//     for the composite-identity path (no `_id`), which is exactly what the
//     desktop dedups on. Under the old Date.now() fallback each read produced a
//     different timestamp -> different identity -> a phantom duplicate.
// ===========================================================================
describe('re-sync of the same SMS does not duplicate (BACKLOG-2202)', () => {
  /** A date-less, _id-less raw row -> forces the composite identity path. */
  const datelessRaw: RawSmsRecord = {
    _id: '', // no stable provider row id -> composite fallback
    thread_id: '10',
    address: '+15555550112',
    body: 'carrier alert with no date',
    date: '',
    date_sent: '',
    type: '1',
    read: '1',
  };

  it('two independent reads of the same date-less SMS enqueue only once', async () => {
    // Simulate two separate sync cycles reading the SAME provider row, with the
    // wall clock advancing between them (the old bug leaked this into the id).
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(9000);

    const firstRead = rawToSyncMessage(datelessRaw, 'inbox');
    const appended1 = await enqueueMessages([firstRead]);
    expect(appended1).toBe(1); // first time -> queued

    const secondRead = rawToSyncMessage(datelessRaw, 'inbox');
    const appended2 = await enqueueMessages([secondRead]);
    expect(appended2).toBe(0); // same message -> deduped, no duplicate

    // Identity is stable across reads, and the queue holds exactly one entry.
    expect(messageIdentity(secondRead)).toBe(messageIdentity(firstRead));
    expect(await getQueueSize()).toBe(1);

    jest.restoreAllMocks();
  });

  it('a genuinely different date-less SMS is NOT deduped against the first', async () => {
    const a = rawToSyncMessage(datelessRaw, 'inbox');
    const b = rawToSyncMessage(
      { ...datelessRaw, body: 'a different alert' },
      'inbox'
    );
    expect(await enqueueMessages([a])).toBe(1);
    expect(await enqueueMessages([b])).toBe(1); // distinct body -> distinct id
    expect(await getQueueSize()).toBe(2);
    expect(messageIdentity(b)).not.toBe(messageIdentity(a));
  });
});

// ===========================================================================
// 4. The persisted sync lock (BACKLOG-2200)
// ===========================================================================
describe('sync lock (mutual exclusion across contexts)', () => {
  it('a second acquire is refused while the first holder is fresh', async () => {
    const a = await acquireSyncLock();
    expect(a).not.toBeNull();

    const b = await acquireSyncLock();
    expect(b).toBeNull(); // held by A — B must back off
  });

  it('release lets the next caller acquire', async () => {
    const a = await acquireSyncLock();
    expect(a).not.toBeNull();
    await releaseSyncLock(a as string);

    const b = await acquireSyncLock();
    expect(b).not.toBeNull();
  });

  it('a stale lock (older than TTL) is force-broken so sync cannot deadlock', async () => {
    const t0 = 1_000_000;
    const a = await acquireSyncLock(t0);
    expect(a).not.toBeNull();

    // A crashed without releasing. A caller arriving after the TTL breaks it.
    const later = t0 + SYNC_LOCK_TTL_MS + 1;
    const b = await acquireSyncLock(later);
    expect(b).not.toBeNull(); // stale lock stolen — no permanent deadlock
  });

  it('releasing with a stale nonce does NOT stomp a newer holder', async () => {
    const t0 = 1_000_000;
    const a = await acquireSyncLock(t0); // holder A
    const b = await acquireSyncLock(t0 + SYNC_LOCK_TTL_MS + 1); // steals it, holder B
    expect(b).not.toBeNull();

    // A (now stale) tries to release — must be a no-op, B keeps the lock.
    await releaseSyncLock(a as string);
    const c = await acquireSyncLock(t0 + SYNC_LOCK_TTL_MS + 2);
    expect(c).toBeNull(); // B still holds it
  });
});

// ===========================================================================
// 5. Boundary-safe cursor semantics (helpers) — SR review Note D
//    (The end-to-end cursor advance is covered in backgroundSync.test.ts, but
//     these pin the storage-level round-trip the advance relies on.)
// ===========================================================================
describe('cursor is a plain, honest watermark', () => {
  it('round-trips and defaults to 0 when unset', async () => {
    expect(await getLastSyncTimestamp()).toBe(0);
    await setLastSyncTimestamp(12_345);
    expect(await getLastSyncTimestamp()).toBe(12_345);
  });

  it('queue size reflects reality for the back-pressure budget', async () => {
    await enqueueMessages(makeMany(3));
    expect(await getQueueSize()).toBe(3);
    expect(await getRemainingQueueCapacity()).toBe(MAX_QUEUE_SIZE - 3);
  });
});

// ===========================================================================
// 6. Staleness signal — lastSuccessfulSyncAt (BACKLOG-2204)
//    lastSyncTime tracks message-SENDS; lastSuccessfulSyncAt tracks whether we
//    still reach the desktop at all, even on an idle "nothing new" cycle.
// ===========================================================================
describe('sync stats: lastSuccessfulSyncAt is the staleness signal', () => {
  it('defaults to null (and back-fills for pre-2204 stats via default-merge)', async () => {
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).toBeNull();
  });

  it('advances lastSuccessfulSyncAt when a cycle reaches the desktop, even with 0 messages', async () => {
    // A healthy idle cycle: nothing sent, but the desktop WAS reached.
    await recordSyncAttempt(false, 0, true);
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).not.toBeNull();
    // lastSyncTime (message-send watermark) must NOT advance on a 0-message cycle.
    expect(stats.lastSyncTime).toBeNull();
  });

  it('does NOT advance lastSuccessfulSyncAt when the desktop was unreachable', async () => {
    await recordSyncAttempt(false, 0, false);
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).toBeNull();
  });

  it('advances both timestamps when messages are sent AND the desktop is reached', async () => {
    await recordSyncAttempt(true, 5, true);
    const stats = await getSyncStats();
    expect(stats.lastSuccessfulSyncAt).not.toBeNull();
    expect(stats.lastSyncTime).not.toBeNull();
    expect(stats.totalSynced).toBe(5);
  });
});

// ===========================================================================
// 7. Connection-health failure streak (BACKLOG-2203)
//    consecutiveFailures/firstFailureTime live here (not in pairingManager) so
//    the sync cycle can update them WITHOUT importing pairingManager — avoiding
//    the backgroundSync<->pairingManager cycle 2204 avoided. Driven off the SAME
//    `reachedDesktop` signal as lastSuccessfulSyncAt, so they never disagree.
// ===========================================================================
describe('sync stats: connection-health failure streak (BACKLOG-2203)', () => {
  it('increments consecutiveFailures + stamps firstFailureTime when the desktop is unreachable', async () => {
    await recordSyncAttempt(false, 0, false);
    let stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(1);
    expect(stats.firstFailureTime).not.toBeNull();
    const firstStamp = stats.firstFailureTime;

    await recordSyncAttempt(false, 0, false);
    stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(2);
    // firstFailureTime marks the START of the streak — it is NOT re-stamped.
    expect(stats.firstFailureTime).toBe(firstStamp);
  });

  it('resets the streak the moment a cycle reaches the desktop', async () => {
    await recordSyncAttempt(false, 0, false);
    await recordSyncAttempt(false, 0, false);
    expect((await getSyncStats()).consecutiveFailures).toBe(2);

    await recordSyncAttempt(false, 0, true); // reached -> reset
    const stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.firstFailureTime).toBeNull();
  });

  it('defaults consecutiveFailures/firstFailureTime for pre-2203 stats (default-merge)', async () => {
    const stats = await getSyncStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.firstFailureTime).toBeNull();
  });
});

// ===========================================================================
// 7. A failed queue read is NEVER an empty queue (BACKLOG-3070)
//
//    `getQueue` was `try { ... } catch { return []; }`, so any read failure
//    became "the queue is empty" — and `enqueueMessages` then wrote
//    `[...[], ...toAppend]` over the stored value, destroying the un-synced
//    backlog while the SMS cursor kept advancing past messages that were never
//    delivered. The same drop-oldest loss BACKLOG-2199 removed, reintroduced
//    through a swallowed exception instead of a trim.
//
//    These assert IDENTITY (exact ID-SETs) like the rest of this file: a
//    surviving COUNT is satisfied by the wrong messages surviving.
// ===========================================================================
describe('a failed queue read is never mistaken for an empty queue', () => {
  it('a storage read failure does NOT let an append overwrite the un-synced backlog', async () => {
    const seeded = makeMany(10); // ids 0..9, un-synced
    await enqueueMessages(seeded);

    const setItem = AsyncStorage.setItem as jest.Mock;
    setItem.mockClear();

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      // The CALL's outcome is pinned separately below, so this control fails on
      // the data being destroyed rather than on a missing throw.
      await enqueueMessages([msg(999)]).catch(() => undefined);
    });

    const stored = await storedQueue();
    // Pre-fix this set is exactly {999}: the ten un-synced messages are gone.
    expect(idSet(stored)).toEqual(idSet(seeded));
    expect(stored.some((m) => m.smsId === '999')).toBe(false);

    // Nothing was written over bytes we failed to read.
    expect(
      setItem.mock.calls.filter((c: unknown[]) => c[0] === QUEUE_KEY),
    ).toHaveLength(0);
  });

  it('unparseable stored bytes do NOT let an append overwrite the backlog either', async () => {
    const seeded = makeMany(6);
    await enqueueMessages(seeded);

    await withUnreadableQueue('[{"smsId":"0","sen', async () => {
      await enqueueMessages([msg(999)]).catch(() => undefined);
    });

    expect(idSet(await storedQueue())).toEqual(idSet(seeded));
  });

  it('enqueue REJECTS instead of reporting a successful append', async () => {
    await enqueueMessages(makeMany(3));

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      // Pre-fix this RESOLVES with 1 — the caller is told the message is safely
      // queued at the moment the queue is destroyed.
      await expect(enqueueMessages([msg(999)])).rejects.toBeInstanceOf(
        QueueUnreadableError,
      );
    });
  });

  it('readQueue reports WHY it failed rather than returning an empty queue', async () => {
    await enqueueMessages(makeMany(3));

    const rejected = await withUnreadableQueue(cursorWindowFailure(), () =>
      readQueue(),
    );
    if (rejected.ok) throw new Error('expected the storage read to fail');
    expect(rejected.error.reason).toBe('storage_failed');
    expect(rejected.error.message).toContain('CursorWindow');

    const corrupt = await withUnreadableQueue('[{"smsId":"0","sen', () =>
      readQueue(),
    );
    if (corrupt.ok) throw new Error('expected the parse to fail');
    expect(corrupt.error.reason).toBe('parse_failed');

    // CLASSIFICATION only, not a destruction control: a value that parses to a
    // non-array threw a TypeError downstream even before the fix, so it never
    // reached the overwrite.
    const notArray = await withUnreadableQueue('{"queue":[]}', () =>
      readQueue(),
    );
    if (notArray.ok) throw new Error('expected a non-array to be rejected');
    expect(notArray.error.reason).toBe('parse_failed');
  });

  it('getQueue rejects rather than returning [] when the read fails', async () => {
    await enqueueMessages(makeMany(3));

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      await expect(getQueue()).rejects.toBeInstanceOf(QueueUnreadableError);
    });
  });

  it('requeue does not write ONE failed batch over a backlog it could not read', async () => {
    // Not named in the item: `requeueMessages` has the identical overwrite —
    // on a swallowed read it wrote `[...prependable]` over the stored value, so
    // returning one failed batch destroyed every other un-synced message.
    const seeded = makeMany(10);
    await enqueueMessages(seeded);
    const failedBatch = makeMany(3, 900); // ids 900..902, disjoint

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      await requeueMessages(failedBatch).catch(() => undefined);
    });

    expect(idSet(await storedQueue())).toEqual(idSet(seeded));
  });

  it('dequeue reports the failure instead of a healthy-looking empty batch', async () => {
    const seeded = makeMany(4);
    await enqueueMessages(seeded);

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      await expect(dequeueBatch()).rejects.toBeInstanceOf(QueueUnreadableError);
    });

    expect(idSet(await storedQueue())).toEqual(idSet(seeded));
  });

  it('an unreadable queue never reports empty capacity (the cursor-advance link)', async () => {
    // This is how a swallowed read reached the cursor: size 0 -> full remaining
    // capacity -> performSync reads a fresh batch of SMS -> enqueue overwrites
    // -> setLastSyncTimestamp advances past messages that were never delivered.
    await enqueueMessages(makeMany(MAX_QUEUE_SIZE));

    await withUnreadableQueue(cursorWindowFailure(), async () => {
      await expect(getQueueSize()).rejects.toBeInstanceOf(QueueUnreadableError);
      await expect(getRemainingQueueCapacity()).rejects.toBeInstanceOf(
        QueueUnreadableError,
      );
      await expect(isQueueAtCapacity()).rejects.toBeInstanceOf(
        QueueUnreadableError,
      );
    });
  });

  it('a genuinely absent key is still an empty queue, and a good read still round-trips', async () => {
    // Never written: nothing failed, so there is nothing to preserve.
    expect(await readQueue()).toEqual({ ok: true, messages: [] });
    expect(await getQueue()).toEqual([]);
    expect(await getQueueSize()).toBe(0);

    const seeded = makeMany(5);
    await enqueueMessages(seeded);
    // Pins QUEUE_KEY against the module: the seed must land under this key.
    expect(await AsyncStorage.getItem(QUEUE_KEY)).not.toBeNull();

    const read = await readQueue();
    if (!read.ok) throw new Error('a healthy read must succeed');
    expect(idSet(read.messages)).toEqual(idSet(seeded));

    // Cleared (removeItem) is empty again, and still not a failure.
    await clearQueue();
    expect(await readQueue()).toEqual({ ok: true, messages: [] });
  });
});
