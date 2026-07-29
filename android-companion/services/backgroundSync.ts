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
import type { SmsReadError } from "./smsReader";
import { checkSmsPermissions } from "./permissions";
import { readContacts } from "./contactReader";
import { sendMessages, sendContacts, pingDesktop } from "./syncService";
import { isPhoneOnLocalNetwork } from "./connectivity";
import {
  computeContactDiff,
  commitContactSync,
  isContactDiffSupported,
} from "./contactSyncState";
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

    // BACKLOG-2208: contactsSynced is now the diff size (only new/changed on an
    // incremental cycle), so it is a meaningful "new data" signal — unlike the
    // pre-diff behavior where it was the whole address book every cycle.
    if (
      result.newMessages > 0 ||
      result.sentMessages > 0 ||
      result.contactsSynced > 0
    ) {
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
  /**
   * Number of contacts transmitted to the desktop this cycle (BACKLOG-1449).
   * Post-BACKLOG-2208 this is the DIFF size on an incremental cycle (new/changed
   * only), or the full address-book size on a full/periodic re-sync.
   */
  contactsSynced: number;
  /**
   * Number of genuinely NEW or CHANGED contacts detected this cycle
   * (BACKLOG-2208), independent of whether this was a full or partial sync. This
   * is the "New Contacts" home stat — symmetric with `newMessages` — so a
   * periodic full re-send with nothing actually changed reports 0.
   */
  newContacts: number;
  /** Whether the desktop was reachable */
  desktopReachable: boolean;
  /** Current queue size after this operation */
  queueSize: number;
  /** Error message if sync failed */
  error?: string;
  /** Categorized error type for UI guidance (BACKLOG-1496) */
  errorType?: SyncErrorType;
  /**
   * Set when this cycle FAILED to read SMS — permission revoked mid-run, the
   * native module is missing, or a content-resolver / query / parse error —
   * as distinct from a genuine empty inbox (BACKLOG-2206).
   *
   * When present, the cycle is NOT counted as a successful reach:
   * `lastSuccessfulSyncAt` does NOT advance and the BACKLOG-2203 failure streak
   * increments (see `reachedDesktop` below). That makes a persistently-failing
   * read surface through the existing BACKLOG-2204 staleness banner instead of
   * masquerading as a healthy "all synced" idle cycle, and lets the UI render an
   * actionable read-error state.
   */
  readError?: SmsReadError;
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
 * BACKLOG-2296: distinguish (b) the phone being off Wi-Fi from (a) the desktop
 * being unreachable, given a transport-level failure.
 *
 * A failed sync used to blanket-report "Desktop app is not running", even when
 * the real cause was the PHONE having no Wi-Fi (both surface the same
 * connection-refused / timeout). We check the phone's OWN connectivity first:
 *   - phone NOT on the local Wi-Fi → `phone_offline` (case b), regardless of the
 *     desktop-side transport error, because we cannot have reached a LAN desktop.
 *   - phone IS on Wi-Fi → keep the desktop-side transport classification
 *     (`connection_refused` / `timeout` / `network_after_connect`, case a).
 *
 * CRITICAL 2284 GUARD: only a TRANSPORT error is ever passed here. A
 * `server_error` (e.g. a 403 account rejection) means the desktop WAS reached
 * and answered, so it is NEVER routed through this reclassifier and stays an
 * account/identity failure.
 */
async function classifyReachabilityFailure(
  transportErrorType: SyncErrorType,
): Promise<SyncErrorType> {
  const onLocalNetwork = await isPhoneOnLocalNetwork();
  return onLocalNetwork ? transportErrorType : "phone_offline";
}

/** User-facing message for a reachability failure, matched to its cause. */
function reachabilityErrorMessage(errorType: SyncErrorType): string {
  return errorType === "phone_offline"
    ? // Case (b): the phone itself is off Wi-Fi / not on the LAN.
      "You're not connected to Wi-Fi. Reconnect to the same network as your computer, then sync again."
    : // Case (a): on Wi-Fi but the desktop app is closed / unreachable.
      "Can't reach Keepr on your computer. Make sure Keepr is open, then re-connect.";
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
      newContacts: 0,
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
      newContacts: 0,
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
  let readError: SmsReadError | undefined;
  try {
    // BACKLOG-2209: PROACTIVELY re-check the READ_SMS runtime permission at the
    // START of every cycle, BEFORE issuing any read. If the user revoked SMS
    // access in Android Settings after pairing, a read would otherwise fail
    // mid-run (surfaced reactively by BACKLOG-2206) or, on some OEM builds,
    // silently return [] — looking like "no new messages". Catching it up-front
    // means we never even hit the native content-provider query on a revoked
    // permission. Crucially, we funnel this through the SAME `permission_denied`
    // SmsReadError path 2206 already built rather than a parallel signal: setting
    // `readError` here makes the cycle a FAILED reach (`reachedDesktop=false`
    // below → `lastSuccessfulSyncAt` held, BACKLOG-2203 streak +1, cursor held),
    // and `result.readError` drives the SAME read-error / revocation banner. It
    // reuses the existing permission API (services/permissions.ts) shared with
    // onboarding + settings. Non-Android returns `unavailable`, so this branch
    // only fires on a genuine Android revocation (`denied`/`never_ask_again`).
    const smsPermission = await checkSmsPermissions();
    const smsPermissionRevoked =
      smsPermission.readSms === "denied" ||
      smsPermission.readSms === "never_ask_again";

    // Only measure remaining capacity when we actually intend to read — a revoked
    // permission short-circuits below before any read / back-pressure decision.
    const remainingCapacity = smsPermissionRevoked
      ? 0
      : await getRemainingQueueCapacity();

    if (smsPermissionRevoked) {
      readError = {
        reason: "permission_denied",
        message:
          "READ_SMS permission is not granted (revoked in Android Settings)",
      };
      console.warn(
        "[BackgroundSync] SMS permission revoked — skipping read this cycle (BACKLOG-2209)"
      );
      Sentry.captureException(new Error("SMS read permission revoked"), {
        tags: {
          component: "smsReader",
          read_error: "permission_denied",
          source: "proactive_check",
        },
      });
    } else if (remainingCapacity <= 0) {
      console.warn(
        "[BackgroundSync] Queue at capacity — applying back-pressure, not reading new SMS"
      );
    } else {
      const lastTimestamp = await getLastSyncTimestamp();
      // Bound the per-box read so the combined inbox+sent read fits the
      // remaining capacity. Split the budget across the two boxes (min 1 each).
      const perBoxBudget = Math.max(1, Math.floor(remainingCapacity / 2));
      const readResult = await readSmsMessages(lastTimestamp, perBoxBudget);

      if (!readResult.ok) {
        // BACKLOG-2206: a GENUINE read failure (permission revoked, native
        // module missing, content-resolver / query / parse error) — NOT
        // zero-results. Do NOT enqueue and do NOT advance the cursor. Record it
        // so the cycle counts as a failed reach (see `reachedDesktop` below) and
        // capture it for diagnosis with a distinct tag.
        readError = readResult.error;
        console.error(
          `[BackgroundSync] SMS read failed (${readError.reason}): ${readError.message}`
        );
        Sentry.captureException(
          new Error(`SMS read failed: ${readError.message}`),
          {
            tags: {
              component: "smsReader",
              read_error: readError.reason,
            },
          }
        );
      } else {
        const messages = readResult.messages;
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
    }
  } catch (error) {
    // BACKLOG-2206 (defensive): readSmsMessages now reports failures via its
    // result, but an UNEXPECTED throw must ALSO be treated as a read failure —
    // never silently continue as if the read succeeded (which would let the
    // cycle count as a healthy reach and reset the staleness clock).
    console.error("[BackgroundSync] Failed to read SMS:", error);
    readError = {
      reason: "query_failed",
      message:
        error instanceof Error ? error.message : "Unknown SMS read error",
    };
    Sentry.captureException(error, {
      tags: { component: "smsReader", read_error: "query_failed" },
    });
  }

  // Step 2: Check if desktop is reachable
  const desktopReachable = await pingDesktop(pairingInfo);
  if (!desktopReachable) {
    const queueSize = await getQueueSize();
    await recordSyncAttempt(false, 0);
    // BACKLOG-2296: the ping failing could mean (a) the desktop is down while the
    // phone IS on Wi-Fi, OR (b) the PHONE has no Wi-Fi (it can't reach any LAN
    // desktop). Consult the phone's own connectivity FIRST so we show the right
    // guidance instead of always blaming the desktop. `connection_refused` is the
    // desktop-side default that survives when the phone is confirmed on Wi-Fi.
    const errorType = await classifyReachabilityFailure("connection_refused");
    return {
      newMessages,
      sentMessages: 0,
      contactsSynced: 0,
      newContacts: 0,
      desktopReachable: false,
      queueSize,
      error: reachabilityErrorMessage(errorType),
      errorType,
      // BACKLOG-2206: still surface a read failure that happened this cycle, even
      // though the reachability error is the more actionable one to show. This
      // early return already records a failed attempt (reachedDesktop=false), so
      // the read failure correctly extends the 2203 streak here too.
      readError,
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

  // BACKLOG-2296: a batch send that failed at the TRANSPORT level means the phone
  // may have dropped Wi-Fi mid-cycle (after the ping passed) — that is case (b),
  // not "desktop down" (case a). Re-check the phone's own connectivity and, if it
  // is no longer on the local Wi-Fi, reclassify to `phone_offline` with the
  // matching guidance. A `server_error` (403 account rejection, 2284) is NEVER
  // routed here — it means the desktop answered, so it stays an account failure.
  if (
    sendErrorType === "connection_refused" ||
    sendErrorType === "timeout" ||
    sendErrorType === "network_after_connect"
  ) {
    const reclassified = await classifyReachabilityFailure(sendErrorType);
    if (reclassified !== sendErrorType) {
      sendErrorType = reclassified;
      sendError = reachabilityErrorMessage(reclassified);
    }
  }

  // Step 4: Sync contacts (BACKLOG-1449 + BACKLOG-2208 diff).
  //
  // Instead of re-sending the whole address book every cycle, diff the current
  // contacts against the persisted fingerprint map and send only what is new or
  // changed. `isFullSync` tags the batch so the desktop stale-deletes ONLY on a
  // full snapshot (first run / after reset / periodic re-sync), never on a diff
  // — otherwise it would delete every unchanged contact. The fingerprint map is
  // committed ONLY after the desktop accepts the batch, so a failed send is
  // retried next cycle.
  //
  // CAPABILITY INTERLOCK (BACKLOG-2208): only diff when the paired desktop has
  // advertised `contactDiff` support at /register. Against an OLD desktop (which
  // ignores `isFullSync` and would stale-delete everything omitted from a diff)
  // `diffSupported` is false, so we force a FULL send every cycle — byte-identical
  // to the pre-2208 behavior, and the partial-diff window never opens.
  let contactsSynced = 0;
  let newContacts = 0;
  try {
    const contacts = await readContacts();
    const diffSupported = await isContactDiffSupported();
    const { toSend, isFullSync, newOrChanged } = await computeContactDiff(
      contacts,
      Date.now(),
      /* forceFull */ !diffSupported
    );
    newContacts = newOrChanged;

    if (toSend.length > 0) {
      const contactResult = await sendContacts(toSend, pairingInfo, isFullSync);
      if (contactResult.success) {
        contactsSynced = toSend.length;
        await commitContactSync(contacts, toSend, isFullSync);
        console.log(
          `[BackgroundSync] Synced ${toSend.length} contacts ` +
            `(${isFullSync ? "full" : "diff"}, ${newOrChanged} new/changed)`
        );
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
  //
  // We reached the desktop above (the ping passed), so this cycle counts as a
  // successful sync for STALENESS purposes as long as no send error occurred —
  // even if there was nothing new to send (BACKLOG-2204). That keeps
  // `lastSuccessfulSyncAt` fresh for a healthy-but-idle companion, so the stale
  // banner only fires when background sync is genuinely dead (Doze/OEM).
  //
  // BACKLOG-2206: a READ failure this cycle also disqualifies it as a success —
  // we can't trust "nothing new" when the read itself errored. So a read failure
  // must NOT advance `lastSuccessfulSyncAt` and MUST extend the 2203 failure
  // streak, exactly like an unreachable desktop. Otherwise a broken read
  // masquerades as a healthy idle cycle and even resets the staleness clock.
  const reachedDesktop = !sendError && !readError;
  await recordSyncAttempt(totalSent > 0, totalSent, reachedDesktop);

  const queueSize = await getQueueSize();

  Sentry.addBreadcrumb({
    category: "sync",
    message: "Sync cycle completed",
    level: "info",
    data: {
      newMessages,
      sentMessages: totalSent,
      contactsSynced,
      newContacts,
      queueSize,
      hadError: !!sendError,
      readFailed: !!readError,
    },
  });

  return {
    newMessages,
    sentMessages: totalSent,
    contactsSynced,
    newContacts,
    desktopReachable: true,
    queueSize,
    error: sendError,
    errorType: sendErrorType,
    readError,
  };
}

// ============================================
// TASK REGISTRATION
// ============================================

/**
 * Register the background sync task with expo-background-fetch.
 * Reads the configured sync interval from AsyncStorage.
 * Should be called after pairing is established.
 *
 * DOZE / OEM BATTERY-KILLING (BACKLOG-2204) — what is and isn't possible here:
 *
 * `expo-background-fetch` is the only periodic trigger available to us in the
 * MANAGED Expo workflow. It wraps Android's WorkManager/JobScheduler and is
 * therefore fundamentally subject to Doze mode and OEM battery managers
 * (Samsung, Xiaomi, Huawei, ...): while the phone is idle the OS batches,
 * throttles, or entirely skips our wake-ups, and aggressive OEM ROMs can stop
 * the app outright. There is no API in managed Expo to defeat this — a true
 * always-on foreground service would require a native config-plugin / custom
 * dev-client build (and is Play-policy sensitive), which is explicitly OUT OF
 * SCOPE (no ejecting).
 *
 * We register with the strongest managed-Expo options available:
 *   - `minimumInterval` = the user's chosen interval (>= the 15-min Android
 *     floor). Asking for less is silently clamped by the OS.
 *   - `stopOnTerminate: false` so sync survives the app being swept from
 *     recents (best-effort — OEMs may still kill it).
 *   - `startOnBoot: true` so it re-registers after a reboot (also best-effort;
 *     OEMs often block this until the app is opened once).
 *
 * Because none of the above is guaranteed, background sync is treated as a
 * BEST-EFFORT optimisation, and the RELIABLE mechanisms are layered on top:
 *   1. AppState catch-up (services/appStateCatchup.ts) — an immediate sync every
 *      time the user foregrounds the app, so a killed background task self-heals
 *      on next open.
 *   2. Staleness surface (services/syncStaleness.ts + home screen) — makes a
 *      silently-dead background task VISIBLE instead of invisible.
 *   3. Battery-optimization prompt (services/batteryOptimization.ts) — guides
 *      the user to exempt Keepr from OEM battery optimisation, the one lever a
 *      managed app actually has against Doze.
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
export async function getBackgroundFetchStatus(): Promise<BackgroundFetch.BackgroundFetchStatus | null> {
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
      // BACKLOG-2210: the desktop-minted device identity, adopted at /register
      // time and persisted here. Optional: absent on a pairing stored by a
      // pre-2210 build (or before the register response arrived), in which case
      // we fall back to the legacy name-derived id below.
      deviceId?: string;
    };

    // BACKLOG-2210: prefer the desktop-minted UUID (persisted after /register)
    // so every phone has a UNIQUE identity — two phones paired to the same
    // desktop no longer collide on `deviceName`. Fall back to the name-derived
    // id only for a legacy stored pairing that never adopted a minted id.
    return {
      ip: parsed.ip,
      port: parsed.port,
      secret: parsed.secret,
      deviceId: parsed.deviceId ?? parsed.deviceName,
    };
  } catch {
    return null;
  }
}
