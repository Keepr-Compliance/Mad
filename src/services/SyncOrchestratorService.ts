/**
 * SyncOrchestratorService
 *
 * Centralized sync orchestration for all data sources.
 * Handles sync ordering, conflict resolution, and state tracking.
 *
 * Features:
 * - Accepts ordered sync requests: ['contacts', 'emails', 'messages']
 * - Runs syncs sequentially in specified order
 * - One canonical sync function per source type
 * - Handles conflicts (sync in progress → queue or force)
 * - Tracks state for UI (queue order, current sync, progress)
 *
 * @module services/SyncOrchestratorService
 */

import * as Sentry from "@sentry/electron/renderer";
import { isMacOS } from '../utils/platform';
import type { ImportSource, UserPreferences } from './settingsService';
import logger from '../utils/logger';

export type SyncType = 'contacts' | 'emails' | 'messages' | 'iphone'
  | 'reindex' | 'backup' | 'restore' | 'ccpa-export';

export type SyncItemStatus = 'pending' | 'running' | 'complete' | 'error';

/** Email provider that a sync error can prompt the user to reconnect. */
export type ReconnectProvider = 'microsoft' | 'google';

/**
 * BACKLOG-2127: typed error thrown by the emails sync when a provider's stored
 * OAuth token is dead. Carries the provider so the SyncStatusIndicator can
 * render a provider-aware "Reconnect" CTA WITHOUT string-matching the message.
 */
export class EmailReconnectError extends Error {
  readonly provider: ReconnectProvider;
  constructor(provider: ReconnectProvider, message: string) {
    super(message);
    this.name = 'EmailReconnectError';
    this.provider = provider;
  }
}

export interface SyncItem {
  type: SyncType;
  status: SyncItemStatus;
  progress: number;  // 0-100
  error?: string;
  /** Optional phase label for display (e.g., "querying", "attachments") */
  phase?: string;
  /** Optional warning message (e.g., message cap exceeded) */
  warning?: string;
  /** True for externally-managed syncs (e.g., iPhone) that the orchestrator does not drive */
  external?: boolean;
  /**
   * BACKLOG-2127: set when the error is a dead OAuth token. Drives the
   * provider-aware "Reconnect" CTA on the completion card. Typed discriminator
   * — consumers must NOT parse `error` text to decide whether to show it.
   */
  reconnectProvider?: ReconnectProvider;
}

export interface SyncOrchestratorState {
  isRunning: boolean;
  queue: SyncItem[];           // Ordered queue with status
  currentSync: SyncType | null;
  overallProgress: number;     // 0-100
  pendingRequest: SyncRequest | null;  // Queued request waiting for user decision
}

export interface SyncRequest {
  types: SyncType[];
  userId: string;
  options?: {
    forceReimport?: boolean;
    overrideCap?: boolean;
  };
}

/** Sync functions can optionally return a warning string (e.g., "cap exceeded") */
type SyncFunction = (
  userId: string,
  onProgress: (percent: number, phase?: string) => void,
  options?: SyncRequest['options'],
  signal?: AbortSignal
) => Promise<string | void>;

type StateListener = (state: SyncOrchestratorState) => void;

class SyncOrchestratorServiceClass {
  private state: SyncOrchestratorState = {
    isRunning: false,
    queue: [],
    currentSync: null,
    overallProgress: 0,
    pendingRequest: null,
  };

  private listeners: Set<StateListener> = new Set();
  private abortController: AbortController | null = null;

  // Canonical sync functions - one per type
  private syncFunctions: Map<SyncType, SyncFunction> = new Map();

  // Track if sync functions have been initialized
  private initialized = false;

  /**
   * Register a sync function for a type.
   * Each type should have exactly one canonical sync function.
   */
  registerSyncFunction(type: SyncType, fn: SyncFunction): void {
    this.syncFunctions.set(type, fn);
  }

  /**
   * Read the import source preference fresh from DB.
   * Returns 'macos-native' (default) or 'iphone-sync'.
   * TASK-1979: Read at sync time to avoid stale cached values.
   */
  private async getImportSource(userId: string): Promise<ImportSource> {
    try {
      const result = await window.api.preferences.get(userId);
      const prefs = result.preferences as UserPreferences | undefined;
      if (result.success && prefs?.messages?.source) {
        return prefs.messages.source;
      }
    } catch (err) {
      logger.warn('[SyncOrchestrator] Failed to read import source preference, defaulting to macos-native:', err);
    }
    return 'macos-native';
  }

  /**
   * Read all contacts-related preferences in a single IPC call.
   * Returns import source and contact source preferences together.
   * TASK-2098: Consolidated to avoid duplicate preferences.get calls per sync.
   */
  private async getContactsSyncPreferences(userId: string): Promise<{
    importSource: ImportSource;
    contactSources: { macosContacts: boolean; outlookContacts: boolean; googleContacts: boolean };
  }> {
    const defaults = {
      importSource: 'macos-native' as ImportSource,
      contactSources: { macosContacts: true, outlookContacts: true, googleContacts: true },
    };

    try {
      const result = await window.api.preferences.get(userId);
      const prefs = result.preferences as UserPreferences | undefined;
      if (!result.success || !prefs) return defaults;

      // Extract import source (TASK-1979)
      const importSource: ImportSource = prefs.messages?.source ?? 'macos-native';

      // Extract contact source preferences (TASK-2098)
      const direct = prefs.contactSources?.direct;
      const contactSources = {
        macosContacts: typeof direct?.macosContacts === 'boolean' ? direct.macosContacts : true,
        outlookContacts: typeof direct?.outlookContacts === 'boolean' ? direct.outlookContacts : true,
        googleContacts: typeof direct?.googleContacts === 'boolean' ? direct.googleContacts : true,
      };

      return { importSource, contactSources };
    } catch (err) {
      logger.warn('[SyncOrchestrator] Failed to read contacts sync preferences, using defaults:', err);
      return defaults;
    }
  }

  /**
   * Initialize canonical sync functions.
   * Each sync function owns its IPC listeners internally.
   * Platform-specific functions are only registered on supported platforms.
   */
  initializeSyncFunctions(): void {
    if (this.initialized) {
      logger.info('[SyncOrchestrator] Already initialized, skipping');
      return;
    }

    const macOS = isMacOS();
    logger.info('[SyncOrchestrator] Initializing sync functions, isMacOS:', macOS);

    // Register contacts sync (macOS Contacts + Outlook contacts on all platforms)
    // TASK-1953: Always register contacts sync so Outlook contacts work on all platforms
    // TASK-2098: Read contact source preferences to conditionally skip phases
    this.registerSyncFunction('contacts', async (userId, onProgress, options, signal) => {
      logger.info('[SyncOrchestrator] Starting contacts sync, forceReimport:', !!options?.forceReimport);
      onProgress(0);

      // TASK-2150: Handle force re-import by wiping contacts first
      if (options?.forceReimport) {
        if (signal?.aborted) return;
        const wipeResult = await window.api.contacts.forceReimport(userId);
        if (!wipeResult.success) {
          throw new Error(wipeResult.error || 'Failed to clear contacts for re-import');
        }
        logger.info('[SyncOrchestrator] Contacts wiped for force re-import');
      }

      if (signal?.aborted) return;

      // TASK-2098: Read both import source and contact source preferences in one IPC call
      const { importSource, contactSources: sourcePrefs } = await this.getContactsSyncPreferences(userId);
      logger.info('[SyncOrchestrator] Import source preference:', importSource);
      logger.info('[SyncOrchestrator] Contact source preferences:', sourcePrefs);

      // Phase 1: macOS Contacts sync (macOS only, skip if iphone-sync selected or source disabled)
      if (macOS && importSource !== 'iphone-sync' && sourcePrefs.macosContacts) {
        const result = await window.api.contacts.syncExternal(userId);
        if (!result.success) {
          throw new Error(result.error || 'macOS Contacts sync failed');
        }
        logger.info('[SyncOrchestrator] macOS Contacts sync complete');
      } else if (macOS && !sourcePrefs.macosContacts) {
        logger.info('[SyncOrchestrator] Skipping macOS Contacts (disabled by user preference)');
      } else if (macOS && importSource === 'iphone-sync') {
        logger.info('[SyncOrchestrator] Skipping macOS Contacts (import source: iphone-sync)');
      }

      onProgress(50);

      if (signal?.aborted) return;

      // BACKLOG-2142: capture the first cloud provider whose stored OAuth token
      // is dead. Cloud contact failures stay NON-FATAL per-phase (so macOS
      // contacts from Phase 1 persist and BOTH cloud providers are attempted),
      // but a dead token is surfaced AFTER all phases run by throwing an
      // EmailReconnectError — landing the contacts item in status:'error' with
      // the typed reconnectProvider that drives the "Reconnect" CTA. Typed
      // discriminator (`tokenExpired`) only — never message string-matching.
      let contactsReconnect: ReconnectProvider | undefined;

      // Phase 2: Outlook contacts sync (all platforms, non-fatal, skip if source disabled)
      // TASK-1953: Outlook contacts sync via Graph API
      // TASK-2098: Skip if user disabled Outlook contacts in onboarding/settings
      if (!sourcePrefs.outlookContacts) {
        logger.info('[SyncOrchestrator] Skipping Outlook contacts (disabled by user preference)');
      } else {
        try {
          const outlookResult = await window.api.contacts.syncOutlookContacts(userId);
          if (outlookResult.success) {
            logger.info('[SyncOrchestrator] Outlook contacts synced:', outlookResult.count);
          } else if (outlookResult.tokenExpired) {
            logger.warn('[SyncOrchestrator] Outlook contacts token expired — reconnect required');
            contactsReconnect = contactsReconnect ?? 'microsoft';
          } else if (outlookResult.reconnectRequired) {
            logger.warn('[SyncOrchestrator] Outlook contacts need reconnection');
          } else {
            logger.warn('[SyncOrchestrator] Outlook contacts sync returned error:', outlookResult.error);
          }
        } catch (err) {
          // Don't fail the whole contacts sync if Outlook fails
          logger.warn('[SyncOrchestrator] Outlook contacts sync failed (non-fatal):', err);
          Sentry.addBreadcrumb({
            category: 'sync',
            message: 'Outlook contacts sync failed (non-fatal)',
            level: 'warning',
            data: {
              syncType: 'contacts',
              provider: 'outlook',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      if (signal?.aborted) return;

      // Phase 3: Google contacts sync (all platforms, non-fatal, skip if source disabled)
      // TASK-2303: Google contacts sync via People API
      if (!sourcePrefs.googleContacts) {
        logger.info('[SyncOrchestrator] Skipping Google contacts (disabled by user preference)');
      } else {
        try {
          const googleResult = await window.api.contacts.syncGoogleContacts(userId);
          if (googleResult.success) {
            logger.info('[SyncOrchestrator] Google contacts synced:', googleResult.count);
          } else if (googleResult.tokenExpired) {
            logger.warn('[SyncOrchestrator] Google contacts token expired — reconnect required');
            contactsReconnect = contactsReconnect ?? 'google';
          } else if (googleResult.reconnectRequired) {
            logger.warn('[SyncOrchestrator] Google contacts need reconnection (contacts.readonly scope missing)');
          } else {
            logger.warn('[SyncOrchestrator] Google contacts sync returned error:', googleResult.error);
          }
        } catch (err) {
          // Don't fail the whole contacts sync if Google fails
          logger.warn('[SyncOrchestrator] Google contacts sync failed (non-fatal):', err);
          Sentry.addBreadcrumb({
            category: 'sync',
            message: 'Google contacts sync failed (non-fatal)',
            level: 'warning',
            data: {
              syncType: 'contacts',
              provider: 'google',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      onProgress(100);

      // BACKLOG-2142: all phases have run (macOS contacts persisted, BOTH cloud
      // providers attempted). If a cloud token was dead, surface it now as a
      // PARTIAL success — the contacts item enters status:'error' which renders
      // the "Sync Completed with Errors" variant + reconnect CTA. macOS contacts
      // are NOT lost; the copy must read as partial, not total, failure.
      if (contactsReconnect) {
        const providerLabel = contactsReconnect === 'microsoft' ? 'Outlook' : 'Gmail';
        throw new EmailReconnectError(
          contactsReconnect,
          `${providerLabel} connection expired — reconnect to sync contacts`,
        );
      }

      logger.info('[SyncOrchestrator] All contacts sync complete');
    });

    // Register emails sync (all platforms - API-based)
    this.registerSyncFunction('emails', async (userId, onProgress, _options, signal) => {
      logger.info('[SyncOrchestrator] Starting emails sync');
      onProgress(0);

      // AI scan (non-fatal — precache should run regardless)
      if (signal?.aborted) return;
      try {
        const result = await window.api.transactions.scan(userId);
        if (!result.success) {
          logger.warn('[SyncOrchestrator] AI email scan failed (non-fatal):', result.error);
        }
      } catch (scanError) {
        logger.warn('[SyncOrchestrator] AI email scan threw (non-fatal):', scanError);
      }
      onProgress(50);

      // BACKLOG-1362: Pre-cache emails from connected providers.
      // Independent of AI scan — runs for all users with email connected.
      if (signal?.aborted) return;
      // BACKLOG-2127: A dead OAuth token is NOT non-fatal. If precache reports
      // an auth-class providerError, throw so the emails queue item enters
      // status:'error' (startSync catch) — which renders the "Sync Completed
      // with Errors" variant and drives the reconnect prompt, instead of a
      // green "0 new messages". Transient/network precache failures stay
      // non-fatal (no providerError → caught + warned below).
      try {
        logger.info('[SyncOrchestrator] Starting email pre-cache');
        // TODO: Pass progress callback to precacheEmails to report 50-100% progress during precache
        const { providerError } = await window.api.transactions.precacheEmails(userId);
        if (providerError?.tokenExpired) {
          const providerLabel = providerError.provider === 'microsoft' ? 'Outlook' : 'Gmail';
          throw new EmailReconnectError(
            providerError.provider,
            `${providerLabel} connection expired — reconnect to sync email`,
          );
        }
        logger.info('[SyncOrchestrator] Email pre-cache complete');
      } catch (precacheError) {
        // Re-throw auth-class failures (typed EmailReconnectError) so the emails
        // item errors AND carries the provider for the reconnect CTA; keep
        // transient failures non-fatal.
        if (precacheError instanceof EmailReconnectError) {
          throw precacheError;
        }
        logger.warn('[SyncOrchestrator] Email pre-cache failed (non-fatal):', precacheError);
      }

      onProgress(100);
      logger.info('[SyncOrchestrator] Emails sync complete');
    });

    // Register messages sync (macOS only - local iMessage database)
    if (macOS) {
      this.registerSyncFunction('messages', async (userId, onProgress, options, signal) => {
        logger.info('[SyncOrchestrator] Starting messages sync, forceReimport:', !!options?.forceReimport);

        // TASK-1979: Skip macOS Messages import when iphone-sync is selected
        // BACKLOG-1467: Also skip when android-companion is selected
        const importSource = await this.getImportSource(userId);
        if (importSource !== 'macos-native') {
          logger.info(`[SyncOrchestrator] Skipping macOS Messages (import source: ${importSource})`);
          onProgress(100);
          return;
        }

        // Phase order and weighted progress calculation
        // Dynamically detect if 'deleting' phase is present (forceReimport mode)
        let hasDeletePhase = false;

        // IPC listener OWNED here - not in consumers
        const cleanup = window.api.messages.onImportProgress((data) => {
          // Detect if we're in forceReimport mode (has deleting phase)
          if (data.phase === 'deleting') {
            hasDeletePhase = true;
          }

          // Use 4 phases if deleting is present, otherwise 3
          const phases = hasDeletePhase
            ? ['querying', 'deleting', 'importing', 'attachments']
            : ['querying', 'importing', 'attachments'];
          const n = phases.length;

          // Calculate weighted progress: step_index * (100/n) + ipc_progress / n
          const stepIndex = phases.indexOf(data.phase);
          const weightedProgress = stepIndex >= 0
            ? Math.round(stepIndex * (100 / n) + data.percent / n)
            : data.percent;
          onProgress(weightedProgress, data.phase);
        });

        try {
          if (signal?.aborted) {
            cleanup();
            return;
          }
          // TASK-2150: Pass forceReimport option through to IPC call
          // Type assertion: window.d.ts has the correct 2-arg signature but electron/types/ipc.ts
          // only declares 1 arg. The preload bridge accepts both. See BACKLOG-199.
          const importFn = window.api.messages.importMacOSMessages as (
            userId: string,
            forceReimport?: boolean
          ) => Promise<{ success: boolean; messagesImported: number; error?: string; wasCapped?: boolean; totalAvailable?: number }>;
          const result = await importFn(userId, options?.forceReimport);
          if (!result.success) {
            throw new Error(result.error || 'Message import failed');
          }
          onProgress(100);
          logger.info('[SyncOrchestrator] Messages sync complete, imported:', result.messagesImported);

          // Return warning if message cap was exceeded
          if (result.wasCapped && result.totalAvailable) {
            const excluded = result.totalAvailable - result.messagesImported;
            return `${excluded.toLocaleString()} messages excluded by import limit. Adjust in Settings.`;
          }
        } finally {
          cleanup();
        }
      });
    }

    // =========================================================================
    // TASK-2150: Maintenance / utility operations
    // These operations bypass the orchestrator today. Registering them here
    // makes them visible in the dashboard sync indicator.
    // =========================================================================

    // Register reindex (all platforms)
    this.registerSyncFunction('reindex', async (_userId, onProgress, _options, signal) => {
      onProgress(0, 'optimizing');
      if (signal?.aborted) return;
      const result = await window.api.system.reindexDatabase();
      if (!result.success) {
        throw new Error(result.error || 'Database reindex failed');
      }
      onProgress(100);
    });

    // Register backup (all platforms)
    // Note: The IPC call opens an OS save dialog. While the dialog is open,
    // the sync indicator shows "Backup - backing up". Acceptable for v1.
    this.registerSyncFunction('backup', async (_userId, onProgress, _options, signal) => {
      onProgress(0, 'backing up');
      if (signal?.aborted) return;
      const result = await window.api.databaseBackup.backup();
      if (result.cancelled) return 'cancelled'; // User cancelled dialog -- not an error
      if (!result.success) {
        throw new Error(result.error || 'Backup failed');
      }
      onProgress(100);
    });

    // Register restore (all platforms)
    // Note: Same dialog pattern as backup.
    this.registerSyncFunction('restore', async (_userId, onProgress, _options, signal) => {
      onProgress(0, 'restoring');
      if (signal?.aborted) return;
      const result = await window.api.databaseBackup.restore();
      if (result.cancelled) return 'cancelled'; // User cancelled dialog -- not an error
      if (!result.success) {
        throw new Error(result.error || 'Restore failed');
      }
      onProgress(100);
    });

    // Register CCPA data export (all platforms)
    this.registerSyncFunction('ccpa-export', async (userId, onProgress, _options, signal) => {
      onProgress(0, 'exporting');
      if (signal?.aborted) return;
      const cleanup = window.api.privacy?.onExportProgress?.(
        (progress: { category: string; progress: number }) => {
          onProgress(progress.progress, progress.category);
        }
      );
      try {
        const result = await window.api.privacy.exportData(userId);
        if (result.error === 'Export cancelled by user') return 'cancelled';
        if (!result.success) {
          throw new Error(result.error || 'CCPA export failed');
        }
        onProgress(100);
      } finally {
        if (cleanup) cleanup();
      }
    });

    this.initialized = true;
    logger.info('[SyncOrchestrator] Sync functions initialized');
  }

  /**
   * Get current state
   */
  getState(): SyncOrchestratorState {
    return { ...this.state };
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  private setState(partial: Partial<SyncOrchestratorState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyListeners();
  }

  /**
   * Request a sync. If sync is in progress, queues as pending request.
   * Returns true if sync started, false if queued (needs user decision).
   */
  requestSync(request: SyncRequest): { started: boolean; needsConfirmation: boolean } {
    // Only block if an internal sync is running. External syncs (e.g., iPhone)
    // use different resources and can run in parallel with internal syncs.
    const internalRunning = this.state.queue.some(
      (item) => !item.external && item.status === 'running'
    );

    Sentry.addBreadcrumb({
      category: 'sync',
      message: `Sync requested: ${request.types.join(', ')}`,
      level: 'info',
      data: {
        syncTypes: request.types,
        userId: request.userId.substring(0, 8) + '...',
        alreadyRunning: this.state.isRunning,
        internalRunning,
      },
    });

    if (internalRunning) {
      // Internal sync in progress - queue this request for user decision
      this.setState({ pendingRequest: request });
      return { started: false, needsConfirmation: true };
    }

    // No sync in progress - start immediately
    this.startSync(request);
    return { started: true, needsConfirmation: false };
  }

  /**
   * Force sync - abandons current sync and starts new one
   */
  forceSync(request: SyncRequest): void {
    this.cancel();
    this.setState({ pendingRequest: null });
    this.startSync(request);
  }

  /**
   * Accept the pending request (user confirmed)
   */
  acceptPendingRequest(): void {
    const pending = this.state.pendingRequest;
    if (!pending) return;

    this.forceSync(pending);
  }

  /**
   * Reject the pending request (user cancelled)
   */
  rejectPendingRequest(): void {
    this.setState({ pendingRequest: null });
  }

  // =========================================================================
  // External sync registration API (TASK-2119)
  //
  // External syncs (e.g., iPhone) are managed by their own hooks/contexts.
  // The orchestrator only tracks them in the queue for unified UI display
  // and to include them in the isRunning state.
  // =========================================================================

  /**
   * Register an external sync in the queue.
   * Idempotent: if an item for this type already exists with status 'running',
   * the call is a no-op (safe for hot-reload reconnect).
   */
  registerExternalSync(type: SyncType): void {
    const existing = this.state.queue.find((item) => item.type === type);
    if (existing && existing.status === 'running') {
      logger.debug(`[SyncOrchestrator] External sync '${type}' already registered, skipping`);
      return;
    }

    // Remove any stale item for this type (e.g., previous complete/error)
    const queue = this.state.queue.filter((item) => item.type !== type);
    queue.push({
      type,
      status: 'running',
      progress: 0,
      external: true,
    });

    logger.info(`[SyncOrchestrator] Registered external sync: ${type}`);
    this.setState({
      isRunning: true,
      queue,
    });
  }

  /**
   * Update progress/phase for an external sync.
   */
  updateExternalSync(type: SyncType, updates: Partial<Pick<SyncItem, 'progress' | 'phase'>>): void {
    const existing = this.state.queue.find((item) => item.type === type && item.external);
    if (!existing) return;

    this.updateQueueItem(type, updates);
  }

  /**
   * Mark an external sync as complete or error.
   * After completion, recalculates isRunning from remaining queue items.
   */
  completeExternalSync(type: SyncType, result: { status: 'complete' | 'error'; error?: string }): void {
    const existing = this.state.queue.find((item) => item.type === type && item.external);
    if (!existing) return;

    logger.info(`[SyncOrchestrator] External sync '${type}' completed with status: ${result.status}`);

    this.updateQueueItem(type, {
      status: result.status,
      progress: result.status === 'complete' ? 100 : existing.progress,
      error: result.error,
      phase: undefined,
    });

    // Recalculate isRunning: true if any item is still running
    const stillRunning = this.state.queue.some((item) => item.status === 'running');
    if (!stillRunning && !this.abortController) {
      this.setState({ isRunning: false, currentSync: null });
    }

    // Auto-remove completed/errored external items after a short delay
    setTimeout(() => {
      const queue = this.state.queue.filter(
        (item) => !(item.type === type && item.external && (item.status === 'complete' || item.status === 'error'))
      );
      if (queue.length !== this.state.queue.length) {
        this.setState({ queue });
      }
    }, 3000);
  }

  /**
   * Remove an external sync from the queue immediately (used for cancel).
   * Unlike completeExternalSync, this does not mark it as complete — it just removes it.
   */
  removeExternalSync(type: SyncType): void {
    const queue = this.state.queue.filter(
      (item) => !(item.type === type && item.external)
    );
    if (queue.length === this.state.queue.length) return;

    logger.info(`[SyncOrchestrator] External sync '${type}' removed (cancelled)`);

    const stillRunning = queue.some((item) => item.status === 'running');
    this.setState({
      queue,
      isRunning: stillRunning || !!this.abortController,
      currentSync: stillRunning ? this.state.currentSync : null,
    });
  }

  /**
   * Cancel current sync (internal syncs only).
   * External syncs are NOT cancelled by this method -- they manage their own lifecycle.
   */
  cancel(): void {
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Sync cancelled',
      level: 'info',
      data: {
        currentSync: this.state.currentSync,
        queueLength: this.state.queue.length,
      },
    });

    if (this.abortController) {
      this.abortController.abort();
      // Don't null the controller here -- startSync()'s for-loop checks
      // signal.aborted to break, and the finally block handles cleanup.
    }

    // Preserve external sync items (e.g., iPhone) -- they manage their own lifecycle
    const externalItems = this.state.queue.filter((item) => item.external);
    const stillRunning = externalItems.some((item) => item.status === 'running');

    this.setState({
      isRunning: stillRunning,
      queue: externalItems,
      currentSync: null,
      overallProgress: 0,
    });
  }

  /**
   * Reset ALL state (e.g., on logout).
   * Unlike cancel(), this clears external sync items too.
   */
  reset(): void {
    if (this.abortController) {
      this.abortController.abort();
      // Don't null the controller here -- startSync() finally block handles cleanup.
    }
    this.setState({
      isRunning: false,
      queue: [],
      currentSync: null,
      overallProgress: 0,
      pendingRequest: null,
    });
  }

  /**
   * Start sync with given request
   */
  private async startSync(request: SyncRequest): Promise<void> {
    const { types, userId } = request;

    // Filter to only types that have registered sync functions
    const validTypes = types.filter((type) => this.syncFunctions.has(type));
    if (validTypes.length === 0) {
      logger.warn('[SyncOrchestrator] No valid sync types in request:', types);
      return;
    }

    // Preserve any external sync items already in the queue
    const externalItems = this.state.queue.filter((item) => item.external);

    // Initialize queue with pending status for internal syncs + existing external items
    const queue: SyncItem[] = [
      ...validTypes.map((type) => ({
        type,
        status: 'pending' as SyncItemStatus,
        progress: 0,
      })),
      ...externalItems,
    ];

    this.abortController = new AbortController();
    this.setState({
      isRunning: true,
      queue,
      currentSync: null,
      overallProgress: 0,
    });

    try {
      // Run syncs sequentially
      for (let i = 0; i < validTypes.length; i++) {
        // Check if cancelled
        if (this.abortController?.signal.aborted) {
          break;
        }

        const type = validTypes[i];
        const syncFn = this.syncFunctions.get(type);
        if (!syncFn) continue;

        // Update current sync
        this.updateQueueItem(type, { status: 'running', progress: 0 });
        this.setState({ currentSync: type });

        Sentry.addBreadcrumb({
          category: 'sync',
          message: `Sync started: ${type}`,
          level: 'info',
          data: {
            syncType: type,
            userId: userId.substring(0, 8) + '...',
            queuePosition: i + 1,
            queueTotal: validTypes.length,
          },
        });

        try {
          // Run the sync with progress callback and abort signal
          const warning = await syncFn(userId, (percent, phase) => {
            this.updateQueueItem(type, { progress: percent, phase });
            this.updateOverallProgress();
          }, request.options, this.abortController?.signal);

          Sentry.addBreadcrumb({
            category: 'sync',
            message: `Sync completed: ${type}`,
            level: 'info',
            data: {
              syncType: type,
              hadWarning: !!warning,
            },
          });

          // Mark complete (clear phase), attach warning if returned
          this.updateQueueItem(type, { status: 'complete', progress: 100, phase: undefined, warning: warning || undefined });
        } catch (error) {
          // Check if it was cancelled
          if (this.abortController?.signal.aborted) {
            break;
          }

          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[SyncOrchestrator] ${type} sync failed:`, error);
          // BACKLOG-2127: preserve the typed reconnect provider so the UI can
          // render a "Reconnect" CTA without parsing the message text.
          const reconnectProvider = error instanceof EmailReconnectError ? error.provider : undefined;
          this.updateQueueItem(type, { status: 'error', error: errorMsg, reconnectProvider });
        }

        this.updateOverallProgress();
      }
    } finally {
      // Defensive: ALWAYS reset currentSync and abortController when startSync exits.
      // isRunning depends on whether external syncs are still active.
      const stillRunning = this.state.queue.some(
        (item) => item.external && item.status === 'running'
      );
      this.setState({
        isRunning: stillRunning,
        currentSync: null,
      });
      this.abortController = null;

      // Auto-clear completed/errored internal items after delay
      // (mirrors external sync cleanup in completeExternalSync)
      setTimeout(() => {
        const queue = this.state.queue.filter(
          (item) => item.external || (item.status !== 'complete' && item.status !== 'error')
        );
        if (queue.length !== this.state.queue.length) {
          this.setState({ queue });
        }
      }, 5000); // 5s — outlasts the 3s UI auto-dismiss timer
    }
  }

  private updateQueueItem(type: SyncType, updates: Partial<SyncItem>): void {
    const queue = this.state.queue.map((item) =>
      item.type === type ? { ...item, ...updates } : item
    );
    this.setState({ queue });
  }

  private updateOverallProgress(): void {
    const internalItems = this.state.queue.filter((item) => !item.external);
    if (internalItems.length === 0) {
      this.setState({ overallProgress: 0 });
      return;
    }

    const totalProgress = internalItems.reduce((sum, item) => sum + item.progress, 0);
    const overallProgress = Math.round(totalProgress / internalItems.length);
    this.setState({ overallProgress });
  }
}

// Singleton instance
export const syncOrchestrator = new SyncOrchestratorServiceClass();

// Auto-initialize on module load (renderer process only)
if (typeof window !== 'undefined') {
  syncOrchestrator.initializeSyncFunctions();
}

export default syncOrchestrator;
