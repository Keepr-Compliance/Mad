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
// BACKLOG-2743: type-only import of the shared refusal shape (one definition,
// re-exported by the IPC contract). Type-only is the only safe direction across
// the renderer-main boundary.
import type { AttachmentsRefusedForSpace } from '@electron/types/ipc/window-api-messages';

export type SyncType = 'contacts' | 'emails' | 'messages' | 'iphone'
  | 'reindex' | 'backup' | 'restore' | 'ccpa-export';

/**
 * BACKLOG-2794 added `'skipped'`: the run reached this leg and did not run it,
 * because the user cancelled while it was still queued.
 *
 * A terminal state of its own rather than a `'complete'` carrying a flag. The
 * distinction is load-bearing on the dashboard, where `'complete'` renders a
 * green tick — a leg that never ran has not synced anything, and saying it did
 * is the class of small lie this surface has spent five items removing.
 *
 * Consumers that ask "is this sync active?" (`status === 'running' ||
 * status === 'pending'`) are correct unchanged: a skipped leg is not active.
 * Consumers that enumerate TERMINAL states must include it, or the item is
 * immortal — see the queue clean-up in `startSync` and the completion
 * transition in `SyncStatusIndicator`.
 */
export type SyncItemStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped';

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
  /**
   * BACKLOG-2329: actual number of rows the sync imported (e.g. messages).
   * Propagated from the sync function's structured result so the settings UI
   * can report the true count instead of always showing 0.
   */
  importedCount?: number;
  /**
   * BACKLOG-2748: the user cancelled this sync from the UI. A cancel is never
   * an error, and consumers must report it as a cancel — with a PARTIAL
   * `importedCount` — rather than as a clean finish.
   *
   * BACKLOG-2794: the status it arrives with depends on WHEN the user pressed
   * Cancel, and both are non-error:
   *   - cancelled while RUNNING  → `'complete'` with whatever was kept;
   *   - cancelled while PENDING  → `'skipped'` with nothing imported, because
   *     the leg never ran (see `markCancelRequested`).
   * Every consumer of this flag treats the two alike; only the pill and the
   * green tick differ.
   */
  cancelled?: boolean;
  /**
   * BACKLOG-2794: this leg found the work already in flight and joined it
   * rather than doing it again.
   *
   * Set when `macOSMessagesImportService` refuses a second concurrent import.
   * The item is `'complete'` and carries NO error — the import IS happening,
   * driven by whoever holds the service — but nothing about this run's own
   * counts is meaningful, so surfaces must not report an outcome for it.
   *
   * Deliberately NOT `cancelled`: a user cancel silences the run's completion
   * card (BACKLOG-2330/2748), and a collision in the messages leg must not
   * silence the notice that contacts and emails synced.
   */
  coalesced?: boolean;
  /**
   * BACKLOG-2775: the cancelled run was a force re-import that rolled back.
   * `importedCount` is 0 and the store is byte-identical to before the run.
   */
  rolledBack?: boolean;
  /**
   * BACKLOG-2776: the user has pressed Cancel and the run has not stopped yet.
   *
   * Set the moment the button is clicked, with no round trip to the main
   * process, and it lives on the QUEUE ITEM rather than in a component so every
   * surface reading this item agrees. The settings panel and the dashboard's
   * SyncStatusIndicator both render a percentage from `progress`; while this
   * flag is set the orchestrator stops applying progress updates, so the number
   * freezes where it was when the user clicked. Before that, the percentage
   * kept climbing through a cancel the founder had already pressed twice —
   * the UI carrying on exactly as if nothing had been asked of it.
   */
  cancelRequested?: boolean;
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
  // BACKLOG-2330: monotonic counter bumped each time an external sync is
  // removed via cancel (removeExternalSync). Lets the dashboard indicator tell
  // a user-initiated cancel (queue emptied by removal) apart from a genuine
  // completion (queue emptied because everything finished) so it does not
  // surface a cancel as a false "Sync Complete" card.
  externalCancelCount: number;
}

export interface SyncRequest {
  types: SyncType[];
  userId: string;
  options?: {
    forceReimport?: boolean;
    overrideCap?: boolean;
  };
}

/**
 * Structured result a sync function may return.
 * BACKLOG-2329: carries the imported count (and optional warning) so the
 * orchestrator can surface the real number to the UI.
 */
export interface SyncResult {
  /** Non-fatal warning to display (e.g., "cap exceeded"). */
  warning?: string;
  /** Number of rows imported by this sync (e.g., messages). */
  importedCount?: number;
  /**
   * BACKLOG-2748: the sync stopped because the user cancelled it. `importedCount`
   * is then the real partial count of what was kept.
   */
  cancelled?: boolean;
  /**
   * BACKLOG-2775: the cancelled sync was a force re-import and it rolled back,
   * so `importedCount` is 0 and nothing in the store changed.
   */
  rolledBack?: boolean;
  /**
   * BACKLOG-2794: the sync found its work already in flight and joined it.
   * Neither a success to report nor a failure to raise — see
   * {@link SyncItem.coalesced}.
   */
  coalesced?: boolean;
}

/**
 * Sync functions can return nothing, a bare warning string (legacy shape),
 * or a structured {@link SyncResult} (e.g. messages, to report the count).
 */
type SyncFunction = (
  userId: string,
  onProgress: (percent: number, phase?: string) => void,
  options?: SyncRequest['options'],
  signal?: AbortSignal
) => Promise<string | void | SyncResult>;

type StateListener = (state: SyncOrchestratorState) => void;

class SyncOrchestratorServiceClass {
  private state: SyncOrchestratorState = {
    isRunning: false,
    queue: [],
    currentSync: null,
    overallProgress: 0,
    pendingRequest: null,
    externalCancelCount: 0,
  };

  private listeners: Set<StateListener> = new Set();
  private abortController: AbortController | null = null;

  // Canonical sync functions - one per type
  private syncFunctions: Map<SyncType, SyncFunction> = new Map();

  /**
   * BACKLOG-2794: types the user cancelled while they were still PENDING, which
   * `startSync`'s loop consults before running each leg.
   *
   * A set consulted by the LOOP, not a queue edit, because the loop iterates
   * `validTypes` — the queue is a projection built from it at the top of
   * `startSync`, not the thing being walked. Removing the queue row (the
   * shape "a pending cancel = remove from queue" suggests) would take the row
   * off the screen and run the sync anyway: a Cancel button that hides its own
   * evidence. Pinned by "the messages sync function is never invoked".
   *
   * Scoped to one run: seeded empty by `startSync`, entries consumed when the
   * loop reaches them, and dropped wholesale by `cancel()` / `reset()`.
   */
  private skipRequests: Set<SyncType> = new Set();

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
   * Read the contact-source preferences for a contacts sync, in one IPC call.
   * TASK-2098: Consolidated to avoid duplicate preferences.get calls per sync.
   *
   * BACKLOG-2477: this deliberately does NOT read `messages.source`. Contacts
   * are checkboxes — `contactSources.direct.*` are independent booleans and a
   * user can hold Mac and Outlook and Google contacts at once, each tagged with
   * its own source. `messages.source` is a radio button: exclusive by
   * construction, correct for text messages, and not an answer to any question
   * about contacts. See `getImportSource` below, which is the messages-only
   * reader.
   */
  private async getContactsSyncPreferences(userId: string): Promise<{
    contactSources: { macosContacts: boolean; outlookContacts: boolean; googleContacts: boolean };
  }> {
    const defaults = {
      contactSources: { macosContacts: true, outlookContacts: true, googleContacts: true },
    };

    try {
      const result = await window.api.preferences.get(userId);
      const prefs = result.preferences as UserPreferences | undefined;
      if (!result.success || !prefs) return defaults;

      // Extract contact source preferences (TASK-2098)
      const direct = prefs.contactSources?.direct;
      const contactSources = {
        macosContacts: typeof direct?.macosContacts === 'boolean' ? direct.macosContacts : true,
        outlookContacts: typeof direct?.outlookContacts === 'boolean' ? direct.outlookContacts : true,
        googleContacts: typeof direct?.googleContacts === 'boolean' ? direct.googleContacts : true,
      };

      return { contactSources };
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

      if (signal?.aborted) return;

      // TASK-2098: Read the contact source preferences in one IPC call.
      //
      // BACKLOG-3029 MOVED THIS ABOVE THE WIPE. The force re-import used to
      // empty the shadow table before anything had read the preferences, so it
      // could not have known which sources it was about to refill — and emptied
      // all of them. This read now serves both jobs, which is the point: the
      // phases below and the wipe above must not be able to disagree about
      // which sources are in play.
      const { contactSources: sourcePrefs } = await this.getContactsSyncPreferences(userId);
      logger.info('[SyncOrchestrator] Contact source preferences:', sourcePrefs);

      // BACKLOG-3029 — ONE BOOLEAN PER PHASE, READ BY BOTH THE WIPE AND THE PHASE.
      //
      // Each of these used to be spelled out inline at its `if`, and the force
      // re-import wipe ran before any of them existed. Naming them once is what
      // makes "we only empty what we are about to refill" a fact about the code
      // rather than a claim about two conditions that happen to match today: a
      // change to a gate cannot move the phase without moving the wipe with it.
      const willSyncMacOS = macOS && sourcePrefs.macosContacts;
      const willSyncOutlook = sourcePrefs.outlookContacts;
      const willSyncGoogle = sourcePrefs.googleContacts;

      // TASK-2150 / BACKLOG-3029: handle force re-import by emptying the shadow
      // rows for exactly the sources the phases below WILL refill.
      //
      // A source that is switched off, or a macOS address book on Windows, is
      // not refilled and so must not be emptied. Sources the desktop cannot
      // fetch at all (`android_sync`, `iphone`) have no phase here, so they are
      // never named; the main process independently refuses to empty them
      // (`CONTACT_SOURCE_REFETCHABILITY`).
      if (options?.forceReimport) {
        if (signal?.aborted) return;

        const sourcesToRefill: string[] = [
          ...(willSyncMacOS ? ['macos'] : []),
          ...(willSyncOutlook ? ['outlook'] : []),
          ...(willSyncGoogle ? ['google_contacts'] : []),
        ];

        const wipeResult = await window.api.contacts.forceReimport(userId, sourcesToRefill);
        if (!wipeResult.success) {
          throw new Error(wipeResult.error || 'Failed to clear contacts for re-import');
        }
        logger.info(
          '[SyncOrchestrator] Contacts wiped for force re-import:',
          { sources: sourcesToRefill, cleared: wipeResult.cleared },
        );
      }

      // Phase 1: macOS Contacts sync (macOS only, skip if the source is unticked)
      //
      // BACKLOG-2477: this gate used to also require `importSource !== 'iphone-sync'`.
      // That made a question about TEXT MESSAGES answer a question about CONTACTS:
      // a user who ticked Mac Contacts and then told the app their texts come from
      // an iPhone — by pairing, by the Settings radio, or by answering the
      // onboarding phone-type step on Windows — stopped getting Mac contacts, with
      // nothing on screen saying so and no way to override it from the Contacts
      // checkboxes. `macosContacts` is now the only thing that decides.
      if (willSyncMacOS) {
        const result = await window.api.contacts.syncExternal(userId);
        if (!result.success) {
          throw new Error(result.error || 'macOS Contacts sync failed');
        }
        logger.info('[SyncOrchestrator] macOS Contacts sync complete');
      } else if (macOS) {
        logger.info('[SyncOrchestrator] Skipping macOS Contacts (disabled by user preference)');
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
      if (!willSyncOutlook) {
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
      if (!willSyncGoogle) {
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
      // BACKLOG-2313: secondary, NON-authoritative guard. The main-process
      // transactions:scan handler is the source of truth (it re-checks
      // entitlement + the enable_auto_detect toggle); this only avoids a wasted
      // IPC round-trip when the org is not entitled to ai_detection — the same
      // entitlement `hasAIAddon` derives from. Fail-OPEN: if the check is
      // unavailable or errors, still call scan and let main decide. Precache
      // below runs for ALL users regardless.
      let aiScanAllowed = true;
      try {
        const check = window.api.featureGate?.check;
        if (check) {
          const gate = await check('ai_detection');
          aiScanAllowed = gate?.allowed === true;
        }
      } catch (gateError) {
        logger.warn('[SyncOrchestrator] ai_detection entitlement check failed; running scan (main gate is authoritative):', gateError);
        aiScanAllowed = true;
      }
      if (signal?.aborted) return;
      if (aiScanAllowed) {
        try {
          const result = await window.api.transactions.scan(userId);
          if (!result.success) {
            logger.warn('[SyncOrchestrator] AI email scan failed (non-fatal):', result.error);
          }
        } catch (scanError) {
          logger.warn('[SyncOrchestrator] AI email scan threw (non-fatal):', scanError);
        }
      } else {
        logger.info('[SyncOrchestrator] Skipping AI email scan — ai_detection not entitled (precache still runs)');
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
        // IPC listener OWNED here - not in consumers
        const cleanup = window.api.messages.onImportProgress((data) => {
          // BACKLOG-2793: the force path used to emit a fourth `deleting` phase
          // and this divisor switched 3<->4 to match. Stage-and-swap (BACKLOG-2790)
          // removed that phase, so the phase list is fixed at three.
          const phases = ['querying', 'importing', 'attachments'];
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
          // TASK-2150: Pass forceReimport option through to IPC call.
          //
          // BACKLOG-2775: this used to re-declare the function's whole shape in
          // an `as` cast, because the canonical type took one parameter while
          // the preload bridge took two. Every field the main process added had
          // to be re-typed HERE to be visible — which is how `rolledBack` would
          // have gone missing. The canonical type now matches the bridge, so the
          // call needs no cast and new fields arrive on their own.
          const result = await window.api.messages.importMacOSMessages(
            userId,
            options?.forceReimport
          );
          // BACKLOG-2748: the cancel check comes BEFORE the success check on
          // purpose. A cancel during the query phase returns success:false with
          // error:"Import cancelled", and the throw below would turn the user's
          // own Cancel press into a red "Import failed" card. Cancelling later
          // returns success:true with partial counts. Both are the same outcome
          // to the user, so both leave here as a cancelled result carrying
          // whatever was actually kept.
          if (result.cancelled) {
            logger.info(
              '[SyncOrchestrator] Messages sync cancelled by user, imported:',
              result.messagesImported
            );
            // BACKLOG-2775: `rolledBack` travels with the cancel because the two
            // outcomes read differently to the user — "N were imported before
            // you stopped it" versus "nothing changed" — and the panel must not
            // have to infer which one happened from its own memory of having
            // asked for a force re-import.
            return {
              cancelled: true,
              importedCount: result.messagesImported,
              rolledBack: result.rolledBack,
            };
          }
          // BACKLOG-2794: a COLLISION is not a failure, and like the cancel
          // above it has to be caught before the throw below.
          //
          // `macOSMessagesImportService` serializes to one import at a time and
          // refuses the second caller. That refusal arrives as `success: false`,
          // so the throw turned it into a red "Import failed" pill — and, via
          // the error escalation in `startSync`, into "Sync Completed with
          // Errors" plus a support-ticket link for a sync in which everything
          // else worked. Since PR #2343 promoted the transaction trigger, the
          // collision is routine: creating a deal starts an import that the
          // user's own dashboard sync then runs into.
          //
          // Coalesce instead. The messages work IS being done — by the run that
          // holds the service — so this leg reports that, not a fault. Branching
          // on the typed flag, never on the `error` text.
          if (result.alreadyInProgress) {
            logger.info(
              '[SyncOrchestrator] Messages import already in flight; coalescing with the running import'
            );
            onProgress(100);
            return { coalesced: true };
          }
          if (!result.success) {
            throw new Error(result.error || 'Message import failed');
          }
          onProgress(100);
          logger.info('[SyncOrchestrator] Messages sync complete, imported:', result.messagesImported);

          // BACKLOG-2329: propagate the real imported count so the settings UI
          // reports it (the completion message previously always showed 0
          // because only the auto-link count was surfaced). Also return the
          // cap warning when the import limit excluded messages.
          //
          // BACKLOG-2794: the subtrahend is `coveredCount`, not
          // `messagesImported`. What the run FETCHED and what the window COVERS
          // are different numbers — a delta import does not re-download what
          // the store already holds — and only the second belongs in a sentence
          // about exclusion. On the founder's restore this line said
          // 708,400 − 48,781 = 659,619 messages excluded, counting the 14,042 he
          // already had as left out; the honest figure is 708,400 − 62,824 =
          // 645,576 (`a14b3a82`).
          //
          // Two silences, both deliberate:
          //   - `excluded <= 0` emits NOTHING. A window that fits under the cap
          //     excluded nothing, and "0 messages excluded by import limit" is
          //     noise about a limit that did not act.
          //   - `coveredCount` absent emits nothing either. Without it the
          //     correct figure cannot be computed, and no clause beats the wrong
          //     clause this item exists to remove.
          //
          // The SENTENCE is unchanged on purpose. `stripStaleCapClause`
          // (`MacOSMessagesImportSettings.tsx`) deletes it from the Settings
          // completion strip with an anchored, number-agnostic regex, because
          // the founder removed that sentence from that surface (`fa2112c8`).
          // Rewording here silently stops that strip matching and puts the
          // clause back on a surface he cleared. Any copy change to this string
          // must move the regex in the same commit — pinned by
          // "the corrected sentence is stripped too" in
          // `MacOSMessagesImportSettings.onePlanDialog-2749.test.tsx`.
          let warning: string | undefined;
          if (result.wasCapped && result.totalAvailable && result.coveredCount !== undefined) {
            const excluded = result.totalAvailable - result.coveredCount;
            if (excluded > 0) {
              warning = `${excluded.toLocaleString()} messages excluded by import limit. Adjust in Settings.`;
            }
          }
          // BACKLOG-2743: the pre-flight free-space check refused the attachment
          // copy. The messages themselves imported fine, so this is a warning and
          // not an error — but it must be SAID, or attachments would go missing
          // with the UI reporting unqualified success.
          if (result.attachmentsRefusedForSpace) {
            const needGb = result.attachmentsRefusedForSpace.estimatedBytes / 1e9;
            const haveGb = result.attachmentsRefusedForSpace.availableBytes / 1e9;
            const spaceWarning =
              `Attachments were not imported: they need ${needGb.toFixed(1)} GB ` +
              `but only ${haveGb.toFixed(1)} GB is free. Messages imported normally.`;
            warning = warning ? `${warning} ${spaceWarning}` : spaceWarning;
          }
          return { warning, importedCount: result.messagesImported };
        } finally {
          cleanup();
        }
      });
    }

    // BACKLOG-2772: mirror main-initiated imports into the queue.
    this.subscribeToBackgroundImports();

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
  /**
   * Mirror a macOS Messages import that MAIN started into the queue
   * (BACKLOG-2772).
   *
   * `messagesSyncTrigger` runs a global import when a deal is created or its
   * start date moves earlier. That import cannot enqueue itself — this queue
   * lives in the renderer and every sync function here dereferences
   * `window.api` — so main announces and this mirrors, the same shape the
   * iPhone sync has used since BACKLOG-2195.
   *
   * The queue item is the point: it is what renders the Cancel button. The
   * cancel mechanism already reached these runs (`requestCancellation` is
   * global to the import service), but nothing ever offered the user the
   * button, so creating a deal on a large library started a scan that could
   * only be escaped by force-quitting.
   *
   * `registerExternalSync` returns early when an item of this type is already
   * running, so a user-initiated import in flight is never displaced by a
   * mirrored one — and `completeExternalSync` no-ops when no EXTERNAL item
   * exists, so the pair is safe in either order.
   */
  private subscribeToBackgroundImports(): void {
    if (typeof window === 'undefined' || !window.api?.messages?.onBackgroundImport) return;

    window.api.messages.onBackgroundImport({
      onStarted: () => {
        this.registerExternalSync('messages');
      },
      onFinished: () => {
        this.completeExternalSync('messages', { status: 'complete' });
      },
    });
  }

  registerExternalSync(type: SyncType): void {
    const existing = this.state.queue.find((item) => item.type === type);

    /*
     * OWNERSHIP, NOT LIVENESS (BACKLOG-2772).
     *
     * The invariant this and `startSync` jointly keep: **at most one queue row
     * per type, and an INTERNAL item always owns it.**
     *
     * This guard used to read `existing.status === 'running'` alone, which was
     * correct while `registerExternalSync` had exactly one caller — the iPhone
     * sync, whose type is never also an internal one. Mirroring the macOS
     * Messages import made `messages` the first type that is BOTH, and a
     * pending internal item then had nothing defending it.
     *
     * What that cost, concretely. A full sync seeds every requested type as
     * `pending` and runs them sequentially, so `messages` sits pending for the
     * whole of the contacts and emails syncs ahead of it — minutes, routinely.
     * Create a transaction with an early start date in that window and the
     * trigger's STARTED announcement filtered the pending internal item out and
     * replaced it with an external one. From there: `updateQueueItem` matches on
     * type alone, so the user's own import drove the mirrored row; the trigger's
     * FINISHED then marked that row complete at 100% and removed it three
     * seconds later — while the user's import was still running. The row
     * vanished, the Cancel button with it, and the UI reported a completion that
     * had not happened.
     *
     * A `complete`/`error` internal item is stale and does NOT own anything —
     * replacing it is the pre-existing behaviour and stays.
     */
    if (
      existing &&
      !existing.external &&
      (existing.status === 'pending' || existing.status === 'running')
    ) {
      logger.debug(
        `[SyncOrchestrator] '${type}' is already queued as an internal sync; not mirroring`
      );
      return;
    }
    if (existing && existing.external && existing.status === 'running') {
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
      // BACKLOG-2330: signal a user-initiated cancel so the dashboard indicator
      // suppresses the (false) "Sync Complete" card that a running->empty queue
      // transition would otherwise trigger.
      externalCancelCount: this.state.externalCancelCount + 1,
    });
  }

  /**
   * BACKLOG-2776: record that the user has asked this sync to stop.
   *
   * Renderer-side and synchronous, on purpose. The main process decides WHEN an
   * import can stop — between batches, or after a clear phase that can run for
   * half a minute — but the UI must not wait on that to show it heard the
   * click. Marking the queue item freezes the percentage every surface renders
   * from it (see `SyncItem.cancelRequested`) and lets each one relabel
   * immediately, in the same tick as the press.
   *
   * This does NOT stop the sync: it is the acknowledgement, not the mechanism.
   * The actual cancel goes to the main process by IPC, and the run ends by
   * returning a cancelled result of its own.
   *
   * ## BACKLOG-2794: the same press on a PENDING item
   *
   * A pending leg has no run to stop — it has a run to PREVENT. The queue seeds
   * every requested type as pending and works through them in order, so on a
   * dashboard sync of ['contacts', 'emails', 'messages'] the messages item sits
   * pending for the whole of the two syncs ahead of it, routinely minutes. Cancel
   * was gated on `'running'` at both ends (here, and `cancelAvailable` in the
   * settings panel), so for those minutes the founder had a queued import he
   * could watch and could not stop.
   *
   * Pending presses register a SKIP that `startSync`'s loop consults before it
   * runs the leg; the item lands `'skipped'`, carrying `cancelled` so every
   * surface already reading that flag treats it as the user's cancel. No IPC
   * belongs to this path: nothing is importing, and `requestCancellation()`
   * ARMS a cancel for the next run to start (BACKLOG-2776), which would make
   * this press stop an unrelated import seconds later.
   *
   * The status is read HERE, from live state, and returned — the caller cannot
   * classify the press itself without racing the pending→running flip, which
   * happens in this same tick with no await between. See `handleCancelImport`.
   *
   * @returns what the press actually did: `'running'` (acknowledged, the caller
   *   must still send the cancel IPC), `'skipped'` (the leg will not run; no
   *   IPC), or `'none'` (nothing to cancel, or already requested).
   */
  markCancelRequested(type: SyncType): 'running' | 'skipped' | 'none' {
    const item = this.state.queue.find((queued) => queued.type === type);
    if (!item || item.cancelRequested) return 'none';

    if (item.status === 'pending') {
      logger.info(`[SyncOrchestrator] Cancel requested for pending '${type}' — it will be skipped`);
      this.skipRequests.add(type);
      // `cancelRequested` is set here too: it is what makes this method
      // idempotent for a second press, and what freezes any surface rendering
      // this item during the gap before the loop reaches it.
      this.updateQueueItem(type, { cancelRequested: true });
      return 'skipped';
    }

    if (item.status !== 'running') return 'none';

    logger.info(`[SyncOrchestrator] Cancel requested for '${type}' — freezing reported progress`);
    this.updateQueueItem(type, { cancelRequested: true });
    return 'running';
  }

  /**
   * BACKLOG-2794: read a queue item from LIVE state.
   *
   * The React copy a component holds is one render behind, and the one decision
   * that cannot tolerate that is whether a Cancel press meets a running import
   * (send the IPC) or a pending one (do not). Callers that only render should
   * keep using the subscribed state.
   */
  getQueueItem(type: SyncType): SyncItem | undefined {
    return this.state.queue.find((item) => item.type === type);
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

    // BACKLOG-2794: the run these skips belonged to is being abandoned.
    this.skipRequests.clear();

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
    // BACKLOG-2794: a skip must not outlive the session it was requested in.
    this.skipRequests.clear();
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

    /*
     * Preserve external sync items — EXCEPT for a type this run is about to
     * seed itself (BACKLOG-2772, the other half of the ownership invariant).
     *
     * Without the exclusion the reverse interleaving produces TWO rows of the
     * same type: the trigger's mirrored `messages` item survives here and a
     * fresh internal one is appended beside it. `updateQueueItem` maps over
     * every match, so both rows move together, and the trigger's FINISHED then
     * completes and removes one of them out from under the user's run.
     *
     * WHAT DROPPING THE EXTERNAL ROW COSTS, stated accurately — an earlier
     * version of this comment claimed it cost nothing, and that was wrong.
     *
     * The internal item that replaces it lands as `pending`, and the Settings
     * panel gates its Cancel button on `status === 'running'`
     * (`MacOSMessagesImportSettings.tsx`, `cancelAvailable`). So on a full sync
     * — where `messages` waits behind contacts and emails — the trigger's run
     * keeps going with no Cancel affordance until the queue reaches it, which
     * is minutes rather than seconds.
     *
     * That was a UX gap, not a correctness one: the run is honestly represented
     * (one row, the user's own, in the state it is actually in), and the
     * service's cancel is global, so the button worked the moment it appeared.
     *
     * BACKLOG-2794 closed the gap, and the answer to "what does Cancel mean
     * while nothing is running" turned out not to involve the import service at
     * all: a pending press registers a SKIP that the loop below consults, so
     * the leg never starts (`markCancelRequested`). The mirrored run this
     * comment is about is a separate case — it IS importing, so the press meets
     * a 'running' item and takes the ordinary IPC path.
     */
    const seededTypes = new Set<SyncType>(validTypes);
    const externalItems = this.state.queue.filter(
      (item) => item.external && !seededTypes.has(item.type)
    );

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
    // BACKLOG-2794: skips belong to the run that was cancelled, never to the
    // next one. A stale entry here would silently drop a leg the user did ask
    // for — the failure mode `cancelRequested` had before the orchestrator
    // started clearing it (BACKLOG-2776).
    this.skipRequests.clear();
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

        /*
         * BACKLOG-2794: the user cancelled this leg while it was still pending.
         *
         * The check sits HERE, in the loop over `validTypes`, because that is
         * what actually decides whether a sync runs. The queue is a projection
         * built above from the same array — deleting a row from it removes the
         * pill and runs the import regardless, which is why "a pending cancel =
         * remove from queue" is not the implementation of "a pending cancel".
         *
         * Terminal in one update, with no window in which it is 'running':
         * `cancelled` so the surfaces that already read that flag (the settings
         * strip, the dashboard's cancel gate) treat it as the user's own stop,
         * `progress: 100` because the item is finished — nothing renders that
         * number for a terminal row, and leaving it at 0 would strand
         * `overallProgress` below 100 for a run that is over.
         */
        if (this.skipRequests.has(type)) {
          this.skipRequests.delete(type);
          logger.info(`[SyncOrchestrator] Skipping '${type}' — cancelled while pending`);
          this.updateQueueItem(type, {
            status: 'skipped',
            progress: 100,
            phase: undefined,
            cancelled: true,
            cancelRequested: undefined,
          });
          this.updateOverallProgress();
          continue;
        }

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
          const rawResult = await syncFn(userId, (percent, phase) => {
            // BACKLOG-2776: once the user has pressed Cancel the displayed
            // progress is frozen. The run keeps going until it reaches a point
            // where it can stop, and reporting that continuing work as a rising
            // percentage is what made the founder press Cancel a second time.
            if (this.state.queue.find((item) => item.type === type)?.cancelRequested) {
              return;
            }
            this.updateQueueItem(type, { progress: percent, phase });
            this.updateOverallProgress();
          }, request.options, this.abortController?.signal);

          // BACKLOG-2329: sync functions return either a bare warning string
          // (legacy) or a structured SyncResult carrying the imported count.
          // Normalize both shapes here.
          const warning = typeof rawResult === 'string' ? rawResult : rawResult?.warning;
          const importedCount =
            rawResult && typeof rawResult === 'object' ? rawResult.importedCount : undefined;
          // BACKLOG-2748: a user cancel travels the SAME path as a completion —
          // it is not an error — so the flag has to be carried onto the queue
          // item or the settings panel reports a stopped import as a clean one.
          const cancelled =
            rawResult && typeof rawResult === 'object' ? rawResult.cancelled : undefined;
          // BACKLOG-2775: whether the cancelled run left the store unchanged.
          const rolledBack =
            rawResult && typeof rawResult === 'object' ? rawResult.rolledBack : undefined;
          // BACKLOG-2794: the leg joined an import already in flight. Carried
          // onto the item so surfaces can say so instead of reporting a run
          // that did not happen — see `SyncItem.coalesced`.
          const coalesced =
            rawResult && typeof rawResult === 'object' ? rawResult.coalesced : undefined;

          Sentry.addBreadcrumb({
            category: 'sync',
            message: `Sync completed: ${type}`,
            level: 'info',
            data: {
              syncType: type,
              hadWarning: !!warning,
            },
          });

          // Mark complete (clear phase), attach warning + imported count if returned
          // BACKLOG-2776: `cancelRequested` is cleared here — the request has been
          // served, and leaving it set would freeze the NEXT run's progress at 0.
          this.updateQueueItem(type, { status: 'complete', progress: 100, phase: undefined, warning: warning || undefined, importedCount, cancelled, rolledBack, coalesced, cancelRequested: undefined });
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
          this.updateQueueItem(type, { status: 'error', error: errorMsg, reconnectProvider, cancelRequested: undefined });
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
      //
      // BACKLOG-2794: 'skipped' is terminal and belongs in this set. Left out,
      // a leg the user cancelled while pending is the one row this queue can
      // never clear — it survives every later run's clean-up and keeps a stale
      // pill on the dashboard indefinitely.
      setTimeout(() => {
        const queue = this.state.queue.filter(
          (item) =>
            item.external ||
            (item.status !== 'complete' && item.status !== 'error' && item.status !== 'skipped')
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
