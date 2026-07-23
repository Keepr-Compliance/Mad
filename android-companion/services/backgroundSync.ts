/**
 * Background Sync Service (Android Companion)
 * Manages periodic background sync of SMS messages to the Keepr desktop app.
 *
 * TASK-1430: SMS BroadcastReceiver + background sync service
 *
 * Uses expo-task-manager + expo-background-fetch to run periodic sync tasks:
 * 1. Read new SMS since last sync timestamp
 * 2. Queue messages locally
 * 3. Attempt to send to desktop via encrypted HTTP transport
 * 4. Update sync statistics
 *
 * Background fetch runs approximately every 15 minutes when the app is
 * backgrounded, subject to Android's battery optimization constraints.
 */

import * as Sentry from "@sentry/react-native";
import * as TaskManager from "expo-task-manager";
import * as BackgroundFetch from "expo-background-fetch";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { readSmsMessages } from "./smsReader";
import { readContacts } from "./contactReader";
import { sendMessages, sendContacts, pingDesktop } from "./syncService";
import {
  enqueueMessages,
  dequeueBatch,
  requeueMessages,
  getLastSyncTimestamp,
  setLastSyncTimestamp,
  recordSyncAttempt,
  getQueueSize,
  getRemainingQueueCapacity,
  getSyncInterval,
  getBackgroundSyncEnabled,
  acquireSyncLock,
  releaseSyncLock,
} from "./smsQueueService";
import type { SyncIntervalValue } from "./smsQueueService";
import type { PairingInfo, SyncErrorType } from "../types/sync";

// ============================================
// CONSTANTS
// ============================================

/** Task identifier for the background sync task */
export const BACKGROUND_SYNC_TASK = "keepr-sms-background-sync";

/** Minimum interval between background fetches (seconds) */
const BACKGROUND_FETCH_INTERVAL = 15 * 60; // 15 minutes

/** Storage key for pairing info (matches pairing screen) */
const PAIRING_STORAGE_KEY = "@keepr/pairing";

// ============================================
// TASK DEFINITION
// ============================================

/**
 * Define the background sync task.
 * This must be called at module load time (outside of any component).
 *
 * TaskManager.defineTask must be called in the global scope, not inside
 * a React component or hook.
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const result = await performSync();

    if (result.newMessages > 0 || result.sentMessages > 0) {
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }

    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.error("[BackgroundSync] Task failed:", error);
    Sentry.captureException(error, {
      tags: { component: "backgroundSync" },
    });
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ============================================
// SYNC LOGIC
// ============================================

/** Result of a single sync operation */
export interface SyncOperationResult {
  /** Number of new messages read from SMS provider */
  newMessages: number;
  /** Number of messages successfully sent to desktop */
  sentMessages: number;
  /** Number of contacts synced to desktop (BACKLOG-1449) */
  contactsSynced: number;
  /** Whether the desktop was reachable */
  desktopReachable: boolean;
  /** Current queue size after this operation */
  queueSize: number;
  /** Error message if sync failed */
  error?: string;
  /** Categorized error type for UI guidance (BACKLOG-1496) */
  errorType?: SyncErrorType;
  /**
   * True when this call returned early because another sync was already in
   * flight (BACKLOG-2200). Callers should treat this as "not finished" — NOT
   * as a completed sync — so onboarding/manual UIs don't render a false
   * "Sync Complete" (the class of bug fixed in BACKLOG-2201). The in-flight
   * run that holds the lock is doing the real work.
   */
  skipped?: boolean;
}

/**
 * Perform a full sync cycle:
 * 1. Load pairing info
 * 2. Read new SMS since last sync
 * 3. Enqueue new messages
 * 4. Attempt to send queued messages to desktop
 * 5. Update sync stats
 *
 * This is called both by the background task and by the manual "Sync Now" button.
 */
export async function performSync(): Promise<SyncOperationResult> {
  // BACKLOG-2200: serialize the whole cycle across UI + background contexts.
  // If another run holds a fresh lock, return early with `skipped: true` and a
  // benign, non-error result so no caller renders a false "Sync Complete" or a
  // false failure. The holder is doing the real work.
  const lockNonce = await acquireSyncLock();
  if (!lockNonce) {
    Sentry.addBreadcrumb({
      category: "sync",
      message: "Sync skipped — another sync in progress",
      level: "info",
    });
    return {
      newMessages: 0,
      sentMessages: 0,
      contactsSynced: 0,
      // desktopReachable:true + no error keeps this out of the error branches
      // in home.tsx / first-sync.tsx; `skipped` is the signal callers key on.
      desktopReachable: true,
      queueSize: await getQueueSize(),
      skipped: true,
    };
  }

  try {
    return await runSyncCycle();
  } finally {
    // Always release our lock, even on throw, so a failed cycle can't deadlock.
    await releaseSyncLock(lockNonce);
  }
}

/**
 * The actual sync cycle. Only ever invoked by performSync while holding the
 * sync lock (BACKLOG-2200), so its queue/cursor mutations are atomic across
 * contexts.
 */
async function runSyncCycle(): Promise<SyncOperationResult> {
  Sentry.addBreadcrumb({
    category: "sync",
    message: "Sync cycle started",
    level: "info",
  });

  // Load pairing info
  const pairingInfo = await loadPairingInfo();
  if (!pairingInfo) {
    return {
      newMessages: 0,
      sentMessages: 0,
      contactsSynced: 0,
      desktopReachable: false,
      queueSize: await getQueueSize(),
      error: "Not paired with a desktop",
    };
  }

  // Step 1: Read new SMS (bounded by remaining queue capacity — back-pressure)
  //
  // BACKLOG-2199: the cursor now advances ONLY over messages we actually
  // captured in the durable queue, and NEVER over messages we chose not to
  // read because the queue was full. This makes it impossible for the cursor
  // to move past un-synced history:
  //   - reads are oldest-first (smsReader forces `date ASC`), so what we read
  //     is a contiguous prefix of the backlog;
  //   - we read at most the remaining queue capacity, so enqueue never has to
  //     drop anything;
  //   - we advance the cursor past what we read only when the read was NOT
  //     capacity-truncated (see the boundary reasoning below), so a message
  //     that didn't fit stays at/below the cursor and is re-read next cycle.
  //     If the queue is already full we read nothing and the cursor does not
  //     move at all.
  let newMessages = 0;
  try {
    const remainingCapacity = await getRemainingQueueCapacity();

    if (remainingCapacity <= 0) {
      console.warn(
        "[BackgroundSync] Queue at capacity — applying back-pressure, not reading new SMS"
      );
    } else {
      const lastTimestamp = await getLastSyncTimestamp();
      // Bound the per-box read so the combined inbox+sent read fits the
      // remaining capacity. Split the budget across the two boxes (min 1 each).
      const perBoxBudget = Math.max(1, Math.floor(remainingCapacity / 2));
      const messages = await readSmsMessages(lastTimestamp, perBoxBudget);
      newMessages = messages.length;

      if (messages.length > 0) {
        const enqueuedCount = await enqueueMessages(messages);

        const newestTimestamp = Math.max(...messages.map((m) => m.timestamp));

        // BOUNDARY-SAFE CURSOR ADVANCE (BACKLOG-2199, SR review Note D).
        //
        // The native query uses `minDate >=`, so the next read starts at the
        // stored cursor. Two hazards to avoid:
        //   (a) advancing to `newest` (not +1) always re-reads the newest
        //       message every cycle — wasteful but not lossy (idempotent
        //       enqueue dedupes it). This is BACKLOG-1484's "1 new message
        //       every cycle" symptom.
        //   (b) advancing to `newest + 1` skips any message that shares the
        //       `newest` millisecond but was truncated off this read by the
        //       capacity/maxCount cap — PERMANENT LOSS.
        //
        // Resolution: only jump to `newest + 1` when we are certain we read
        // the WHOLE tail (the read was NOT capacity-truncated). If either box
        // may have hit its budget, we might have split a same-millisecond
        // group across the boundary, so we advance only to `newest`
        // (inclusive) and let the next cycle re-read that millisecond — the
        // idempotent enqueue makes the overlap free. As the queue drains, a
        // later un-truncated read finally clears the +1 hop.
        const readWasTruncated = messages.length >= perBoxBudget; // a box may have capped
        const nextCursor = readWasTruncated
          ? newestTimestamp // inclusive: re-read the boundary ms next cycle
          : newestTimestamp + 1; // safe to skip past — full tail was read
        await setLastSyncTimestamp(nextCursor);

        if (enqueuedCount < messages.length) {
          console.log(
            `[BackgroundSync] Enqueued ${enqueuedCount}/${messages.length} (rest were already queued — deduped)`
          );
        }
      }
    }
  } catch (error) {
    console.error("[BackgroundSync] Failed to read SMS:", error);
    // Continue — we may still have queued messages to send
  }

  // Step 2: Check if desktop is reachable
  const desktopReachable = await pingDesktop(pairingInfo);
  if (!desktopReachable) {
    const queueSize = await getQueueSize();
    await recordSyncAttempt(false, 0);
    return {
      newMessages,
      sentMessages: 0,
      contactsSynced: 0,
      desktopReachable: false,
      queueSize,
      error: "Desktop app is not running. Open Keepr on your computer and try again.",
      errorType: "connection_refused",
    };
  }

  // Step 3: Send queued messages in batches
  let totalSent = 0;
  let sendError: string | undefined;
  let sendErrorType: SyncErrorType | undefined;

  // Keep sending batches until queue is empty or we hit an error
  let hasMore = true;
  while (hasMore) {
    const batch = await dequeueBatch();
    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    try {
      const result = await sendMessages(batch, pairingInfo);

      if (result.success) {
        totalSent += batch.length;
      } else {
        // Send failed — re-enqueue the batch for retry
        await requeueMessages(batch);
        sendError = result.error;
        sendErrorType = result.errorType;
        hasMore = false;
      }
    } catch (error) {
      // Network error — re-enqueue the batch
      await requeueMessages(batch);
      sendError =
        error instanceof Error ? error.message : "Unknown send error";
      sendErrorType = "unknown";
      hasMore = false;
    }
  }

  // Step 4: Sync contacts (BACKLOG-1449)
  let contactsSynced = 0;
  try {
    const contacts = await readContacts();
    if (contacts.length > 0) {
      const contactResult = await sendContacts(contacts, pairingInfo);
      if (contactResult.success) {
        contactsSynced = contacts.length;
        console.log(`[BackgroundSync] Synced ${contacts.length} contacts`);
      } else {
        console.warn(
          `[BackgroundSync] Contact sync failed: ${contactResult.error}`
        );
      }
    }
  } catch (error) {
    console.error("[BackgroundSync] Failed to sync contacts:", error);
    // Non-fatal — message sync result is still valid
  }

  // Step 5: Record stats
  await recordSyncAttempt(totalSent > 0, totalSent);

  const queueSize = await getQueueSize();

  Sentry.addBreadcrumb({
    category: "sync",
    message: "Sync cycle completed",
    level: "info",
    data: {
      newMessages,
      sentMessages: totalSent,
      contactsSynced,
      queueSize,
      hadError: !!sendError,
    },
  });

  return {
    newMessages,
    sentMessages: totalSent,
    contactsSynced,
    desktopReachable: true,
    queueSize,
    error: sendError,
    errorType: sendErrorType,
  };
}

// ============================================
// TASK REGISTRATION
// ============================================

/**
 * Register the background sync task with expo-background-fetch.
 * Reads the configured sync interval from AsyncStorage.
 * Should be called after pairing is established.
 */
export async function startBackgroundSync(): Promise<void> {
  const [enabled, interval] = await Promise.all([
    getBackgroundSyncEnabled(),
    getSyncInterval(),
  ]);

  if (!enabled || interval === "manual") {
    console.log("[BackgroundSync] Background sync disabled or set to manual");
    await stopBackgroundSync();
    return;
  }

  const isRegistered = await TaskManager.isTaskRegisteredAsync(
    BACKGROUND_SYNC_TASK
  );
  if (isRegistered) {
    console.log("[BackgroundSync] Task already registered");
    return;
  }

  const intervalSeconds = interval * 60;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: intervalSeconds,
    stopOnTerminate: false,
    startOnBoot: true,
  });

  console.log(
    `[BackgroundSync] Task registered with interval: ${interval} min`
  );
}

/**
 * Unregister the background sync task.
 * Should be called when the device is unpaired or sync is disabled.
 */
export async function stopBackgroundSync(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(
    BACKGROUND_SYNC_TASK
  );
  if (!isRegistered) {
    console.log("[BackgroundSync] Task not registered, nothing to stop");
    return;
  }

  await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  console.log("[BackgroundSync] Task unregistered");
}

/**
 * Update the background sync interval at runtime.
 * Unregisters the current task and re-registers with the new interval.
 * If set to 'manual', the task is unregistered entirely.
 *
 * BACKLOG-1464: Called from Settings screen when user changes sync interval.
 *
 * @param interval - New interval in minutes (15/30/60) or 'manual'
 */
export async function updateSyncInterval(
  interval: SyncIntervalValue
): Promise<void> {
  // Always unregister first
  await stopBackgroundSync();

  if (interval === "manual") {
    console.log("[BackgroundSync] Manual mode — background task disabled");
    return;
  }

  const intervalSeconds = interval * 60;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: intervalSeconds,
    stopOnTerminate: false,
    startOnBoot: true,
  });

  console.log(
    `[BackgroundSync] Re-registered with interval: ${interval} min`
  );
}

/**
 * Check if the background sync task is currently registered.
 */
export async function isBackgroundSyncActive(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
}

/**
 * Get the current background fetch status.
 * Returns information about whether background fetch is available on this device.
 */
export async function getBackgroundFetchStatus(): Promise<BackgroundFetch.BackgroundFetchStatus> {
  return BackgroundFetch.getStatusAsync();
}

// ============================================
// HELPERS
// ============================================

/**
 * Load pairing info from AsyncStorage.
 * Returns null if not paired.
 */
async function loadPairingInfo(): Promise<PairingInfo | null> {
  try {
    const stored = await AsyncStorage.getItem(PAIRING_STORAGE_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as {
      ip: string;
      port: number;
      secret: string;
      deviceName: string;
    };

    // Convert stored pairing to PairingInfo format
    // The desktop generates a deviceId during QR pairing, but the stored
    // format from the pairing screen uses deviceName. We use the device name
    // as a fallback deviceId.
    return {
      ip: parsed.ip,
      port: parsed.port,
      secret: parsed.secret,
      deviceId: parsed.deviceName,
    };
  } catch {
    return null;
  }
}
