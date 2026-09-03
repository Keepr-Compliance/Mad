/**
 * SMS Queue Service (Android Companion)
 * Manages a local queue of SMS messages for reliable delivery to the desktop.
 *
 * TASK-1430: SMS BroadcastReceiver + background sync service
 *
 * Design:
 * - Messages are queued in AsyncStorage when the desktop is unreachable
 * - On sync: dequeue messages, encrypt, send via syncService
 * - Tracks last synced SMS timestamp to avoid re-sending
 * - Batches messages (up to 50 at a time) to avoid large payloads
 *
 * Storage keys:
 * - @keepr/sms-queue: Array of queued SyncMessage objects
 * - @keepr/last-sync-timestamp: Unix ms of the newest message successfully synced
 * - @keepr/sync-stats: Cumulative sync statistics
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SyncMessage } from "../types/sync";
import { resetContactSyncState } from "./contactSyncState";
import { clearSyncWindowCache, clearAppliedWindow } from "./syncWindow";

// ============================================
// CONSTANTS
// ============================================

const QUEUE_STORAGE_KEY = "@keepr/sms-queue";
const LAST_SYNC_TIMESTAMP_KEY = "@keepr/last-sync-timestamp";
const SYNC_STATS_KEY = "@keepr/sync-stats";
const SYNC_INTERVAL_KEY = "@keepr/sync-interval";
const BACKGROUND_SYNC_ENABLED_KEY = "@keepr/background-sync-enabled";
const SYNC_LOCK_KEY = "@keepr/sync-lock";

/** Maximum messages to send in a single batch */
export const MAX_BATCH_SIZE = 50;

/**
 * Maximum number of un-synced messages the local queue will hold.
 *
 * BACKLOG-2199: this is now a BACK-PRESSURE bound, NOT a drop threshold. When
 * the queue is at capacity the sync cycle stops reading new SMS (and does not
 * advance the cursor) so nothing is ever silently dropped — the un-read
 * remainder stays in the Android SMS provider until the desktop drains the
 * queue. Exported so `performSync` can compute the remaining read budget.
 */
export const MAX_QUEUE_SIZE = 500;

/**
 * How long a held sync lock is considered valid before it is treated as stale
 * and force-broken (BACKLOG-2200). Must comfortably exceed a worst-case sync
 * cycle (batched sends at REQUEST_TIMEOUT=10s each). 90s lets a crashed or
 * killed run's lock self-heal rather than deadlocking sync forever.
 */
export const SYNC_LOCK_TTL_MS = 90_000;

// ============================================
// TYPES
// ============================================

/** Cumulative sync statistics */
export interface SyncStats {
  /** Total messages successfully synced since pairing */
  totalSynced: number;
  /**
   * ISO timestamp of the last sync that actually SENT messages.
   * (Only advances when messageCount > 0 — kept for backward compatibility.)
   */
  lastSyncTime: string | null;
  /**
   * ISO timestamp of the last sync cycle that successfully reached the desktop,
   * regardless of whether there were any messages to send (BACKLOG-2204).
   *
   * This — not `lastSyncTime` — is the correct "are we still syncing?" signal
   * for the staleness surface: a healthy "nothing new to sync" cycle keeps this
   * fresh, whereas Doze/OEM killing background sync lets it go stale.
   */
  lastSuccessfulSyncAt: string | null;
  /** Number of sync attempts */
  syncAttempts: number;
  /** Number of successful sync attempts */
  successfulSyncs: number;
  /**
   * Number of CONSECUTIVE sync cycles that failed to reach the desktop, reset
   * to 0 the moment a cycle reaches it again (BACKLOG-2203).
   *
   * This is the companion's connection-HEALTH streak. It is deliberately kept
   * here — the one module that both the sync cycle and pairingManager already
   * depend on — rather than in pairingManager, so the sync cycle can update it
   * WITHOUT importing pairingManager (which would re-create the
   * backgroundSync<->pairingManager circular import 2204 deliberately avoided).
   * It is driven off the SAME `reachedDesktop` signal that advances
   * `lastSuccessfulSyncAt`, so health and staleness can never disagree.
   * pairingManager READS this (one-way) to derive getConnectionStatus /
   * getConsecutiveFailures / shouldAutoUnpair.
   */
  consecutiveFailures: number;
  /**
   * ISO timestamp of the FIRST failure in the current streak, or null when the
   * connection is healthy (BACKLOG-2203). Used to measure how long the
   * companion has been unable to reach the desktop.
   */
  firstFailureTime: string | null;
}

const DEFAULT_STATS: SyncStats = {
  totalSynced: 0,
  lastSyncTime: null,
  lastSuccessfulSyncAt: null,
  syncAttempts: 0,
  successfulSyncs: 0,
  consecutiveFailures: 0,
  firstFailureTime: null,
};

// ============================================
// QUEUE READ FAILURE (BACKLOG-3070)
// ============================================

/**
 * Why reading the queue FAILED — as distinct from a queue that is genuinely
 * empty.
 *
 * ## Why this type has to exist
 *
 * Until BACKLOG-3070 the read was `try { ... } catch { return []; }`, so ANY
 * failure became "the queue is empty". `enqueueMessages` then computed
 * `current = []` and wrote `[...[], ...toAppend]` straight over the stored
 * value: the un-synced backlog was destroyed, nothing surfaced, and the SMS
 * cursor kept advancing past messages that were never delivered. That is
 * exactly the drop-oldest behaviour BACKLOG-2199 removed, reintroduced through
 * a swallowed exception instead of a trim — 2199's no-drop guarantee rested
 * entirely on the assumption that this one read could never throw.
 *
 * It can. The queue is one JSON string under one AsyncStorage key, and
 * `@react-native-async-storage/async-storage` reads it through the framework
 * `SQLiteDatabase` -> `SQLiteCursor` -> `CursorWindow`, which throws
 * `SQLiteBlobTooBigException` for a row that will not fit the window
 * (`config_cursorWindowSize`, AOSP default 2048 KB, OEM-overridable). The
 * legacy write path is a bare `@Insert` with no read-back, so an oversized
 * value writes fine and only fails on the NEXT read. At ~100 KB for the
 * 500-message cap today's text-only queue is nowhere near that ceiling — which
 * is why this has never fired — but the ceiling is inherited, not measured, and
 * anything larger than text in the queue walks straight into it.
 *
 * This mirrors `ProviderReadErrorReason` in `providerRead.ts`, which exists for
 * the same reason on the content-provider side (BACKLOG-1448 / 2206): a failed
 * read is not an empty read, and collapsing the two hid a zero-message release
 * for weeks.
 */
export type QueueReadErrorReason =
  /** AsyncStorage itself rejected — the underlying SQLite read failed. */
  | "storage_failed"
  /** Bytes came back but are not a JSON array of messages. */
  | "parse_failed";

export interface QueueReadError {
  reason: QueueReadErrorReason;
  /** Diagnostic detail (the underlying exception message). */
  message: string;
}

/**
 * Outcome of a queue read. A discriminated union so callers MUST distinguish an
 * explicit empty-but-successful read (`{ ok: true, messages: [] }`) from a read
 * FAILURE (`{ ok: false, error }`). The empty array is reachable ONLY when the
 * storage key is genuinely absent.
 */
export type QueueReadResult =
  | { ok: true; messages: SyncMessage[] }
  | { ok: false; error: QueueReadError };

/**
 * Thrown by every queue operation that cannot safely proceed on an unreadable
 * queue (BACKLOG-3070).
 *
 * Throwing — rather than returning a benign empty/zero value — is the whole
 * point: a caller that forgets to check cannot silently destroy the backlog,
 * and the sync cycle already treats a throw as a FAILED cycle. Inside
 * `runSyncCycle`'s step-1 try (`getRemainingQueueCapacity`, `enqueueMessages`)
 * it becomes a `readError`, so the cycle is not counted as a healthy reach and
 * the SMS cursor is held; outside it, the run rejects and is reported by the
 * background task's Sentry capture or the manual-sync "Sync Failed" alert.
 * Either way the failure is loud and the stored bytes are untouched.
 */
export class QueueUnreadableError extends Error {
  readonly reason: QueueReadErrorReason;

  constructor(error: QueueReadError, refusedOperation: string) {
    super(
      `Sync queue is unreadable (${error.reason}); ${refusedOperation} refused ` +
        `so the stored queue is not overwritten: ${error.message}`
    );
    this.name = "QueueUnreadableError";
    this.reason = error.reason;
  }
}

/**
 * Read the queue, reporting a failure as a failure (BACKLOG-3070).
 *
 * The ONE path that yields an empty queue is a genuinely absent storage key.
 * Every other outcome — AsyncStorage rejecting, unparseable bytes, bytes that
 * parse to something that is not an array — is a failure the caller must handle
 * WITHOUT writing over what it could not read.
 */
export async function readQueue(): Promise<QueueReadResult> {
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
  } catch (error) {
    return {
      ok: false,
      error: {
        reason: "storage_failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown AsyncStorage read failure",
      },
    };
  }

  // Genuinely absent: never written, or cleared by `clearQueue` (removeItem).
  // Nothing failed, so there is nothing to preserve. Deliberately `== null`
  // rather than falsy: an empty string under this key is CORRUPTION, not an
  // empty queue — `JSON.stringify([])` is `"[]"`, never `""` — and the old
  // `if (!stored)` test called it empty.
  if (stored == null) return { ok: true, messages: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    return {
      ok: false,
      error: {
        reason: "parse_failed",
        message:
          error instanceof Error ? error.message : "Unparseable stored queue",
      },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        reason: "parse_failed",
        message: `Stored queue is ${
          parsed === null ? "null" : typeof parsed
        }, not an array`,
      },
    };
  }

  return { ok: true, messages: parsed as SyncMessage[] };
}

// ============================================
// MESSAGE IDENTITY (BACKLOG-2199)
// ============================================

/**
 * Stable de-duplication key for a queued message.
 *
 * Prefers the Android content-provider row id (`smsId`) when present. Falls
 * back to the `sender|timestamp|body` composite — which is exactly the tuple
 * the desktop hashes (SHA-256) to dedup on its side
 * (electron/services/localSyncService.ts `generateExternalId`), so phone-side
 * and desktop-side identity agree and a re-send of an already-stored message
 * is a guaranteed no-op on the desktop.
 */
export function messageIdentity(m: SyncMessage): string {
  if (m.smsId !== undefined && m.smsId !== null && String(m.smsId).length > 0) {
    return `id:${m.smsId}`;
  }
  return `c:${m.sender}|${m.timestamp}|${m.body}`;
}

// ============================================
// QUEUE OPERATIONS
// ============================================

/**
 * Add messages to the sync queue (idempotently).
 *
 * BACKLOG-2199: this NEVER drops messages. Two behavioural guarantees:
 *  1. Idempotent — a message whose identity is already queued is skipped, so a
 *     boundary re-read (the `lastSynced + 1ms` cursor can re-surface a message
 *     that is still sitting un-acked in the queue) cannot double-enqueue.
 *  2. No trimming — the old MAX_QUEUE_SIZE "drop oldest" behaviour is gone.
 *     Overflow is prevented upstream by back-pressure in performSync (bounded
 *     reads), never by discarding un-synced history.
 *
 * @param messages - Array of SyncMessage objects to queue
 * @returns Number of messages actually appended (excludes de-duped ones)
 */
export async function enqueueMessages(
  messages: SyncMessage[]
): Promise<number> {
  if (messages.length === 0) return 0;

  // BACKLOG-3070: the append is a read-modify-WRITE over one storage key, so it
  // must never run on a read it could not trust. Branching on the union here —
  // rather than relying on `getQueue()` throwing — keeps this guard independent
  // of the read's honesty: if the read ever swallows a failure again, THIS is
  // what stops `[...[], ...toAppend]` being written over the backlog.
  const read = await readQueue();
  if (!read.ok) {
    throw new QueueUnreadableError(read.error, "the enqueue append");
  }

  const current = read.messages;
  const seen = new Set(current.map(messageIdentity));

  const toAppend: SyncMessage[] = [];
  for (const m of messages) {
    const id = messageIdentity(m);
    if (seen.has(id)) continue; // already queued — skip (idempotent)
    seen.add(id); // guard against duplicates within this same batch too
    toAppend.push(m);
  }

  if (toAppend.length === 0) return 0;

  const updated = [...current, ...toAppend];
  await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(updated));

  return toAppend.length;
}

/**
 * Dequeue up to MAX_BATCH_SIZE messages from the front of the queue.
 * Messages are removed from the queue — if send fails, they must be re-enqueued.
 *
 * @returns Array of up to MAX_BATCH_SIZE messages
 */
export async function dequeueBatch(): Promise<SyncMessage[]> {
  // BACKLOG-3070: an unreadable queue must not be reported as a drained one.
  // This path does not overwrite (it returns early on empty), but reporting an
  // empty batch makes the cycle look healthy while the backlog sits unread.
  const read = await readQueue();
  if (!read.ok) {
    throw new QueueUnreadableError(read.error, "the dequeue");
  }

  const current = read.messages;
  if (current.length === 0) return [];

  const batch = current.slice(0, MAX_BATCH_SIZE);
  const remaining = current.slice(MAX_BATCH_SIZE);

  await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(remaining));

  return batch;
}

/**
 * Return a failed batch to the FRONT of the queue so it is retried first.
 *
 * BACKLOG-2199/2200: never trims. De-dupes against the current queue so that
 * if a lock race (or a crash mid-cycle) leaves the same batch both dequeued
 * and already re-queued, we don't create duplicate queue entries. The batch is
 * prepended in its original order to preserve oldest-first FIFO semantics.
 *
 * @param messages - Messages to return to the queue
 */
export async function requeueMessages(
  messages: SyncMessage[]
): Promise<void> {
  if (messages.length === 0) return;

  // BACKLOG-3070: the SAME defect as the enqueue path, and not named in the
  // item — on a swallowed read failure this wrote `[...prependable]` over the
  // stored value, so returning ONE failed batch to the queue destroyed every
  // other un-synced message. Guarded identically and for the same reason.
  const read = await readQueue();
  if (!read.ok) {
    throw new QueueUnreadableError(read.error, "the requeue prepend");
  }

  const current = read.messages;
  const currentIds = new Set(current.map(messageIdentity));

  // Keep only batch messages not already back in the queue (dedupe), preserving order.
  const seen = new Set<string>();
  const prependable: SyncMessage[] = [];
  for (const m of messages) {
    const id = messageIdentity(m);
    if (currentIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    prependable.push(m);
  }

  if (prependable.length === 0) return;

  const updated = [...prependable, ...current];
  await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(updated));
}

/**
 * Get the current queue contents without modifying them.
 *
 * @returns Array of queued SyncMessage objects
 */
export async function getQueue(): Promise<SyncMessage[]> {
  const read = await readQueue();
  if (!read.ok) {
    // BACKLOG-3070: was `return []`. An unreadable queue reported as an empty
    // one is what let the append path overwrite the un-synced backlog, and what
    // let `getQueueSize`/`getRemainingQueueCapacity` (below) report full
    // capacity so the cycle read more SMS and advanced the cursor over it.
    throw new QueueUnreadableError(read.error, "reading the queue");
  }
  return read.messages;
}

/**
 * Get the number of messages currently in the queue.
 */
export async function getQueueSize(): Promise<number> {
  const queue = await getQueue();
  return queue.length;
}

/**
 * Remaining capacity before the queue hits MAX_QUEUE_SIZE.
 *
 * BACKLOG-2199: performSync uses this as the read budget so it never enqueues
 * more than the queue can hold. Clamped at 0 (never negative).
 */
export async function getRemainingQueueCapacity(): Promise<number> {
  const size = await getQueueSize();
  return Math.max(0, MAX_QUEUE_SIZE - size);
}

/**
 * Whether the queue is at (or over) capacity — i.e. no room to read new SMS.
 */
export async function isQueueAtCapacity(): Promise<boolean> {
  return (await getRemainingQueueCapacity()) <= 0;
}

/**
 * Clear all messages from the queue.
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
}

// ============================================
// LAST SYNC TIMESTAMP
// ============================================

/**
 * Get the timestamp of the newest SMS that was successfully synced.
 * Used to determine which messages are "new" on the next read.
 *
 * @returns Unix timestamp in ms, or 0 if never synced
 */
export async function getLastSyncTimestamp(): Promise<number> {
  try {
    const stored = await AsyncStorage.getItem(LAST_SYNC_TIMESTAMP_KEY);
    if (!stored) return 0;
    const ts = parseInt(stored, 10);
    return isNaN(ts) ? 0 : ts;
  } catch {
    return 0;
  }
}

/**
 * Update the last sync timestamp.
 * Should be set to the newest message timestamp in the successfully synced batch.
 *
 * @param timestamp - Unix timestamp in ms
 */
export async function setLastSyncTimestamp(timestamp: number): Promise<void> {
  await AsyncStorage.setItem(LAST_SYNC_TIMESTAMP_KEY, String(timestamp));
}

/**
 * Forget the SMS high-water mark, so the next read starts from the beginning
 * of the phone's history (BACKLOG-2995).
 *
 * ## Why this has to exist
 *
 * The high-water mark is PHONE-owned and the desktop never asks for
 * "everything after T". So a desktop whose database is wiped — a reinstall, or
 * the schema baseline reset in BACKLOG-2993 — receives only messages NEWER
 * than whatever this phone had already sent, permanently, while sync reports
 * success. Re-pairing already forces a full CONTACT resync
 * (`contactSyncState.forceFullContactResync`); this is the message equivalent
 * that was missing.
 *
 * ## Why re-sending everything is safe
 *
 * `messageIdentity()` above keys on the content-provider row id and falls back
 * to the `sender|timestamp|body` tuple the desktop hashes as
 * `generateExternalId` (`electron/services/localSyncService.ts`). Anything the
 * desktop still holds is therefore a no-op on arrival, and `enqueueMessages`
 * is itself idempotent. The cost of an unnecessary reset is one slow sync, not
 * duplicated history.
 *
 * ## Deliberately narrower than `resetAllSyncData`
 *
 * That function is the UNPAIR teardown: it also drops the queue, the stats and
 * the contact fingerprints. This one removes the cursor and nothing else,
 * because a re-pair must not discard messages that are queued and un-acked —
 * BACKLOG-2199 exists precisely to stop history being dropped on the floor.
 *
 * ## Why the APPLIED WINDOW goes with the cursor (BACKLOG-3017)
 *
 * That record claims "this phone has already read from edge E", and the claim
 * is only true OF A PAIRING — the desktop on the other end can change, and this
 * function exists precisely for the case where it has been wiped. Left behind,
 * it breaks the recovery it was meant to serve: an All-time era records
 * `null`, the user narrows to 3 months, the desktop database is wiped, the
 * phone re-pairs, and the user widens back to All time to get their history
 * back — `null` against a recorded `null` is not a widening, so nothing older
 * is ever read and there is no recourse short of another re-pair. Clearing it
 * makes the next cycle a first observation, which (with the cursor at 0) does
 * not lower anything and simply records the new baseline.
 */
export async function resetMessageCursor(): Promise<void> {
  await AsyncStorage.removeItem(LAST_SYNC_TIMESTAMP_KEY);
  await clearAppliedWindow();
}

// ============================================
// SYNC LOCK (BACKLOG-2200)
// ============================================

/**
 * Persisted in-flight sync lock.
 *
 * performSync can be entered from four contexts that may overlap: the OS
 * background-fetch task (a separate JS runtime), the manual "Sync Now" button,
 * the auto-sync-on-pair flow, and the onboarding first-sync screen. Without a
 * cross-context lock, two runs interleave over the non-atomic AsyncStorage
 * read-modify-write of the queue/cursor and either double-send a batch or
 * clobber each other's write.
 *
 * This lock is BEST-EFFORT: because the check-then-set below is itself two
 * awaits, two callers that start within the same tick could both observe
 * "unlocked". That residual race is intentionally backstopped by the desktop,
 * which dedups on a content hash — a duplicate send stores zero duplicate
 * rows. The lock's job is to make overlap rare and to keep the local queue
 * mutation ordered; the desktop hash is the true correctness guarantee.
 */
interface SyncLock {
  /** Random token identifying the holder — only the holder may release. */
  nonce: string;
  /** Unix ms when the lock was acquired (for TTL-based stale recovery). */
  acquiredAt: number;
}

/** Generate a reasonably-unique lock nonce without extra dependencies. */
function makeNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readSyncLock(): Promise<SyncLock | null> {
  try {
    const stored = await AsyncStorage.getItem(SYNC_LOCK_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<SyncLock>;
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return null;
    }
    return { nonce: parsed.nonce, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

/**
 * Try to acquire the sync lock.
 *
 * Returns a nonce string on success, or null if another (non-stale) run holds
 * it. A held lock older than SYNC_LOCK_TTL_MS is treated as stale (its owner
 * crashed / was killed) and force-broken so sync can never deadlock.
 *
 * @param now - injectable clock for tests (defaults to Date.now())
 */
export async function acquireSyncLock(
  now: number = Date.now()
): Promise<string | null> {
  const existing = await readSyncLock();

  if (existing && now - existing.acquiredAt < SYNC_LOCK_TTL_MS) {
    // A fresh lock is held by someone else — do not acquire.
    return null;
  }

  // No lock, or the existing one is stale → take it.
  const nonce = makeNonce();
  const lock: SyncLock = { nonce, acquiredAt: now };
  await AsyncStorage.setItem(SYNC_LOCK_KEY, JSON.stringify(lock));

  // Best-effort confirmation: re-read and verify our nonce won. If a racing
  // caller overwrote us between the write and this read, we lost — back off.
  const confirmed = await readSyncLock();
  if (!confirmed || confirmed.nonce !== nonce) {
    return null;
  }

  return nonce;
}

/**
 * Is a sync running RIGHT NOW, by any caller?
 *
 * BACKLOG-3005 (the Sync Now busy-state fold). The home screen's spinner was
 * driven by a local `useState` that only ever knew about syncs that screen
 * started itself. A sync started by the post-pair auto-sync, `appStateCatchup`
 * on foregrounding, or the OS background task takes THIS lock and never touches
 * that state, so the button rendered idle, the user tapped, `performSync`
 * returned `skipped`, and the tap was reported as "Up to Date".
 *
 * Before BACKLOG-3005 that was a ~30 ms race. Now that one tap can drain for
 * minutes, a lock being held is the NORMAL state for the whole drain, which is
 * what makes the missing affordance worth a UI change.
 *
 * ## The staleness predicate is deliberately the SAME EXPRESSION as acquire's
 *
 * `now - acquiredAt < SYNC_LOCK_TTL_MS`, copied from `acquireSyncLock` above.
 * A lock older than the TTL is one `acquireSyncLock` would force-break, so
 * reporting it as busy would grey the button out FOREVER after a crash mid-sync
 * — a permanently unusable button, worse than the defect being fixed. The two
 * must agree, so they are written the same way; `isSyncInFlight` answering
 * "busy" where `acquireSyncLock` would answer "take it" is the bug to avoid.
 *
 * READ-ONLY: never acquires, never breaks, never writes. It is a UI affordance,
 * not a correctness mechanism — the lock itself is still what serialises runs.
 *
 * @param now - injectable clock for tests (defaults to Date.now())
 */
export async function isSyncInFlight(
  now: number = Date.now()
): Promise<boolean> {
  const existing = await readSyncLock();
  if (!existing) return false;
  return now - existing.acquiredAt < SYNC_LOCK_TTL_MS;
}

/**
 * Refresh the timestamp on a lock we still hold, WITHOUT changing its nonce.
 *
 * ## The landmine this defuses (BACKLOG-3005)
 *
 * `acquireSyncLock` stamps `acquiredAt` once and nothing ever updated it, so
 * the TTL below was really "the maximum a run may take", not "the maximum a
 * CRASHED run may block for". That was invisible while every run was a single
 * cycle. A multi-cycle drain holding the lock past `SYNC_LOCK_TTL_MS` would
 * have it force-broken mid-run by the OS background task or the AppState
 * catch-up, reintroducing precisely the concurrent read-modify-write race on
 * the queue and cursor that BACKLOG-2200 exists to prevent.
 *
 * Renewing between cycles bounds the stale-recovery window to ONE cycle rather
 * than one whole run, so a genuinely crashed run is still recovered on time.
 *
 * ## What this does NOT fix, deliberately
 *
 * Intra-cycle overrun is untouched and pre-existing: a single cycle can already
 * exceed 90s today (the send loop is unbounded batches, each with its own
 * timeout), and nothing renews inside it. Out of scope here.
 *
 * @returns false when the lock is gone or now carries a DIFFERENT nonce — i.e.
 *   it was stolen. A caller that gets false MUST abort; it must never
 *   re-acquire, because the thief is mid-run on the same shared state.
 * @param now - injectable clock for tests (defaults to Date.now())
 */
export async function renewSyncLock(
  nonce: string,
  now: number = Date.now()
): Promise<boolean> {
  const existing = await readSyncLock();
  if (!existing || existing.nonce !== nonce) return false;
  // Same nonce, so `releaseSyncLock`'s ownership check still matches.
  await AsyncStorage.setItem(
    SYNC_LOCK_KEY,
    JSON.stringify({ nonce, acquiredAt: now } satisfies SyncLock)
  );
  return true;
}

/**
 * Release the sync lock, but only if we still hold it (nonce match).
 * A no-op if the lock was already stale-broken and re-acquired by another run,
 * so we never stomp a newer holder's lock.
 */
export async function releaseSyncLock(nonce: string): Promise<void> {
  const existing = await readSyncLock();
  if (existing && existing.nonce !== nonce) {
    // Our lock was stolen (stale-broken) by another run — don't touch theirs.
    return;
  }
  await AsyncStorage.removeItem(SYNC_LOCK_KEY);
}

// ============================================
// SYNC STATISTICS
// ============================================

/**
 * Get cumulative sync statistics.
 */
export async function getSyncStats(): Promise<SyncStats> {
  try {
    const stored = await AsyncStorage.getItem(SYNC_STATS_KEY);
    if (!stored) return { ...DEFAULT_STATS };
    // Spread over defaults so stats persisted before BACKLOG-2204 (which lack
    // `lastSuccessfulSyncAt`) still return a fully-populated object.
    return { ...DEFAULT_STATS, ...(JSON.parse(stored) as Partial<SyncStats>) };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

/**
 * Record a sync attempt and update statistics.
 *
 * @param success - Whether the sync sent messages (drives lastSyncTime/totals)
 * @param messageCount - Number of messages in this batch (only counted on success)
 * @param reachedDesktop - Whether this cycle successfully reached the desktop
 *   with no send error (BACKLOG-2204). Drives `lastSuccessfulSyncAt`, the
 *   staleness signal — it advances even for a healthy "nothing new" cycle, so a
 *   working-but-idle companion never looks stale. Defaults to false so the
 *   desktop-unreachable call site (which passes only 2 args) never marks a
 *   successful sync.
 */
export async function recordSyncAttempt(
  success: boolean,
  messageCount: number,
  reachedDesktop = false
): Promise<void> {
  const stats = await getSyncStats();

  stats.syncAttempts += 1;

  if (success) {
    stats.successfulSyncs += 1;
    stats.totalSynced += messageCount;
    stats.lastSyncTime = new Date().toISOString();
  }

  if (reachedDesktop) {
    stats.lastSuccessfulSyncAt = new Date().toISOString();
    // BACKLOG-2203: reaching the desktop clears the connection-health streak.
    stats.consecutiveFailures = 0;
    stats.firstFailureTime = null;
  } else {
    // BACKLOG-2203: a cycle that could not reach the desktop extends the streak.
    // Same `reachedDesktop` signal that gates `lastSuccessfulSyncAt` above, so
    // health and staleness stay in lock-step. Stamped only on the first failure
    // so we can measure how long we have been offline.
    stats.consecutiveFailures += 1;
    if (!stats.firstFailureTime) {
      stats.firstFailureTime = new Date().toISOString();
    }
  }

  await AsyncStorage.setItem(SYNC_STATS_KEY, JSON.stringify(stats));
}

// ============================================
// SYNC SETTINGS (BACKLOG-1464)
// ============================================

/** Valid sync interval values in minutes, or 'manual' to disable background sync */
export type SyncIntervalValue = 15 | 30 | 60 | "manual";

/** Default sync interval (15 minutes — Android's minimum for BackgroundFetch) */
export const DEFAULT_SYNC_INTERVAL: SyncIntervalValue = 15;

/**
 * Get the configured sync interval.
 * @returns The stored interval value, or DEFAULT_SYNC_INTERVAL if not set
 */
export async function getSyncInterval(): Promise<SyncIntervalValue> {
  try {
    const stored = await AsyncStorage.getItem(SYNC_INTERVAL_KEY);
    if (!stored) return DEFAULT_SYNC_INTERVAL;
    if (stored === "manual") return "manual";
    const num = parseInt(stored, 10);
    if (num === 15 || num === 30 || num === 60) return num;
    return DEFAULT_SYNC_INTERVAL;
  } catch {
    return DEFAULT_SYNC_INTERVAL;
  }
}

/**
 * Set the sync interval preference.
 * @param interval - Interval in minutes (15/30/60) or 'manual'
 */
export async function setSyncInterval(
  interval: SyncIntervalValue
): Promise<void> {
  await AsyncStorage.setItem(SYNC_INTERVAL_KEY, String(interval));
}

/**
 * Get whether background sync is enabled.
 * Defaults to true (enabled).
 */
export async function getBackgroundSyncEnabled(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(BACKGROUND_SYNC_ENABLED_KEY);
    if (stored === null) return true; // Default: enabled
    return stored === "true";
  } catch {
    return true;
  }
}

/**
 * Set whether background sync is enabled.
 * @param enabled - true to enable, false to disable
 */
export async function setBackgroundSyncEnabled(
  enabled: boolean
): Promise<void> {
  await AsyncStorage.setItem(BACKGROUND_SYNC_ENABLED_KEY, String(enabled));
}

// ============================================
// RESET
// ============================================

/**
 * Reset all sync data (queue, timestamp, stats, settings).
 * Called when the device is unpaired.
 *
 * BACKLOG-2208: also clears the contact fingerprint/diff state so a re-pair
 * sends the FULL address book once (rather than diffing against a stale map
 * from the previous pairing).
 *
 * BACKLOG-2800: also drops the cached import window. `UnpairReason` includes
 * `account-switch`, so a cache surviving this teardown could apply the PREVIOUS
 * user's window to the next user's phone on any cycle where their own fetch
 * failed. The cached record is additionally STAMPED with its owner's user id
 * (see `syncWindow.ts`), which is what actually makes the account switch safe —
 * this removal keeps the store tidy rather than carrying the guarantee alone.
 */
export async function resetAllSyncData(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(QUEUE_STORAGE_KEY),
    AsyncStorage.removeItem(LAST_SYNC_TIMESTAMP_KEY),
    AsyncStorage.removeItem(SYNC_STATS_KEY),
    AsyncStorage.removeItem(SYNC_INTERVAL_KEY),
    AsyncStorage.removeItem(BACKGROUND_SYNC_ENABLED_KEY),
    AsyncStorage.removeItem(SYNC_LOCK_KEY),
    resetContactSyncState(),
    clearSyncWindowCache(),
  ]);
}
