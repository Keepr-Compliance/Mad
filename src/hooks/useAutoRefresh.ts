/**
 * useAutoRefresh Hook
 *
 * TASK-1003: Auto-refresh data sources on app load.
 * TASK-1783: Migrated to use SyncOrchestratorService.
 *
 * Automatically syncs all available data sources when the user opens
 * the application, eliminating the need to manually click "Auto Detect".
 *
 * Behavior:
 * - Triggers after auth + database ready + on dashboard
 * - Adds 1.5 second delay to not slow startup
 * - Runs syncs sequentially via SyncOrchestrator (contacts -> emails -> messages)
 * - Uses incremental sync (only new data)
 * - Handles errors silently (log only)
 * - Doesn't block UI
 *
 * Platform Matrix:
 * - Gmail: All platforms (API - fetch new emails since last sync)
 * - Outlook: All platforms (API - fetch new emails since last sync)
 * - Text Messages: macOS only (Local iMessage database)
 * - Contacts: macOS only (Local Contacts database)
 * - iPhone Backup: NOT triggered (requires manual device connection)
 *
 * @module hooks/useAutoRefresh
 */

import { useEffect, useCallback, useState, useRef } from "react";
import * as Sentry from "@sentry/electron/renderer";
import logger from "../utils/logger";
import { usePlatform } from "../contexts/PlatformContext";
import { hasMessagesImportTriggered, setMessagesImportTriggered } from "../utils/syncFlags";
import { useSyncOrchestrator } from "./useSyncOrchestrator";
import type { SyncType, SyncItem } from "../services/SyncOrchestratorService";
import type { ImportSource } from "../services/settingsService";

// Module-level flag to track if auto-refresh has been triggered this session
// Using module-level prevents React strict mode from triggering twice
let hasTriggeredAutoRefresh = false;

/**
 * Reset the auto-refresh trigger (for testing or logout)
 */
export function resetAutoRefreshTrigger(): void {
  hasTriggeredAutoRefresh = false;
}

/**
 * Individual sync operation status
 */
export interface SyncOperation {
  /** Whether sync is in progress */
  isSyncing: boolean;
  /** Progress percentage (0-100), null if indeterminate */
  progress: number | null;
  /** Status message to display */
  message: string;
  /** Error message if sync failed */
  error: string | null;
}

/**
 * Combined sync status for all operations
 */
export interface SyncStatus {
  emails: SyncOperation;
  messages: SyncOperation;
  contacts: SyncOperation;
}

/**
 * Auto-sync preferences from user settings
 */
interface AutoSyncPreferences {
  sync?: {
    autoSyncOnLogin?: boolean;
  };
  notifications?: {
    enabled?: boolean;
  };
  messages?: {
    source?: ImportSource;
  };
}

interface UseAutoRefreshOptions {
  /** User ID to sync for */
  userId: string | null;
  /** Whether user has email connected */
  hasEmailConnected: boolean;
  /** Whether database is initialized */
  isDatabaseInitialized: boolean;
  /** Whether user has permissions (FDA on macOS) */
  hasPermissions: boolean;
  /** Whether we're on the dashboard (triggers sync) */
  isOnDashboard: boolean;
  /** Whether this is during onboarding (skip sync if true) */
  isOnboarding?: boolean;
  /** Whether user has AI addon (gates email sync with AI transaction detection) */
  hasAIAddon?: boolean;
}

interface UseAutoRefreshReturn {
  /** Sync status for all operations */
  syncStatus: SyncStatus;
  /** Whether any sync is in progress */
  isAnySyncing: boolean;
  /** Current sync message to display */
  currentSyncMessage: string | null;
  /** Manually trigger a full refresh */
  triggerRefresh: () => Promise<void>;
}

const initialSyncOperation: SyncOperation = {
  isSyncing: false,
  progress: null,
  message: "",
  error: null,
};

// Auto-refresh delay in milliseconds
// Delay before auto-triggering sync on dashboard load
const AUTO_REFRESH_DELAY_MS = 1500;

/**
 * Map a SyncItem from orchestrator queue to SyncOperation for public API
 */
function mapQueueItemToSyncOperation(item?: SyncItem): SyncOperation {
  if (!item) return { ...initialSyncOperation };
  return {
    isSyncing: item.status === 'running' || item.status === 'pending',
    progress: item.progress,
    message: '',
    error: item.error ?? null,
  };
}

/**
 * Hook for automatically refreshing data sources on app load.
 *
 * Triggers background sync when:
 * - User reaches the dashboard
 * - Auto-sync preference is enabled (default: true)
 * - User is authenticated and database is initialized
 * - Not in onboarding flow
 *
 * Sync runs sequentially via SyncOrchestrator:
 * - Contacts (macOS only, if permissions granted)
 * - Emails (if email connected and AI addon enabled) - includes AI transaction detection
 * - Messages (macOS only, if permissions granted)
 */
export function useAutoRefresh({
  userId,
  hasEmailConnected,
  isDatabaseInitialized,
  hasPermissions,
  isOnDashboard,
  isOnboarding = false,
  hasAIAddon = false,
}: UseAutoRefreshOptions): UseAutoRefreshReturn {
  const { isMacOS } = usePlatform();

  // Get orchestrator state and actions
  const { queue, isRunning, requestSync } = useSyncOrchestrator();

  // Note: using module-level hasTriggeredAutoRefresh instead of ref to prevent
  // React strict mode from triggering twice (each instance would have its own ref)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);
  // BACKLOG-1467: Track import source to skip macOS messages for Android users
  const [importSource, setImportSource] = useState<ImportSource>('macos-native');

  // Load auto-sync and notification preferences
  useEffect(() => {
    if (!userId || !isDatabaseInitialized) return;

    const loadPreference = async () => {
      try {
        const result = await window.api.preferences.get(userId);
        if (result.success && result.preferences) {
          const prefs = result.preferences as AutoSyncPreferences;
          // Default to true if not set
          const enabled = prefs.sync?.autoSyncOnLogin !== false;
          setAutoSyncEnabled(enabled);
          // Load notification preference (default to true if not set)
          const notifEnabled = prefs.notifications?.enabled !== false;
          setNotificationsEnabled(notifEnabled);
          // BACKLOG-1467: Load import source to gate macOS messages sync
          if (prefs.messages?.source) {
            setImportSource(prefs.messages.source);
          }
        }
      } catch (prefsError) {
        // Default to enabled on error
        setAutoSyncEnabled(true);
        setNotificationsEnabled(true);
        Sentry.captureException(prefsError, {
          tags: { sync_type: "auto_refresh" },
          level: "warning",
          extra: {
            operation: "load-preferences",
            error_message: prefsError instanceof Error ? prefsError.message : String(prefsError),
          },
        });
      } finally {
        setHasLoadedPreference(true);
      }
    };

    loadPreference();
  }, [userId, isDatabaseInitialized]);

  /**
   * Run sync via orchestrator.
   *
   * This runs when:
   * 1. User completes onboarding without PermissionsStep (FDA already granted)
   * 2. User returns to app after session restart
   *
   * If PermissionsStep ran, hasMessagesImportTriggered() returns true and we skip.
   */
  const runAutoRefresh = useCallback(
    async (
      uid: string,
      emailConnected: boolean,
      isAborted?: () => boolean,
    ): Promise<void> => {
      // Build list of sync types based on platform and permissions
      // Order: Contacts (fast) → Emails (if AI addon) → Messages (slow)
      const typesToSync: SyncType[] = [];

      // TASK-2092: Always sync contacts — the orchestrator and IPC handlers
      // have their own internal guards (platform checks, FDA, source preferences).
      // Gating here was redundant and caused contacts to be skipped entirely
      // when both FDA and email conditions were false.
      typesToSync.push('contacts');

      // BACKLOG-2127: `emailConnected` (hasEmailConnected) is a load-time
      // snapshot that reads FALSE when a stored token has gone dead — which
      // previously caused 'emails' to be silently dropped, so the sync ran
      // green with "0 new messages" and no reconnect prompt. Do a LIVE
      // checkAllConnections here and enqueue 'emails' whenever a provider is
      // connected OR has a broken-token error (TOKEN_REFRESH_FAILED /
      // TOKEN_EXPIRED / CONNECTION_CHECK_FAILED). Only a pure NOT_CONNECTED
      // (no token row) legitimately skips email sync.
      let shouldSyncEmails = emailConnected;
      try {
        const brokenTokenTypes = new Set([
          'TOKEN_REFRESH_FAILED',
          'TOKEN_EXPIRED',
          'CONNECTION_CHECK_FAILED',
        ]);
        const result = await window.api.system.checkAllConnections(uid);
        if (result.success) {
          const providers = [result.google, result.microsoft];
          shouldSyncEmails = providers.some(
            (p) =>
              !!p &&
              (p.connected ||
                (!!p.error && brokenTokenTypes.has(p.error.type))),
          );
        }
      } catch (connError) {
        // Live check failed (transient) — fall back to the snapshot rather than
        // dropping email sync. Log via renderer logger (never console.log).
        logger.warn(
          '[useAutoRefresh] Live connection check failed; using snapshot',
          connError,
        );
      }

      // R2: after the async connection check, bail if the owning effect was
      // cleaned up (unmount / dep change) so we don't fire a late requestSync.
      if (isAborted?.()) {
        return;
      }

      if (shouldSyncEmails) {
        typesToSync.push('emails');
      }
      // BACKLOG-1467: Skip macOS messages when import source is android-companion or iphone-sync
      if (isMacOS && hasPermissions && importSource === 'macos-native') {
        typesToSync.push('messages');
      }

      // Request sync from orchestrator (runs sequentially)
      if (typesToSync.length > 0) {
        requestSync(typesToSync, uid);
      }
    },
    [isMacOS, hasPermissions, hasAIAddon, importSource, requestSync]
  );

  /**
   * Trigger a manual refresh (manual "Sync Now" — same async live-check path)
   */
  const triggerRefresh = useCallback(async () => {
    if (!userId) return;
    await runAutoRefresh(userId, hasEmailConnected);
  }, [userId, hasEmailConnected, runAutoRefresh]);

  // BACKLOG-1559: Reset auto-refresh trigger on login (userId change)
  // so email precache runs after re-login, not just on app restart.
  useEffect(() => {
    if (userId) {
      hasTriggeredAutoRefresh = false;
    }
  }, [userId]);

  // BACKLOG-1559: Email precache is now triggered from the main process
  // (electron/main.ts) immediately after login, not from the renderer.

  // Auto-trigger refresh once per app session when first entering dashboard
  useEffect(() => {
    // Skip if not on dashboard (but don't reset flag - we only want to trigger once per session)
    if (!isOnDashboard) return;
    if (!userId) return;
    if (!isDatabaseInitialized) return;
    if (isOnboarding) return;
    if (!hasLoadedPreference) return;
    if (!autoSyncEnabled) {
      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Auto-refresh skipped: auto-sync disabled by user preference',
        level: 'info',
        data: { operation: 'auto-refresh' },
      });
      return;
    }
    // Use module-level flag to prevent React strict mode from triggering twice
    // BACKLOG-1367: Only treat as "triggered" if permissions are resolved.
    // On macOS, if hasPermissions is still false (async check pending), allow
    // the effect to re-fire when hasPermissions flips to true so messages
    // are included in the sync. On non-macOS, permissions don't matter.
    //
    // Email precache fix: Mirror the hasPermissions re-fire pattern for
    // hasEmailConnected. On login/restart, hasEmailConnected may resolve to
    // false initially (async state), then flip to true after the flag is set.
    // Allow re-fire so emails are included once the connection state resolves.
    const permissionsResolved = !isMacOS || hasPermissions;
    const emailResolved = hasEmailConnected;
    if (hasTriggeredAutoRefresh && permissionsResolved && emailResolved) return;

    // Mark as triggered only when both permissions and email state are resolved.
    // This prevents the stale-state race: first trigger with
    // hasPermissions=false or hasEmailConnected=false won't lock out a retry
    // when either flips to true.
    if (permissionsResolved && emailResolved) {
      hasTriggeredAutoRefresh = true;
    }

    // R2 (BACKLOG-2127): the abort flag is owned by THIS effect closure. The
    // cleanup sets it; runAutoRefresh checks it after its async connection
    // check resolves and before requestSync, so an unmount / dep change during
    // the async window suppresses a late sync. StrictMode-safe: this is not a
    // run-once didMount guard — the module-level value-comparison gate above
    // still governs re-fires.
    let aborted = false;

    // Run refresh after delay to let UI settle
    const timeoutId = setTimeout(() => {
      // Skip if already imported this session (e.g., during onboarding via PermissionsStep)
      // BACKLOG-1367: Only skip if messages would actually be included in this sync.
      // When hasPermissions is false, messages won't be synced anyway, so don't
      // let a prior flag block the entire auto-refresh.
      // Email precache fix: Don't skip the entire auto-refresh when messages were
      // already imported but emails still need to sync. Only skip when there's
      // nothing new to sync beyond what was already triggered.
      const willSyncMessages = isMacOS && hasPermissions;
      if (willSyncMessages && hasMessagesImportTriggered() && !hasEmailConnected) {
        Sentry.addBreadcrumb({
          category: 'sync',
          message: 'Auto-refresh skipped: messages import already triggered this session',
          level: 'info',
          data: { operation: 'auto-refresh' },
        });
        return;
      }
      // Only mark messages as triggered if we're actually going to sync them
      if (willSyncMessages) {
        setMessagesImportTriggered();
      }

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Auto-refresh triggered',
        level: 'info',
        data: {
          operation: 'auto-refresh',
          hasEmailConnected,
          isMacOS,
          hasPermissions,
        },
      });

      void runAutoRefresh(userId, hasEmailConnected, () => aborted);
    }, AUTO_REFRESH_DELAY_MS);

    return () => {
      aborted = true;
      clearTimeout(timeoutId);
    };
  }, [
    isOnDashboard,
    userId,
    isDatabaseInitialized,
    isOnboarding,
    hasLoadedPreference,
    autoSyncEnabled,
    hasEmailConnected,
    isMacOS,
    hasPermissions,
    runAutoRefresh,
  ]);

  // Track previous syncing state for notification trigger
  const wasSyncingRef = useRef(false);

  // Send OS notification when sync completes (gated on user preference)
  useEffect(() => {
    // Detect transition from syncing to not syncing
    const hasCompleted = queue.some(item => item.status === 'complete');
    const hasErrors = queue.some(item => item.status === 'error');
    // Only notify if items actually completed/errored — not if they were removed (cancel)
    if (wasSyncingRef.current && !isRunning && (hasCompleted || hasErrors) && notificationsEnabled) {
      const title = hasErrors ? "Sync Failed" : "Sync Complete";
      const body = hasErrors
        ? "One or more sync operations failed. Open Keepr for details."
        : "Keepr is ready to use. Your data has been synchronized.";
      window.api.notification?.send(title, body).catch((notifError: unknown) => {
        // Track notification failures but don't disrupt UX
        Sentry.captureException(notifError, {
          tags: { sync_type: "auto_refresh" },
          level: "warning",
          extra: {
            operation: "sync-complete-notification",
            error_message: notifError instanceof Error ? notifError.message : String(notifError),
          },
        });
      });
    }
    wasSyncingRef.current = isRunning;
  }, [isRunning, notificationsEnabled, queue]);

  // Derive syncStatus from orchestrator queue for backward compatibility
  const syncStatus: SyncStatus = {
    emails: mapQueueItemToSyncOperation(queue.find(q => q.type === 'emails')),
    messages: mapQueueItemToSyncOperation(queue.find(q => q.type === 'messages')),
    contacts: mapQueueItemToSyncOperation(queue.find(q => q.type === 'contacts')),
  };

  return {
    syncStatus,
    isAnySyncing: isRunning,
    currentSyncMessage: null,
    triggerRefresh,
  };
}

export default useAutoRefresh;
