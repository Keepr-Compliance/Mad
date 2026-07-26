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
  getQueueSize,
  getLastSyncTimestamp,
  setLastSyncTimestamp,
  getRemainingQueueCapacity,
  isQueueAtCapacity,
  acquireSyncLock,
  releaseSyncLock,
  messageIdentity,
  MAX_QUEUE_SIZE,
  MAX_BATCH_SIZE,
  SYNC_LOCK_TTL_MS,
} from '../smsQueueService';

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
