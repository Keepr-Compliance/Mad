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
  /** ISO timestamp of last successful sync */
  lastSyncTime: string | null;
  /** Number of sync attempts */
  syncAttempts: number;
  /** Number of successful sync attempts */
  successfulSyncs: number;
}

const DEFAULT_STATS: SyncStats = {
  totalSynced: 0,
  lastSyncTime: null,
  syncAttempts: 0,
  successfulSyncs: 0,
};

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

  const current = await getQueue();
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
  const current = await getQueue();
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

  const current = await getQueue();
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
  try {
    const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as SyncMessage[];
  } catch {
    return [];
  }
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
    return JSON.parse(stored) as SyncStats;
  } catch {
    return { ...DEFAULT_STATS };
  }
}

/**
 * Record a sync attempt and update statistics.
 *
 * @param success - Whether the sync was successful
 * @param messageCount - Number of messages in this batch (only counted on success)
 */
export async function recordSyncAttempt(
  success: boolean,
  messageCount: number
): Promise<void> {
  const stats = await getSyncStats();

  stats.syncAttempts += 1;

  if (success) {
    stats.successfulSyncs += 1;
    stats.totalSynced += messageCount;
    stats.lastSyncTime = new Date().toISOString();
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
 */
export async function resetAllSyncData(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(QUEUE_STORAGE_KEY),
    AsyncStorage.removeItem(LAST_SYNC_TIMESTAMP_KEY),
    AsyncStorage.removeItem(SYNC_STATS_KEY),
    AsyncStorage.removeItem(SYNC_INTERVAL_KEY),
    AsyncStorage.removeItem(BACKGROUND_SYNC_ENABLED_KEY),
    AsyncStorage.removeItem(SYNC_LOCK_KEY),
  ]);
}
