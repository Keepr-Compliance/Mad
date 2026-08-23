/**
 * macOS Messages Import Service
 *
 * Imports messages from macOS Messages app (~/Library/Messages/chat.db)
 * into the app's local database, enabling message-to-transaction linking on macOS.
 *
 * This service:
 * 1. Checks Full Disk Access permission
 * 2. Reads from the macOS Messages SQLite database
 * 3. Parses attributedBody blobs for message text
 * 4. Deduplicates messages using message GUID
 * 5. Stores messages in the app's messages table
 * 6. Imports and stores image/GIF attachments (TASK-1012)
 *
 * Sub-modules:
 * - types.ts: Type definitions and constants
 * - importHelpers.ts: Standalone utility functions
 */

import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";
import { app } from "electron";

import databaseService from "../databaseService";
import permissionService from "../permissionService";
import logService from "../logService";
// BACKLOG-2403: the single sanctioned sqlite3 open — a bare
// `new sqlite3.Database(path, mode)` crashes the main process on a failed open.
import { openSqliteReadOnly } from "../db/readOnlySqlite";
import { getMessageText } from "../../utils/messageParser";
import { macTimestampToDate } from "../../utils/dateUtils";
import { detectMessageType } from "../../utils/messageTypeDetector";
// BACKLOG-2393: scoped support-access tracing. A no-op unless a user has
// granted a support window covering the message-import scope.
import { supportTrace } from "../supportAccess/trace";
// BACKLOG-2790: the force re-import's staging tables and the one short
// transaction that swaps them into place. This replaced the BACKLOG-2775 design,
// where the force path held a single BEGIN IMMEDIATE transaction open for the
// whole run and had to PAUSE the two main-process sync timers so their writes
// could not be caught in its rollback. Nothing is paused any more — see
// `swapStagingIntoLive`.
import {
  forceStagingLifecycle,
  forceReadView,
  swapStagingIntoLive,
  sweepStaleStaging,
  SURVIVING_ATTACHMENTS,
  SURVIVING_MESSAGES,
  type ForceStaging,
} from "./forceStaging";

import type {
  MacOSImportResult,
  ImportProgressCallback,
  MessageAttachment,
  RawMacMessage,
  ChatMemberRow,
  ChatAccountRow,
  RawMacAttachment,
  AttachmentsRefusedForSpace,
} from "./types";

import {
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_HANDLE_LENGTH,
  BATCH_SIZE,
  YIELD_INTERVAL,
  MAX_ATTACHMENT_SIZE,
  ATTACHMENTS_DIR,
  TEXT_EXTRACTION_YIELD_INTERVAL,
  PROGRESS_REPORT_INTERVAL,
} from "./types";

import {
  createProgressBar,
  calculateQueryBatchSize,
  yieldToEventLoop,
  sanitizeString,
  isValidGuid,
  isSupportedMediaType,
  getMimeTypeFromFilename,
  generateContentHash,
  buildMessageWindowSql,
  resolveAdmittedMessageSet,
  shouldRetainMessageContent,
  isReactionAssociationType,
  summarizeAttachmentEstimate,
  filterUnstoredAttachments,
  filterResolvableAttachments,
  attachmentStoredKey,
} from "./importHelpers";
import type { AttachmentSizeRow } from "./importHelpers";
// BACKLOG-2772: the ONE decision object every entry point hands this service.
import type { ImportPlan } from "../importPlan";
import { normalizeAssociatedGuid } from "../../utils/reactionUtils";
// BACKLOG-2743: df-equivalent free space + the single space verdict helper.
import { getAvailableDiskBytes, evaluateAttachmentSpace } from "../../utils/diskSpace";

/**
 * macOS Messages Import Service
 * Handles importing messages from the macOS Messages app
 */
class MacOSMessagesImportService {
  private static readonly SERVICE_NAME = "MacOSMessagesImportService";

  /** Flag to prevent concurrent imports */
  private isImporting = false;
  /** Timestamp when import started (for stuck flag detection) */
  private importStartedAt: number | null = null;
  /** TASK-2047: AbortController for clean cancellation via AbortSignal */
  private abortController: AbortController | null = null;
  /** Flag to indicate force reimport is in progress (blocks all other imports) */
  private forceReimportInProgress = false;
  /** Max import duration before auto-reset (10 minutes) */
  private static readonly MAX_IMPORT_DURATION_MS = 10 * 60 * 1000;
  /**
   * BACKLOG-2776: when a cancel arrived with no import in flight, the epoch ms
   * at which it arrived. Null once consumed or expired.
   *
   * Pressing Cancel used to reach nothing in the window between the queue item
   * turning 'running' — which is when the renderer offers the button — and this
   * service setting `isImporting`. The renderer's sync fn reads the import
   * source and the IPC handler validates the user and loads preferences in that
   * window, so it is real, sub-second, and the founder pressed Cancel inside it
   * twice because the UI acknowledged a cancel that had been dropped.
   *
   * Holding the request instead makes the acknowledgement honest: the run that
   * starts next consumes it and aborts immediately.
   */
  private pendingCancellationAt: number | null = null;
  /**
   * BACKLOG-2776: how long a cancel with no run in flight stays armed.
   *
   * The gap it covers is sub-second; the generous bound is what keeps a stray
   * cancel (e.g. pressed as a run finished on its own) from silently killing an
   * import the user starts minutes later. It deliberately does NOT stretch to
   * the multi-minute window where the messages item sits 'pending' behind a
   * contacts+emails sync — a cancel cannot be held that long without becoming a
   * different kind of lie, which is why the renderer still offers the button
   * only while the item is 'running'.
   */
  private static readonly PENDING_CANCEL_TTL_MS = 10 * 1000;
  /**
   * Import messages from the macOS Messages app.
   *
   * BACKLOG-2772: takes a resolved `ImportPlan` and nothing else. It used to
   * take a `forceReimport` boolean and a loose `MessageImportFilters` bag, and
   * every caller built that bag itself — which is how the Settings button, the
   * estimate and the transaction trigger came to disagree about what an import
   * fetches. The plan is produced by exactly one function
   * (`resolveImportPlanForUser`), so there is nowhere left to disagree.
   *
   * `mode` carries what `forceReimport` used to (D2'): both modes cover the
   * SAME window and differ only in how they process it.
   *
   * @param userId - User ID
   * @param onProgress - Progress callback
   * @param plan - The resolved import plan (see `services/importPlan.ts`)
   */
  async importMessages(
    userId: string,
    onProgress: ImportProgressCallback | undefined,
    plan: ImportPlan
  ): Promise<MacOSImportResult> {
    const startTime = Date.now();
    const forceReimport = plan.mode === "reprocess";

    // If force reimport is in progress, block ALL other imports
    //
    // BACKLOG-2794: `alreadyInProgress` for the same reason the concurrent-
    // import refusal below carries it — a request another run owns is a
    // collision, not a failure, and the orchestrator must not paint it red.
    // The `error` text stays for the log and for anything reading the message.
    if (this.forceReimportInProgress && !forceReimport) {
      logService.warn(
        "Force reimport in progress, blocking regular import",
        MacOSMessagesImportService.SERVICE_NAME
      );
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration: 0,
        error: "Force reimport in progress",
        alreadyInProgress: true,
      };
    }

    // Force reimport takes priority - cancel any running import
    if (forceReimport && this.isImporting) {
      logService.warn(
        "Force reimport requested, cancelling current import",
        MacOSMessagesImportService.SERVICE_NAME
      );
      this.abortController?.abort();
      // Wait a bit for the current import to notice the cancellation
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.isImporting = false;
      this.importStartedAt = null;
    }

    // Check if import flag is stuck (been true for too long)
    if (this.isImporting && this.importStartedAt) {
      const elapsed = Date.now() - this.importStartedAt;
      if (elapsed > MacOSMessagesImportService.MAX_IMPORT_DURATION_MS) {
        logService.warn(
          `Import flag stuck for ${Math.round(elapsed / 1000)}s, auto-resetting`,
          MacOSMessagesImportService.SERVICE_NAME
        );
        this.isImporting = false;
        this.importStartedAt = null;
      }
    }

    // Prevent concurrent imports - only one at a time
    //
    // BACKLOG-2794: the refusal is announced with `alreadyInProgress` so the
    // caller can COALESCE. Every other `success: false` from this service is a
    // genuine failure and the orchestrator is right to throw on it; this one
    // means the work the caller asked for is already being done by someone
    // else, and throwing turned the transaction trigger colliding with a user's
    // own sync into "Sync Completed with Errors".
    if (this.isImporting) {
      logService.warn(
        "Import already in progress, skipping duplicate request",
        MacOSMessagesImportService.SERVICE_NAME
      );
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration: 0,
        error: "Import already in progress",
        alreadyInProgress: true,
      };
    }

    this.isImporting = true;
    this.importStartedAt = Date.now();
    // TASK-2047: Create AbortController for clean cancellation
    this.abortController = new AbortController();

    // BACKLOG-2776: consume a cancel that arrived in the gap before this run
    // took hold. Aborting the controller here (rather than returning early)
    // routes the run down the ordinary cancellation path, so it reports itself
    // as cancelled exactly like any other stopped import — and, for a force
    // re-import, before the clear phase has destroyed anything.
    const armedAt = this.pendingCancellationAt;
    this.pendingCancellationAt = null;
    if (
      armedAt !== null &&
      Date.now() - armedAt <= MacOSMessagesImportService.PENDING_CANCEL_TTL_MS
    ) {
      logService.info(
        "Applying cancellation requested before this import started",
        MacOSMessagesImportService.SERVICE_NAME
      );
      this.abortController.abort();
    }

    if (forceReimport) {
      this.forceReimportInProgress = true;
    }

    try {
      return await this.doImport(userId, onProgress, startTime, plan);
    } finally {
      this.isImporting = false;
      this.importStartedAt = null;
      this.abortController = null;
      if (forceReimport) {
        this.forceReimportInProgress = false;
      }
    }
  }

  /**
   * Force reset the import lock (for debugging stuck state)
   */
  resetImportLock(): void {
    logService.info(
      "Manually resetting import lock",
      MacOSMessagesImportService.SERVICE_NAME
    );
    this.isImporting = false;
    this.importStartedAt = null;
  }

  /**
   * Request cancellation of the current import (TASK-1710, TASK-2047, TASK-2151)
   *
   * A delta import stops at the next batch boundary, preserving partial data. A
   * force re-import rolls back instead (BACKLOG-2775) and keeps nothing.
   *
   * BACKLOG-2776: when no import is in flight the request is ARMED rather than
   * dropped, and the next run to start consumes it (see `pendingCancellationAt`).
   * Before that, a cancel pressed in the sub-second window between the UI
   * offering the button and this service setting `isImporting` reached nothing,
   * so the "Cancelling…" acknowledgement was a placebo and the user had to press
   * again — which is what the founder did.
   */
  requestCancellation(): void {
    if (this.isImporting) {
      logService.info(
        "Import cancellation requested",
        MacOSMessagesImportService.SERVICE_NAME
      );
      this.abortController?.abort();
      return;
    }

    logService.info(
      "Import cancellation requested before a run is in flight — holding it for the next run",
      MacOSMessagesImportService.SERVICE_NAME
    );
    this.pendingCancellationAt = Date.now();
  }

  /**
   * Internal import implementation
   */
  private async doImport(
    userId: string,
    onProgress: ImportProgressCallback | undefined,
    startTime: number,
    plan: ImportPlan
  ): Promise<MacOSImportResult> {
    const forceReimport = plan.mode === "reprocess";
    // Check platform - macOS only
    if (os.platform() !== "darwin") {
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration: Date.now() - startTime,
        error: "macOS Messages import is only available on macOS",
      };
    }

    // Check Full Disk Access permission
    const permissionCheck = await permissionService.checkFullDiskAccess();
    if (!permissionCheck.hasPermission) {
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration: Date.now() - startTime,
        error:
          permissionCheck.userMessage ||
          "Full Disk Access permission is required to read iMessages",
      };
    }

    /**
     * BACKLOG-2790: the force path's rebuild is written HERE, not into the live
     * tables, and takes their place in one short transaction at the end.
     *
     * `staging` being non-null is the single piece of state everything else
     * keys on: it means this run is rebuilding, so writes go to the staging
     * tables, dedup reads see "what survived the clear ∪ what has been staged",
     * and the exit — any exit — drops it. There is no transaction to roll back
     * and nothing to restore, because nothing was destroyed: until the swap
     * runs, the user's message store is untouched by construction.
     */
    const appDb = forceReimport ? databaseService.getRawDatabase() : null;
    let staging: ForceStaging | null = null;
    /**
     * BACKLOG-2790: true once the swap has committed. It is the exact
     * replacement for BACKLOG-2775's `forceTxnOpen` in the results the UI reads:
     * `rolledBack` means "this force run changed nothing", which before the swap
     * is true of every exit and after it is true of none.
     */
    let forceSwapCommitted = false;
    const nothingChangedYet = (): true | undefined =>
      forceReimport && !forceSwapCommitted ? true : undefined;

    try {
      // BACKLOG-2790: set up the rebuild's scratch space. NOTHING is deleted
      // here — that is the entire change. The old force path opened
      // `BEGIN IMMEDIATE` and deleted the user's whole message cache as its
      // first act, which is why an interruption had to be survived by a
      // rollback and why every writer in the process had to be held still for
      // the length of the run.
      if (forceReimport && appDb) {
        // Check BEFORE doing any work. The founder cancelled ~1s in and still
        // waited out a 35-second delete of 162,961 messages, because the flag
        // was only read between phases. There is no delete to skip any more,
        // but the early exit is still the cheapest possible answer to a cancel.
        if (this.abortController?.signal.aborted) {
          logService.warn(
            "Force reimport cancelled before it started — nothing was touched",
            MacOSMessagesImportService.SERVICE_NAME
          );
          return this.cancelledUnchangedResult(startTime);
        }

        /**
         * A transaction already open on this connection still stops the run —
         * for a new reason, and a subtler one than BACKLOG-2775's.
         *
         * The old force path refused because it was about to run a raw
         * `COMMIT`/`ROLLBACK` that would have resolved someone else's
         * transaction. This one refuses because `db.transaction()` NESTS: inside
         * a foreign transaction the swap becomes a SAVEPOINT, which keeps the
         * three steps atomic with respect to each other but makes the whole
         * re-import visible only if that outer transaction commits — and
         * discarded, silently, under a result reporting success, if it rolls
         * back. Creating and dropping staging tables inside a stranger's
         * transaction is the same bargain.
         *
         * Nothing in the app holds a transaction across an await today. Assert
         * it rather than assume it, because the failure would be silent.
         */
        if (appDb.inTransaction) {
          throw new Error(
            "Cannot start force re-import: a database transaction is already open on this connection"
          );
        }

        // Reclaim the staging tables of any run that died before its swap.
        // The sweep is unscoped and a second Force Re-import aborts the first
        // rather than being refused, so it can drop an abandoned run's tables
        // while that run is still writing to them — data-safe in every
        // interleaving, but see the note at `sweepStaleStaging` for why, and
        // BACKLOG-2797 for the fix.
        const swept = sweepStaleStaging(appDb);
        if (swept.length > 0) {
          logService.info(
            `Reclaimed ${swept.length} staging table(s) left by an interrupted force re-import`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        staging = forceStagingLifecycle.create(appDb, userId);
        logService.info(
          `Force reimport: rebuilding into ${staging.messagesTable} — the existing message store stays in place until the rebuild is complete`,
          MacOSMessagesImportService.SERVICE_NAME
        );
      }

      // Open macOS Messages database
      const messagesDbPath = path.join(
        process.env.HOME!,
        "Library/Messages/chat.db"
      );

      logService.info(
        `Opening macOS Messages database`,
        MacOSMessagesImportService.SERVICE_NAME
      );

      // BACKLOG-2403: rejects instead of crashing the main process when chat.db
      // is missing or unreadable (Full Disk Access revoked mid-session, Messages
      // never used on this Mac). The outer catch turns it into { success: false }.
      const db = await openSqliteReadOnly(messagesDbPath, MacOSMessagesImportService.SERVICE_NAME);
      const dbAll = db.all;
      /**
       * BACKLOG-2775: closing the macOS Messages handle, at most once.
       *
       * `ReadOnlySqliteHandle.close` is `promisify(db.close.bind(db))` from
       * node-sqlite3, and a SECOND close REJECTS with
       * `SQLITE_MISUSE: Database is closed`. There are four close sites on this
       * path and they are not mutually exclusive: the normal flow closes as soon
       * as the last source query is done — before `storeMessages`, which is a
       * long way from the end of the function — so every later exit is closing a
       * handle that is already closed.
       *
       * The founder hit this live. He pressed Cancel ~1.2s into a force
       * re-import; the run rolled back correctly and the store was safe, but the
       * cancel exit's own `close()` rejected, the rejection replaced the
       * cancellation result, and he was shown a red
       * "Import failed: SQLITE_MISUSE: Database is closed" card instead of
       * "nothing changed".
       *
       * The same shape silently MASKED real errors before this feature existed:
       * anything thrown after the close reached the inner `catch`, which closes
       * again, so a genuine `storeMessages` failure surfaced as SQLITE_MISUSE
       * rather than as itself.
       *
       * No mocked suite can catch this — a `jest.fn()` close is idempotent by
       * construction — which is why the reproduction lives in
       * `macOSMessagesImportService.forceCancelRealDriver-2775.test.ts` against
       * the real driver.
       */
      let sourceDbClosed = false;
      const dbClose = async (): Promise<void> => {
        if (sourceDbClosed) return;
        sourceDbClosed = true;
        await db.close();
      };

      try {
        // BACKLOG-2772: the cutoff is READ from the plan, never recomputed here.
        // The arithmetic still lives in `computeImportCutoffNano` — the plan is
        // where its single result is carried. Recomputing it from a filter bag
        // at this depth is what let the import reach a different window than the
        // estimate that had just been shown for it (BACKLOG-2760).
        const appleDateCutoffNano: number | null = plan.cutoffNano;
        if (appleDateCutoffNano !== null) {
          logService.info(
            `Date filter: cutoff ${plan.fetchStartISO} (mode=${plan.mode}, ` +
              `overrides=${plan.overrides.map((o) => o.kind).join(",") || "none"})`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        // BACKLOG-2772: the window's SQL is compiled ONCE, by the same builder
        // the estimate uses, so the five queries that share these strings
        // cannot drift.
        const windowSql = buildMessageWindowSql(plan);
        const { dateFilterClause } = windowSql;

        // BACKLOG-2280: Reactions ARE imported now (stored + attached at render).
        // The counts and the SELECT must therefore cover the SAME scope, INCLUDING
        // reaction rows — the fetch loop runs `while (fetchedCount < totalMessageCount)`,
        // so if the counts excluded reactions but the SELECT included them (or vice
        // versa) the loop would terminate early and silently DROP the newest rows
        // (ORDER BY ROWID ASC). Reaction rows are band-ROUTED in storeMessages, not
        // filtered here.

        // First, get total message count (importable rows, unfiltered by date, for
        // "X of Y" display)
        const totalCountResult = await dbAll<{ count: number }>(`
          SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL
        `);
        const totalAvailableCount = totalCountResult[0]?.count || 0;

        // Get filtered count (with date filter applied)
        const filteredCountResult = await dbAll<{ count: number }>(`
          SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL ${dateFilterClause}
        `);
        const filteredMessageCount = filteredCountResult[0]?.count || 0;

        // ------------------------------------------------------------------
        // BACKLOG-2772 — Cap', resolved by the SAME function the estimate uses.
        // ------------------------------------------------------------------
        // The founder's final rule, 2026-08-20: "Maximum messages" applies only
        // OUTSIDE the audit periods of non-rejected deals; inside such a period
        // history is always complete and never counts against the cap.
        //
        // What it replaces was all-or-nothing —
        // `capApplies = !auditPeriodActive && ...` with `auditPeriodActive` true
        // whenever ANY non-rejected transaction existed — so a single pending
        // deal disabled the cap for the ENTIRE library. That is how clicking
        // "Re-import most recent 50,000 only" produced a run targeting 707,842
        // (BACKLOG-2749). The audit guarantee behind the exemption was right;
        // spending it on every unrelated message the user ever sent was not.
        //
        // The arithmetic lives in `resolveAdmittedMessageSet` so this run and
        // the selection-time estimate cannot describe different imports.
        const maxMessages = plan.effectiveCap;
        const admitted = await resolveAdmittedMessageSet(
          dbAll,
          plan,
          windowSql,
          filteredMessageCount
        );
        const {
          protectedCount,
          unprotectedCount,
          capWindowStartRowId,
          capWindowUnresolved,
          importWasCapped,
          targetMessageCount,
          capFetchClause,
        } = admitted;

        if (protectedCount > 0) {
          logService.info(
            `Cap' scope: ${protectedCount} messages inside audit periods are exempt ` +
              `(never counted, always complete); the cap of ${maxMessages ?? "none"} ` +
              `governs the remaining ${unprotectedCount}`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        if (capWindowUnresolved) {
          // ERROR, not warn: this is the silent-wrong-data class. The import
          // still completes and still contains everything the user asked for,
          // but the reason it ignored their cap has to be visible in a support
          // trace without anyone reasoning about ROWIDs.
          logService.error(
            `Cap of ${maxMessages} applies but the window-start ROWID could not be resolved — ` +
              `importing the FULL filtered window of ${filteredMessageCount} messages instead of ` +
              `${protectedCount} protected plus the newest ${maxMessages}. ` +
              `The cap is NOT applied; the newest messages are present.`,
            MacOSMessagesImportService.SERVICE_NAME,
            { filteredMessageCount, maxMessages, protectedCount, unprotectedCount }
          );
        } else if (capWindowStartRowId !== null) {
          logService.info(
            `Cap of ${maxMessages} applies to the unprotected remainder: starting at ROWID ` +
              `${capWindowStartRowId} to keep the NEWEST ${maxMessages}, plus ${protectedCount} protected`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        // Use filtered count for progress (or capped count)
        const totalMessageCount = targetMessageCount;

        // Calculate dynamic batch size based on total messages
        const queryBatchSize = calculateQueryBatchSize(totalMessageCount);

        logService.info(
          `Message counts: ${totalAvailableCount} total, ${filteredMessageCount} after date filter, ${targetMessageCount} target (cap: ${maxMessages ?? "none"})`,
          MacOSMessagesImportService.SERVICE_NAME
        );

        logService.info(
          `Found ${totalMessageCount} messages in macOS Messages, fetching in batches of ${queryBatchSize}`,
          MacOSMessagesImportService.SERVICE_NAME
        );

        // Report initial querying progress
        onProgress?.({
          phase: "querying",
          current: 0,
          total: totalMessageCount,
          percent: 0,
        });

        // Query actual chat members from chat_handle_join (small table, load all at once)
        // This gives us the real participant list for group chats
        const chatMemberRows = await dbAll<ChatMemberRow>(`
          SELECT
            chat_handle_join.chat_id,
            handle.id as handle_id
          FROM chat_handle_join
          JOIN handle ON chat_handle_join.handle_id = handle.ROWID
        `);

        // Build a map of chat_id -> array of member handles
        const chatMembersMap = new Map<number, string[]>();
        for (const row of chatMemberRows) {
          const members = chatMembersMap.get(row.chat_id) || [];
          members.push(row.handle_id);
          chatMembersMap.set(row.chat_id, members);
        }

        logService.info(
          `Loaded ${chatMembersMap.size} chat member lists`,
          MacOSMessagesImportService.SERVICE_NAME
        );

        await yieldToEventLoop();

        // Query chat account_login to get user's identifier (phone/Apple ID) for each chat
        // This tells us which of the user's identifiers they're using in each conversation
        const chatAccountRows = await dbAll<ChatAccountRow>(`
          SELECT
            ROWID as chat_id,
            account_login
          FROM chat
          WHERE account_login IS NOT NULL
        `);

        // Build a map of chat_id -> user's account_login (phone number or email)
        // account_login has prefixes: "P:" for phone, "E:" for email - strip them
        const chatAccountMap = new Map<number, string>();
        for (const row of chatAccountRows) {
          if (row.account_login) {
            // Strip "P:" or "E:" prefix from account_login
            let identifier = row.account_login;
            if (identifier.startsWith("P:") || identifier.startsWith("E:")) {
              identifier = identifier.substring(2);
            }
            if (identifier) {
              chatAccountMap.set(row.chat_id, identifier);
            }
          }
        }

        logService.info(
          `Loaded ${chatAccountMap.size} chat account mappings`,
          MacOSMessagesImportService.SERVICE_NAME
        );

        await yieldToEventLoop();

        // Fetch messages using cursor-based pagination to avoid loading all 600K+ at once
        // This prevents the UI from freezing during the initial query
        const allMessages: RawMacMessage[] = [];
        // BACKLOG-2772: the walk ALWAYS starts at 0 now. Under Cap' the kept set
        // is no longer a contiguous ROWID tail — protected messages can be
        // arbitrarily old — so the cap is carried by `capFetchClause` in the
        // WHERE below instead of by seeding this cursor. Seeding it here as
        // well would skip every protected row older than the cap window.
        let lastRowId = 0;
        let fetchedCount = 0;

        const queryProgressBar = createProgressBar("Querying");
        queryProgressBar.start(totalMessageCount, 0);

        while (fetchedCount < totalMessageCount) {
          // Check for cancellation (legacy flag and AbortSignal)
          if (this.abortController?.signal.aborted) {
            queryProgressBar.stop();
            logService.warn(
              `Import cancelled during query phase at ${fetchedCount}/${totalMessageCount}`,
              MacOSMessagesImportService.SERVICE_NAME
            );
            await dbClose();
            return {
              success: false,
              messagesImported: 0,
              messagesSkipped: 0,
              attachmentsImported: 0,
              attachmentsUpdated: 0,
              attachmentsSkipped: 0,
              duration: Date.now() - startTime,
              error: "Import cancelled",
              // BACKLOG-2775: this is the exact return the founder's run took —
              // cancel honoured at the first check after the clear, 0 imported.
              // BACKLOG-2790: and it still reports `rolledBack`, because that is
              // what the flag has always MEANT to the UI — "this force run
              // changed nothing" — even though there is no longer a rollback
              // behind it. Nothing was deleted to restore; the store was never
              // altered in the first place.
              rolledBack: nothingChangedYet(),
              // BACKLOG-2748: the discriminator, not the message text. Consumers
              // must not have to string-match "Import cancelled" to tell a user
              // cancel apart from a real failure — the orchestrator checks this
              // flag BEFORE it turns a non-success result into a thrown error.
              cancelled: true,
            };
          }

          // TASK-1952: Calculate remaining messages to fetch (respect count cap)
          const remaining = totalMessageCount - fetchedCount;
          const batchLimit = Math.min(queryBatchSize, remaining);

          // Fetch next batch using cursor-based pagination (ROWID for efficient indexing)
          // TASK-1952: Added date filter clause when lookback filter is active
          const messageBatch = await dbAll<RawMacMessage>(`
            SELECT
              message.ROWID as id,
              message.guid,
              message.text,
              message.attributedBody,
              message.date,
              message.is_from_me,
              handle.id as handle_id,
              message.service,
              chat_message_join.chat_id,
              message.cache_has_attachments,
              message.associated_message_type,
              message.associated_message_guid
            FROM message
            LEFT JOIN handle ON message.handle_id = handle.ROWID
            LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
            WHERE message.guid IS NOT NULL AND message.ROWID > ?
              ${dateFilterClause}
              ${capFetchClause}
            ORDER BY message.ROWID ASC
            LIMIT ?
          `, [lastRowId, batchLimit]);

          if (messageBatch.length === 0) {
            break; // No more messages
          }

          // Use concat instead of spread to avoid stack overflow with large batches
          // The spread operator (...) puts all elements on the call stack, which fails for 100K+ items
          for (let i = 0; i < messageBatch.length; i++) {
            allMessages.push(messageBatch[i]);
          }
          lastRowId = messageBatch[messageBatch.length - 1].id;
          fetchedCount += messageBatch.length;

          // Update progress
          const progressTotal = totalMessageCount;
          queryProgressBar.update(Math.min(fetchedCount, progressTotal));
          onProgress?.({
            phase: "querying",
            current: Math.min(fetchedCount, progressTotal),
            total: progressTotal,
            percent: Math.round((Math.min(fetchedCount, progressTotal) / progressTotal) * 100),
          });

          // Yield to event loop to keep UI responsive
          await yieldToEventLoop();
        }

        queryProgressBar.stop();

        // Query attachments linked to messages (TASK-1012)
        // We join through message_attachment_join to get the message relationship
        //
        // BACKLOG-2743: When the user chose "import without attachments" (the
        // escape hatch offered when the attachment estimate exceeds free disk
        // space), skip the query entirely — no rows fetched, no files copied,
        // and the message text still imports.
        const attachments = !plan.fetchAttachments
          ? []
          : await dbAll<RawMacAttachment>(`
          SELECT
            attachment.ROWID as attachment_id,
            message.ROWID as message_id,
            message.guid as message_guid,
            attachment.guid,
            attachment.filename,
            attachment.mime_type,
            attachment.transfer_name,
            attachment.total_bytes,
            attachment.is_outgoing
          FROM attachment
          JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
          JOIN message ON message.ROWID = message_attachment_join.message_id
          WHERE message.guid IS NOT NULL
            AND attachment.filename IS NOT NULL
        `);

        await dbClose();

        logService.info(
          `Fetched ${allMessages.length} messages and ${attachments.length} attachments in macOS Messages`,
          MacOSMessagesImportService.SERVICE_NAME
        );

        // Store messages to app database
        const messageResult = await this.storeMessages(userId, allMessages, chatMembersMap, chatAccountMap, onProgress, staging);

        // Store attachments (TASK-1012)
        const attachmentResult = await this.storeAttachments(userId, attachments, messageResult.messageIdMap, onProgress, staging);

        const duration = Date.now() - startTime;

        // TASK-1050: Enhanced summary logging with thread_id validation stats
        // TASK-1122: Include attachments updated count for re-sync scenarios
        logService.info(
          "Import summary",
          MacOSMessagesImportService.SERVICE_NAME,
          {
            totalMessages: messageResult.stored + messageResult.skipped + messageResult.retagged,
            imported: messageResult.stored,
            skipped: messageResult.skipped,
            // BACKLOG-2302: historical reactions self-healed to pills in place.
            retagged: messageResult.retagged,
            nullThreadIdCount: messageResult.nullThreadIdCount,
            attachmentsImported: attachmentResult.stored,
            attachmentsUpdated: attachmentResult.updated,
            attachmentsSkipped: attachmentResult.skipped,
            duration,
          }
        );

        // BACKLOG-2393: the message-import funnel, in -> out with the reason for
        // every difference. "I can see the text on my phone but not in Keepr" is
        // unanswerable without knowing whether it was never read, filtered by the
        // date cutoff, cut by the cap, or read and then skipped on write. A no-op
        // outside a granted support window.
        supportTrace("message-import", "macos-import-complete", {
          chats_enumerated: chatMembersMap.size,
          accounts_enumerated: chatAccountMap.size,
          available_before_filters: totalAvailableCount,
          after_date_cutoff: filteredMessageCount,
          dropped_by_date_cutoff: totalAvailableCount - filteredMessageCount,
          target_after_cap: targetMessageCount,
          dropped_by_cap: Math.max(0, filteredMessageCount - targetMessageCount),
          cap_applied: importWasCapped,
          // BACKLOG-2744: which end of the archive the cap kept. "I can see the
          // text on my phone but not in Keepr" needs to distinguish "older than
          // the cap window" from "never read".
          cap_window_start_rowid: capWindowStartRowId,
          // Separates "no cap was in play" from "the cap was abandoned because its
          // window start could not be resolved" — both leave the ROWID above null.
          cap_window_unresolved: capWindowUnresolved,
          max_messages: maxMessages,
          // BACKLOG-2772: Cap' replaced the all-or-nothing `audit_period_active`
          // flag. The question a support trace now has to answer is not "was the
          // cap switched off?" but "how much of this window did the cap not
          // govern?" — these two numbers, which always sum to `after_date_cutoff`.
          protected_by_audit_periods: protectedCount,
          cap_governed_remainder: unprotectedCount,
          protected_span_count: plan.protectedSpans.length,
          plan_mode: plan.mode,
          plan_overrides: plan.overrides.map((o) => o.kind),
          read_from_source: allMessages.length,
          stored: messageResult.stored,
          skipped_on_write: messageResult.skipped,
          retagged: messageResult.retagged,
          null_thread_id: messageResult.nullThreadIdCount,
          attachments_found: attachments.length,
          attachments_stored: attachmentResult.stored,
          attachments_updated: attachmentResult.updated,
          attachments_skipped: attachmentResult.skipped,
          force_reimport: forceReimport,
          duration_ms: duration,
        });

        // Log warning if significant NULL thread_id count
        if (messageResult.nullThreadIdCount > 0) {
          const percentNull = ((messageResult.nullThreadIdCount / (messageResult.stored + messageResult.skipped + messageResult.retagged)) * 100).toFixed(2);
          logService.warn(
            `Import found ${messageResult.nullThreadIdCount} messages with NULL thread_id (${percentNull}% of total)`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        // BACKLOG-2775 / BACKLOG-2790: the force path's decision point, at the
        // same place it has always been. A cancel that landed after the query
        // phase leaves the message and attachment loops via `break`, arriving
        // here with partial counts — which a DELTA import keeps and a FORCE
        // re-import must not, because a partial rebuild is not a re-import of
        // anything. Returning here means the swap below never runs, so the store
        // the user already had simply stays where it is.
        if (staging && this.abortController?.signal.aborted) {
          logService.warn(
            `Force reimport cancelled after staging ${messageResult.stored} messages — the message store was never touched`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          await dbClose();
          return this.cancelledUnchangedResult(startTime);
        }

        // Send final 100% progress to update UI
        onProgress?.({
          phase: "importing",
          current: allMessages.length,
          total: allMessages.length,
          percent: 100,
        });

        // BACKLOG-2790: THE SWAP. The rebuild is complete, so it is finally
        // allowed to become the user's message store — in one short transaction
        // that deletes the force set and inserts the staged rows in its place.
        //
        // Until this line runs, every exit path leaves the store exactly as the
        // user had it, because nothing has been deleted. That is the same
        // guarantee the old COMMIT provided, arrived at from the other
        // direction: BACKLOG-2775 destroyed first and restored on failure, this
        // builds first and destroys only on success.
        //
        // What that reversal buys is stated at `swapStagingIntoLive`, boundary
        // included: the transaction is now one synchronous callback with no
        // `await` inside it, so no write OUTSIDE the force set can join it and be
        // lost. That covers every writer the quiesce existed for — both sync
        // timers, event-driven `insertAuditLog`, and submissionSyncService's
        // realtime subscription — none of which touch this user's macOS message
        // rows. A write INSIDE the force set is deleted by the swap on the
        // success path, but BACKLOG-2796 scoped that set to the rows chat.db can
        // rebuild, so the Android companion's SMS, the iPhone sync's messages
        // and `channel = 'email'` rows are no longer in it and are no longer
        // deleted. See the boundary note at `swapStagingIntoLive`.
        if (staging && appDb) {
          const swapCounts = swapStagingIntoLive(appDb, staging);
          forceSwapCommitted = true;
          logService.info(
            `Force reimport swap complete: replaced ${swapCounts.messagesDeleted} messages ` +
              `and ${swapCounts.attachmentsDeleted} attachments with ${swapCounts.messagesInserted} ` +
              `and ${swapCounts.attachmentsInserted}`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          // BACKLOG-2796: normally zero. Non-zero means a foreign write (only
          // iPhone sync shares chat.db's GUID space) landed between this run's
          // dedup read and the swap, and the staged copy stood down for the row
          // already in the store. Logged because a skip nobody can see is
          // indistinguishable from a bug.
          if (swapCounts.messagesYieldedToSurvivors > 0) {
            logService.warn(
              `Force reimport yielded ${swapCounts.messagesYieldedToSurvivors} staged message(s) ` +
                `and ${swapCounts.attachmentsYieldedToSurvivors} staged attachment(s) to rows that ` +
                `arrived from another source mid-run`,
              MacOSMessagesImportService.SERVICE_NAME
            );
          }
        }

        return {
          success: true,
          messagesImported: messageResult.stored,
          messagesSkipped: messageResult.skipped,
          attachmentsImported: attachmentResult.stored,
          attachmentsUpdated: attachmentResult.updated,
          attachmentsSkipped: attachmentResult.skipped,
          duration,
          totalAvailable: filteredMessageCount,
          wasCapped: importWasCapped,
          // BACKLOG-2794: what the window COVERS, beside what the run FETCHED.
          //
          // The same `targetMessageCount` the support trace above reports as
          // `target_after_cap`, and the same one `getAvailableMessageCount`
          // returns to Settings as `filteredCount` — one arithmetic, so the
          // dashboard and the panel cannot quote different admitted counts.
          // Consumers subtract THIS from `totalAvailable` to say what the limit
          // left out; subtracting `messagesImported` counts messages the store
          // already had as excluded (`a14b3a82`).
          coveredCount: targetMessageCount,
          // BACKLOG-2743: success stays TRUE here on purpose. By the time the
          // attachment pre-flight runs the messages are already stored, so a
          // false would render "Import failed" over a genuinely successful
          // message import. The refusal is reported as its own fact.
          attachmentsRefusedForSpace: attachmentResult.refusedForSpace,
          attachmentsSkippedByChoice: !plan.fetchAttachments || undefined,
          // BACKLOG-2748: a cancel that lands after the query phase leaves this
          // path — the message batch loop and the attachment loop both `break`,
          // and everything already written is kept. `success` stays TRUE (the
          // stored messages ARE imported) but the counts are partial, so the
          // outcome must say so or the UI reports a stopped import as a clean
          // finish. The controller is still live here; `importMessages` nulls it
          // in its `finally`, after this return.
          cancelled: this.abortController?.signal.aborted || undefined,
        };
      } catch (error) {
        await dbClose();
        throw error;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logService.error(
        `Import failed: ${errorMessage}`,
        MacOSMessagesImportService.SERVICE_NAME,
        { duration }
      );

      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration,
        error: errorMessage,
        // BACKLOG-2775 / BACKLOG-2790: a force run that threw before its swap
        // changed nothing, so the failure card must not leave the user believing
        // their messages are gone. A throw from INSIDE the swap lands here too,
        // and the answer is the same: that transaction rolled back whole, so the
        // store is the one they started with.
        rolledBack: nothingChangedYet(),
      };
    } finally {
      /**
       * BACKLOG-2790: the sole cleanup, and it cleans up scratch space rather
       * than repairing the user's data.
       *
       * This is where the old design did its real work — one ROLLBACK, reached
       * by every exit that had not committed, undoing a deletion that had
       * already happened. Three variables existed to get that right
       * (`forceTxnOpen`, `forceTxnBegun`, `forceRollbackDeclared`), and a
       * structural guard threw if a future `return` slipped past them, because a
       * result claiming success over a rolled-back store would have been a
       * silently emptied message cache.
       *
       * None of it is needed now. A force run that does not reach its swap has
       * not touched `messages` or `attachments` at all, so there is nothing to
       * undo and nothing a new `return` could get wrong: the worst a future edit
       * can do on this path is leak a staging table, which the next run sweeps.
       * Dropping is best-effort for that reason — a failure here costs disk
       * space, never data.
       */
      if (staging) {
        try {
          staging.drop();
        } catch (dropError) {
          // Not fatal, and deliberately not escalated: the tables are inert, the
          // next force run reclaims them, and BACKLOG-2768 reclaims them for a
          // user who never runs one. Throwing from a `finally` would replace a
          // real result with a housekeeping error.
          logService.warn(
            `Could not drop the force re-import staging tables (they will be reclaimed by the next run): ${
              dropError instanceof Error ? dropError.message : "Unknown error"
            }`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }
      }
    }
  }

  /**
   * BACKLOG-2775 / BACKLOG-2790: the outcome of a force re-import that was
   * stopped before its swap — every count 0, because the store IS exactly what
   * it was before the run.
   *
   * `rolledBack: true` is kept verbatim, and it is the right word for what the
   * user is told: "Re-import cancelled. Nothing changed — your existing messages
   * are untouched." Under BACKLOG-2775 that sentence was true because a
   * transaction had just undone a deletion; under stage-and-swap it is true
   * because no deletion ever happened. The user-visible claim is identical, and
   * it is now the cheaper of the two to keep honest.
   */
  private cancelledUnchangedResult(startTime: number): MacOSImportResult {
    return {
      success: false,
      messagesImported: 0,
      messagesSkipped: 0,
      attachmentsImported: 0,
      attachmentsUpdated: 0,
      attachmentsSkipped: 0,
      duration: Date.now() - startTime,
      error: "Import cancelled",
      cancelled: true,
      rolledBack: true,
    };
  }

  /**
   * Store messages to the app database with deduplication
   * Returns a map of macOS message GUID -> internal message ID for attachment linking
   */
  private async storeMessages(
    userId: string,
    messages: RawMacMessage[],
    chatMembersMap: Map<number, string[]>,
    chatAccountMap: Map<number, string>,
    onProgress?: ImportProgressCallback,
    /**
     * BACKLOG-2790: non-null on a force re-import — writes go to the staging
     * table instead of to `messages`, and the dedup read is scoped to it.
     */
    staging?: ForceStaging | null
  ): Promise<{ stored: number; skipped: number; retagged: number; nullThreadIdCount: number; messageIdMap: Map<string, string> }> {
    // Map of macOS message GUID -> internal message ID (TASK-1012)
    const messageIdMap = new Map<string, string>();

    if (messages.length === 0) {
      return { stored: 0, skipped: 0, retagged: 0, nullThreadIdCount: 0, messageIdMap };
    }

    let stored = 0;
    let skipped = 0;
    // BACKLOG-2302: rows re-tagged in place (historical reactions self-healed to
    // pills) — counted separately from stored (not new) and skipped (not inert).
    let retagged = 0;
    let nullThreadIdCount = 0;

    // Get database instance
    const db = databaseService.getRawDatabase();

    // Load existing external_ids for deduplication (O(1) lookup)
    logService.info(
      `Loading existing message IDs for deduplication...`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // On a force re-import this must see what the live table WILL look like once
    // the swap has run: the rows that survive it, plus whatever this run has
    // staged so far. `forceReadView` is that union — the same one
    // `storeAttachments` reads through.
    //
    // BACKLOG-2790 read STAGING ALONE here, and justified it: the rows this
    // query looks for "are precisely the rows the swap will delete", so a live
    // read would have returned nothing but this run's own writes anyway. That
    // was true of an UNSCOPED force set. BACKLOG-2796 scoped it, and the
    // justification died with the scope — survivors now exist inside the space
    // this query searches.
    //
    // It is not a cosmetic difference. iPhone-synced rows carry Apple GUIDs in
    // `external_id`, the SAME id space chat.db draws from
    // (`iPhoneSyncStorageService` stores `externalId: msg.guid`). Read staging
    // alone and the rebuild happily stages a GUID a surviving row still holds.
    //
    // WHAT THAT COSTS, at the strength it was measured — two steps, because the
    // damage depends on what else is in place. With `insertFromStaging`'s yield
    // filter present (it is), the swap stands the duplicate down and the store
    // still ends up correct: the cost is a rebuild that extracts text and copies
    // attachments for messages it will discard, and a log line reporting them as
    // having "arrived from another source mid-run" when they had been in the
    // store all along. Take the yield filter away too — the shape of this code
    // before BACKLOG-2796 — and the swap's plain INSERT hits
    // `idx_messages_user_external_id` (UNIQUE on `(user_id, external_id)`), rolls
    // back, and the whole force re-import fails for exactly the users who have
    // both an iPhone sync and a Mac.
    //
    // Both steps are pinned by `macOSMessagesImportService.forceSetScope-2796`,
    // which asserts the yield COUNT and not only the resulting rows — the two
    // designs leave an identical table behind, so rows alone cannot tell them
    // apart.
    //
    // `user_id` is carried through the union and filtered OUTSIDE it, not left
    // to `SURVIVING_MESSAGES`: that predicate is "not in the force set", which
    // is true of every other user's rows as well. Deduplicating against a
    // stranger's GUID would make the rebuild skip a message THIS user has, so
    // the user filter has to survive the rewrite. Naming both columns in the
    // view is what lets the outer WHERE keep applying it.
    //
    // Named binding on both paths, not positional: the survivor half of the
    // union is built from `SURVIVING_MESSAGES`, which spells the user as
    // `@userId`, and better-sqlite3 will not mix `?` with `@name` in one
    // statement. The delta path's answer is unchanged — same predicate, same
    // rows, one spelling of the query instead of two.
    const messagesTable = staging ? `"${staging.messagesTable}"` : "messages";
    const existingIdsSource = staging
      ? forceReadView(
          "messages",
          staging.messagesTable,
          SURVIVING_MESSAGES,
          "external_id, user_id"
        )
      : "messages";
    const existingIds = new Set<string>();
    const existingRows = db
      .prepare(
        `
      SELECT external_id FROM ${existingIdsSource}
      WHERE user_id = @userId AND external_id IS NOT NULL
    `
      )
      .all({ userId }) as { external_id: string }[];

    for (const row of existingRows) {
      existingIds.add(row.external_id);
    }

    logService.info(
      `Found ${existingIds.size} existing messages`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // Prepare insert statement for messages table only
    // Note: We no longer need to insert into communications table - that's only for
    // messages that are linked to transactions. The UI now queries messages directly.
    // TASK-1799: Added message_type for UI differentiation of voice messages, location, etc.
    const insertMessageStmt = db.prepare(`
      INSERT OR IGNORE INTO ${messagesTable} (
        id, user_id, channel, external_id, direction,
        body_text, participants, participants_flat, thread_id, sent_at,
        has_attachments, message_type, metadata,
        associated_message_type, associated_message_guid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    // BACKLOG-2302: Self-heal statement for historical reactions. Reactions
    // imported before BACKLOG-2280 were stored as ordinary text rows (Apple
    // summary text "Loved/Laughed at …", associated_message_type NULL). GUID
    // dedup skips already-stored rows, so a normal re-import never back-fills the
    // reaction columns and they keep rendering as plain bubbles. When the chat.db
    // row is a reaction we UPDATE the existing row IN PLACE with the exact same
    // columns the fresh-import path writes below (associated_message_type +
    // normalized associated_message_guid, message_type NULL, empty body_text) so
    // it partitions to a pill on the next render — WITHOUT a destructive force
    // reimport (force reimport cascade-deletes conversation attachments via
    // communications.message_id ON DELETE CASCADE). The
    // `associated_message_type IS NULL` guard makes this idempotent: once a row is
    // tagged, subsequent imports re-tag nothing and never touch fresh reactions.
    const retagReactionStmt = db.prepare(`
      UPDATE ${messagesTable}
      SET associated_message_type = ?,
          associated_message_guid = ?,
          message_type = NULL,
          body_text = ''
      WHERE user_id = ?
        AND external_id = ?
        AND associated_message_type IS NULL
    `);

    // Process in batches
    const totalBatches = Math.ceil(messages.length / BATCH_SIZE);

    logService.info(
      `Processing ${messages.length} messages in ${totalBatches} batches`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // Create progress bar for console output
    const msgProgressBar = createProgressBar("Messages");
    msgProgressBar.start(messages.length, 0);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      // Check for cancellation at start of each batch (legacy flag and AbortSignal)
      // BACKLOG-2748: pinned by `macOSMessagesImportService.cancel-2748.test.ts`
      // — cancelling on the first progress event must leave exactly the first
      // BATCH_SIZE messages stored, not the whole corpus.
      if (this.abortController?.signal.aborted) {
        msgProgressBar.stop();
        logService.warn(
          `Import cancelled at batch ${batchNum}/${totalBatches}`,
          MacOSMessagesImportService.SERVICE_NAME
        );
        break;
      }

      const start = batchNum * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, messages.length);
      const batch = messages.slice(start, end);

      // Pre-process: Extract text from attributedBody for all messages in batch
      // This must be done BEFORE the transaction since getMessageText is async
      // TASK-PERF: Wrap each message parsing in try-catch to prevent stack overflow
      // from a single malformed message killing the entire import
      // TASK-2047: Yield to event loop every TEXT_EXTRACTION_YIELD_INTERVAL messages
      // to prevent UI freezes during text extraction of large batches
      const messageTexts = new Map<string, string>();
      let extractionCount = 0;
      for (const msg of batch) {
        if (msg.guid && isValidGuid(msg.guid) && !existingIds.has(msg.guid)) {
          try {
            const text = await getMessageText({
              text: msg.text,
              attributedBody: msg.attributedBody,
              cache_has_attachments: msg.cache_has_attachments,
            });
            messageTexts.set(msg.guid, text);
          } catch (parseError) {
            // Log but don't fail the entire import for one malformed message
            // This catches stack overflow errors from malformed plist/typedstream data
            logService.warn(
              `Failed to parse message text, using fallback`,
              MacOSMessagesImportService.SERVICE_NAME,
              {
                guid: msg.guid,
                error: parseError instanceof Error ? parseError.message : "Unknown error",
                hasAttributedBody: !!msg.attributedBody,
                attributedBodyLength: msg.attributedBody?.length ?? 0,
              }
            );
            // BACKLOG-2262: Use empty string (NOT a "[placeholder]") on parse failure.
            // The retention filter keys on real emptiness + attachment presence, so a
            // parse failure no longer drops a message that carries an attachment.
            messageTexts.set(msg.guid, "");
          }

          // TASK-2047: Yield to event loop periodically during text extraction
          // to prevent UI freeze when processing batches with many messages
          extractionCount++;
          if (extractionCount % TEXT_EXTRACTION_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
          }
        }
      }

      // Use a transaction for each batch (synchronous)
      const insertBatch = db.transaction((msgs: RawMacMessage[]) => {
        for (const msg of msgs) {
          // Validate GUID
          if (!isValidGuid(msg.guid)) {
            skipped++;
            continue;
          }

          // Check for duplicate using Set (O(1))
          if (existingIds.has(msg.guid)) {
            // BACKLOG-2302: Before treating an already-stored GUID as an inert
            // skip, self-heal historical reactions. If the chat.db row is a
            // tapback (associated_message_type in 2000–3005) but the stored row
            // was imported pre-2280 as a plain text bubble (associated_message_type
            // NULL), re-tag it IN PLACE so it becomes a pill on the next render —
            // no destructive force reimport required. The statement's
            // `associated_message_type IS NULL` guard makes this idempotent and
            // leaves normal messages / already-tagged reactions untouched.
            if (isReactionAssociationType(msg.associated_message_type)) {
              const retagResult = retagReactionStmt.run(
                msg.associated_message_type,
                normalizeAssociatedGuid(msg.associated_message_guid),
                userId,
                msg.guid
              );
              if (retagResult.changes > 0) {
                retagged++;
                continue;
              }
            }
            skipped++;
            continue;
          }

          // Get pre-computed message text
          const messageText = messageTexts.get(msg.guid) || "";

          // BACKLOG-2280: Is this a tapback/reaction row? Reactions decode to
          // empty text and carry no attachment, so they must BYPASS the retention
          // filter below (which would otherwise re-drop them). They are stored as
          // ordinary messages rows tagged with associated_message_type/guid and
          // attached to their parent at render time.
          const isReaction = isReactionAssociationType(msg.associated_message_type);

          // BACKLOG-2262: Retain a message when it has real text OR carries an
          // attachment. Only drop when there is genuinely no content AND no
          // attachment. Previously this dropped any message whose decoded text
          // started with "[", which discarded caption-less media (orphaning the
          // attachment, since linking is gated on the parent message being stored)
          // and legitimate messages like "[link]". Reactions bypass this check.
          if (!isReaction && !shouldRetainMessageContent(messageText, msg.cache_has_attachments)) {
            skipped++;
            continue;
          }

          // Determine channel
          const channel = msg.service === "iMessage" ? "imessage" : "sms";

          // Determine direction
          const direction = msg.is_from_me === 1 ? "outbound" : "inbound";

          // Build thread ID from chat
          const threadId = msg.chat_id ? `macos-chat-${msg.chat_id}` : null;

          // TASK-1050: Track messages with NULL thread_id (count only, summary at end)
          if (!threadId) {
            nullThreadIdCount++;
          }

          // Convert Mac timestamp to ISO date
          const sentAt = macTimestampToDate(msg.date);

          // Sanitize handle
          const sanitizedHandle = sanitizeString(
            msg.handle_id,
            MAX_HANDLE_LENGTH,
            "unknown"
          );

          // Get actual chat members for this chat (for group chats)
          const chatMembers = msg.chat_id ? chatMembersMap.get(msg.chat_id) : undefined;

          // Get user's identifier for this chat (phone number or Apple ID like "janesmith")
          // This is what the user actually appears as in the conversation
          const userAccountLogin = msg.chat_id ? chatAccountMap.get(msg.chat_id) : undefined;

          // Build participants JSON with actual chat members
          // For outbound messages, use the user's actual identifier instead of "me"
          const participantsObj = {
            from: msg.is_from_me === 1 ? (userAccountLogin || "me") : sanitizedHandle,
            to: msg.is_from_me === 1 ? [sanitizedHandle] : [(userAccountLogin || "me")],
            // Include actual chat members for group chats (more than 1 member)
            ...(chatMembers && chatMembers.length > 1 ? { chat_members: chatMembers } : {}),
          };
          const participants = JSON.stringify(participantsObj);

          // Build participants_flat for fast phone number search
          // Include from, to, and all chat_members (for group chats)
          const allParticipantPhones: string[] = [];
          if (participantsObj.from && participantsObj.from !== "me") {
            allParticipantPhones.push(participantsObj.from.replace(/\D/g, ""));
          }
          for (const toPhone of participantsObj.to) {
            if (toPhone !== "me") {
              allParticipantPhones.push(toPhone.replace(/\D/g, ""));
            }
          }
          if (chatMembers) {
            for (const member of chatMembers) {
              allParticipantPhones.push(member.replace(/\D/g, ""));
            }
          }
          const participantsFlat = allParticipantPhones.join(",");

          // Sanitize message text
          const sanitizedText = sanitizeString(
            messageText,
            MAX_MESSAGE_TEXT_LENGTH,
            ""
          );

          // Build metadata
          const metadata = JSON.stringify({
            source: "macos_messages",
            originalId: msg.id,
            service: msg.service,
          });

          // TASK-1799: Detect message type for UI differentiation
          // Note: For macOS, we don't have audioTranscript yet (TASK-1798), so rely on attachment MIME type
          // and text patterns for detection
          // BACKLOG-2280: Reactions carry no display type — message_type stays NULL
          // so they are never rendered as a normal bubble (they attach as pills).
          const messageType = isReaction
            ? null
            : detectMessageType({
                text: sanitizedText,
                hasAudioTranscript: false, // macOS doesn't extract transcripts yet
                attachmentMimeType: null, // Attachment MIME type not available at this stage
                attachmentCount: msg.cache_has_attachments,
              });

          // BACKLOG-2280: For reactions, capture the raw association type and the
          // NORMALIZED target guid so the row can be partitioned to its parent at
          // render time. Non-reaction rows store NULL for both columns.
          const associatedMessageType = isReaction ? msg.associated_message_type : null;
          const associatedMessageGuid = isReaction
            ? normalizeAssociatedGuid(msg.associated_message_guid)
            : null;

          try {
            // Generate ID for message
            const messageId = crypto.randomUUID();

            // Insert into messages table only
            const insertResult = insertMessageStmt.run(
              messageId, // id
              userId, // user_id
              channel, // channel
              msg.guid, // external_id (for deduplication)
              direction, // direction
              sanitizedText, // body_text
              participants, // participants JSON
              participantsFlat, // participants_flat for search
              threadId, // thread_id
              sentAt.toISOString(), // sent_at
              msg.cache_has_attachments > 0 ? 1 : 0, // has_attachments
              messageType, // message_type (TASK-1799)
              metadata, // metadata
              associatedMessageType, // associated_message_type (BACKLOG-2280)
              associatedMessageGuid // associated_message_guid (BACKLOG-2280)
            );

            stored++;
            // Add to set to catch duplicates within same batch
            existingIds.add(msg.guid);

            // Track GUID -> internal ID mapping for attachment linking (TASK-1012)
            //
            // BACKLOG-2790: only when the row was actually written. The
            // statement is `INSERT OR IGNORE`, so a row that loses to the unique
            // index is skipped WITHOUT throwing, and mapping the guid to an id
            // that exists nowhere used to be harmless only because the
            // attachment loop then hit a foreign-key error and counted the
            // attachment as skipped. Under stage-and-swap the staging table has
            // no foreign keys — they are enforced against the real final state
            // when the swap inserts into live — so that phantom id would survive
            // the rebuild and fail the SWAP instead, turning a skipped
            // attachment into a failed re-import. Leaving the guid unmapped
            // reaches the same outcome by the same route the code already has:
            // the attachment finds no message id and is skipped.
            if (insertResult.changes > 0) {
              messageIdMap.set(msg.guid, messageId);
            }
          } catch (insertError) {
            const errMsg =
              insertError instanceof Error
                ? insertError.message
                : "Unknown error";
            if (!errMsg.includes("UNIQUE constraint")) {
              logService.warn(
                `Failed to insert message`,
                MacOSMessagesImportService.SERVICE_NAME,
                { guid: msg.guid, error: errMsg }
              );
            }
            skipped++;
          }
        }
      });

      // Execute batch
      insertBatch(batch);

      // Update progress bar
      msgProgressBar.update(end);

      // TASK-2047: Report progress to UI more frequently for responsive feedback
      // Changed from every 100 batches to every PROGRESS_REPORT_INTERVAL batches
      if (batchNum % PROGRESS_REPORT_INTERVAL === 0 || batchNum === totalBatches - 1) {
        onProgress?.({
          phase: "importing",
          current: end,
          total: messages.length,
          percent: Math.round((end / messages.length) * 100),
        });
      }

      // Yield to event loop every N batches
      if ((batchNum + 1) % YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    // Stop progress bar
    msgProgressBar.stop();

    return { stored, skipped, retagged, nullThreadIdCount, messageIdMap };
  }

  /**
   * Store attachments to the app database and file system (TASK-1012)
   * Copies supported image files to app data directory with deduplication
   * Uses async operations to avoid blocking the main thread
   */
  private async storeAttachments(
    userId: string,
    attachments: RawMacAttachment[],
    messageIdMap: Map<string, string>,
    onProgress?: ImportProgressCallback,
    /** BACKLOG-2790: non-null on a force re-import — see `forceStaging.ts`. */
    staging?: ForceStaging | null
  ): Promise<{
    stored: number;
    skipped: number;
    updated: number;
    refusedForSpace?: AttachmentsRefusedForSpace;
  }> {
    if (attachments.length === 0) {
      return { stored: 0, skipped: 0, updated: 0 };
    }

    let stored = 0;
    let skipped = 0;
    let updated = 0;

    // Get database instance
    const db = databaseService.getRawDatabase();

    /**
     * BACKLOG-2790: where this method reads and writes on a force re-import.
     *
     * Writes go to staging. Reads must see what the LIVE table would have shown
     * at this same point under the old design — which cleared live first, so
     * every read returned "the rows the clear did not touch, plus the rows this
     * run has written". `forceReadView` is that union, and the survivor half is
     * not optional: email attachments survive the clear, and dropping them out
     * of the content-hash set would make a force re-import re-copy files it
     * already has.
     *
     * `@userId` is the only bound parameter these views need, and it is the run's
     * own user — so a read is bound with it in force mode and with nothing in
     * delta mode, where the query is the original unscoped one.
     */
    const attachmentsTable = staging ? `"${staging.attachmentsTable}"` : "attachments";
    const attachmentsRead = staging
      ? (columns: string) =>
          forceReadView("attachments", staging.attachmentsTable, SURVIVING_ATTACHMENTS, columns)
      : () => "attachments";
    const messagesRead = staging
      ? (columns: string) =>
          forceReadView("messages", staging.messagesTable, SURVIVING_MESSAGES, columns)
      : () => "messages";
    const readParams = staging ? [{ userId }] : [];

    // BACKLOG-2743: PRE-FLIGHT FREE-SPACE CHECK.
    //
    // This runs BEFORE the attachments directory is created and before the copy
    // loop is entered, so a library that does not fit fails having written
    // nothing — rather than filling the volume and failing midway with a
    // half-copied set. The selection-time estimate can be minutes stale by the
    // time an import actually starts, which is why the authority is here and not
    // in the renderer.
    //
    // The set sized here must be the set the copy loop would WRITE, which means
    // subtracting on BOTH axes the loop skips on. This method is handed the
    // user's ENTIRE attachment history on every sync (the import's attachment
    // SELECT is unbounded), so the raw set overstates the copy twice over:
    //
    //   1. ALREADY STORED — re-sync hands over everything imported previously.
    //      Summing those would mean that once a large library HAD imported and
    //      consumed the space it needed, every later sync re-summed the whole
    //      history against the now-smaller free space and refused forever.
    //
    //   2. UNRESOLVABLE — attachments whose message falls outside the selected
    //      window was never imported, so the loop finds no message ID and skips
    //      them (see the `internalMessageId` resolution below). Summing those
    //      breaks the refusal's own advice: the renderer's estimate IS
    //      date-bounded, so narrowing the window re-enables Import, and an
    //      unbounded pre-flight would then refuse again at every setting.
    //
    // Both refusals return before any INSERT, so neither would ever clear on its
    // own. Hence the message-id map is loaded HERE rather than at the copy loop.
    //
    // Still deliberately conservative on what remains: content-hash dedup is not
    // subtracted (that would mean hashing every source file up front), so the
    // figure stays an upper bound. Erring toward refusal is correct for a guard
    // whose failure mode is a full disk.
    const alreadyStoredKeys = new Set<string>();
    for (const row of db
      .prepare(
        `SELECT external_message_id, filename FROM ${attachmentsRead(
          "external_message_id, filename"
        )} WHERE external_message_id IS NOT NULL`
      )
      .all(...readParams) as { external_message_id: string; filename: string }[]) {
      const key = attachmentStoredKey(row.external_message_id, row.filename);
      if (key) alreadyStoredKeys.add(key);
    }

    // Messages stored by PREVIOUS runs. Combined with this run's messageIdMap,
    // these are the only messages an attachment can be linked to — anything else
    // is skipped by the copy loop without writing a byte.
    const existingMessageIdMap = new Map<string, string>();
    const existingMsgRows = db
      .prepare(
        `SELECT id, external_id FROM ${messagesRead(
          "id, external_id"
        )} WHERE external_id IS NOT NULL`
      )
      .all(...readParams) as { id: string; external_id: string }[];
    for (const row of existingMsgRows) {
      existingMessageIdMap.set(row.external_id, row.id);
    }
    const resolvableGuids = new Set<string>([
      ...messageIdMap.keys(),
      ...existingMessageIdMap.keys(),
    ]);

    const pendingAttachments = filterResolvableAttachments(
      filterUnstoredAttachments(attachments, alreadyStoredKeys),
      resolvableGuids
    );
    const spaceEstimate = summarizeAttachmentEstimate(pendingAttachments);
    const availableBytes = await getAvailableDiskBytes(app.getPath("userData"));
    const verdict = evaluateAttachmentSpace(spaceEstimate.eligibleBytes, availableBytes);
    if (!verdict.fits && verdict.availableBytes !== null) {
      logService.warn(
        `Refusing attachment import: needs ~${Math.round(spaceEstimate.eligibleBytes / 1e9)} GB ` +
          `but only ~${Math.round(verdict.availableBytes / 1e9)} GB is available. No files were copied.`,
        MacOSMessagesImportService.SERVICE_NAME,
        {
          estimatedBytes: spaceEstimate.eligibleBytes,
          availableBytes: verdict.availableBytes,
          headroomBytes: verdict.headroomBytes,
          attachmentCount: spaceEstimate.eligibleCount,
        }
      );
      return {
        stored: 0,
        skipped: attachments.length,
        updated: 0,
        refusedForSpace: {
          estimatedBytes: spaceEstimate.eligibleBytes,
          availableBytes: verdict.availableBytes,
          attachmentCount: spaceEstimate.eligibleCount,
        },
      };
    }

    // Create attachments directory if it doesn't exist
    const attachmentsDir = path.join(app.getPath("userData"), ATTACHMENTS_DIR);
    await fs.promises.mkdir(attachmentsDir, { recursive: true });

    // Load existing attachment hashes for deduplication (file content)
    const existingHashes = new Set<string>();
    const existingHashRows = db
      .prepare(
        `SELECT storage_path FROM ${attachmentsRead(
          "storage_path"
        )} WHERE storage_path IS NOT NULL`
      )
      .all(...readParams) as { storage_path: string }[];

    // Extract hash from storage path (filename is the hash)
    for (const row of existingHashRows) {
      const filename = path.basename(row.storage_path, path.extname(row.storage_path));
      existingHashes.add(filename);
    }

    // Load existing attachment records for deduplication (message_id + filename)
    const existingAttachmentRecords = new Set<string>();
    const existingAttachRows = db
      .prepare(
        `SELECT message_id, filename FROM ${attachmentsRead(
          "message_id, filename"
        )} WHERE message_id IS NOT NULL`
      )
      .all(...readParams) as { message_id: string; filename: string }[];

    for (const row of existingAttachRows) {
      existingAttachmentRecords.add(`${row.message_id}:${row.filename}`);
    }

    // TASK-1122: Load existing attachments by external_message_id for stable deduplication
    // This allows us to find and UPDATE attachments with stale message_ids after re-sync
    // BACKLOG-2790: this read carries `in_staging`, and it is the only one that
    // needs to, because it is the only one whose result is later WRITTEN to. A
    // stale `message_id` on a row this run staged is fixed in staging; the same
    // repair aimed at a row that survived in the LIVE table is held back for the
    // swap (see `ForceStaging.messageIdRepairs`), so the live table stays
    // untouched for the length of the rebuild while the repair still becomes
    // visible at exactly the moment it did before — when the transaction that
    // carries the whole re-import commits.
    const existingByExternalId = new Map<
      string,
      { id: string; message_id: string; inStaging: boolean }
    >();
    const externalIdRowsSql = staging
      ? `SELECT id, message_id, external_message_id, filename, in_staging FROM (
           SELECT id, message_id, external_message_id, filename, 0 AS in_staging
             FROM attachments WHERE ${SURVIVING_ATTACHMENTS}
           UNION ALL
           SELECT id, message_id, external_message_id, filename, 1 AS in_staging
             FROM "${staging.attachmentsTable}"
         ) WHERE external_message_id IS NOT NULL`
      : `SELECT id, message_id, external_message_id, filename, 0 AS in_staging
           FROM attachments WHERE external_message_id IS NOT NULL`;
    const existingExternalRows = db
      .prepare(externalIdRowsSql)
      .all(...readParams) as {
      id: string;
      message_id: string;
      external_message_id: string;
      filename: string;
      in_staging: number;
    }[];

    for (const row of existingExternalRows) {
      // Key: external_message_id:filename for unique identification.
      // BACKLOG-2743: built by attachmentStoredKey so this and the pre-flight's
      // exclusion set cannot drift into two different spellings of one format.
      const externalIdKey = attachmentStoredKey(row.external_message_id, row.filename);
      if (!externalIdKey) continue;
      existingByExternalId.set(externalIdKey, {
        id: row.id,
        message_id: row.message_id,
        inStaging: row.in_staging === 1,
      });
    }

    logService.info(
      `Processing ${attachments.length} attachments, ${existingHashes.size} already stored`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // Create progress bar for attachments
    const attachProgressBar = createProgressBar("Attachments");
    attachProgressBar.start(attachments.length, 0);

    // Prepare insert statement (TASK-1110: include external_message_id for stable linking)
    const insertAttachmentStmt = db.prepare(`
      INSERT OR IGNORE INTO ${attachmentsTable} (
        id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    // TASK-1122: Prepare update statement for fixing stale message_ids
    const updateMessageIdStmt = db.prepare(`
      UPDATE ${attachmentsTable} SET message_id = ? WHERE id = ?
    `);

    // BACKLOG-2743: existingMessageIdMap (messages imported by previous runs) is
    // loaded ABOVE, before the pre-flight — the guard needs it to size only the
    // attachments this loop could actually link and write.

    // Process attachments with progress reporting and event loop yielding
    const totalAttachments = attachments.length;
    // TASK-2097: Report at ~5% increments (min 1) for smooth progress with any attachment count
    const attachReportInterval = Math.max(1, Math.floor(totalAttachments / 20));
    let processed = 0;

    for (const attachment of attachments) {
      // Check for cancellation (legacy flag and AbortSignal)
      //
      // BACKLOG-2748: this check is PER ATTACHMENT, not per batch, and that is
      // the property that makes Cancel worth pressing — the attachment phase is
      // the expensive one (hashing and copying files, gigabytes of them), and a
      // cancel honoured only between message batches would keep filling the disk
      // long after the user asked it to stop. Pinned by
      // `macOSMessagesImportService.cancel-2748.test.ts`, which cancels at the
      // third of twelve attachments and asserts exactly three files exist.
      if (this.abortController?.signal.aborted) {
        attachProgressBar.stop();
        logService.warn(
          `Attachment import cancelled at ${processed}/${totalAttachments}`,
          MacOSMessagesImportService.SERVICE_NAME
        );
        break;
      }

      try {
        // Skip unsupported attachment types (TASK-1122: expanded to include videos, audio, documents)
        const filename = attachment.transfer_name || attachment.filename;
        if (!isSupportedMediaType(filename)) {
          skipped++;
          processed++;
          continue;
        }

        // Skip oversized attachments
        if (attachment.total_bytes > MAX_ATTACHMENT_SIZE) {
          logService.warn(
            `Skipping oversized attachment: ${attachment.total_bytes} bytes`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          skipped++;
          processed++;
          continue;
        }

        // Get the internal message ID for this attachment's message
        // First check the current import batch, then existing messages
        let internalMessageId = messageIdMap.get(attachment.message_guid);
        if (!internalMessageId) {
          internalMessageId = existingMessageIdMap.get(attachment.message_guid);
        }
        if (!internalMessageId) {
          // Message not found - skip this attachment
          skipped++;
          processed++;
          continue;
        }

        // Resolve the source file path
        // macOS Messages stores attachments with paths like:
        // ~/Library/Messages/Attachments/xx/yy/guid/filename
        // The filename column contains the full path with ~ prefix
        let sourcePath = attachment.filename;
        if (!sourcePath) {
          skipped++;
          processed++;
          continue;
        }

        // Resolve ~ to home directory
        if (sourcePath.startsWith("~")) {
          sourcePath = path.join(process.env.HOME!, sourcePath.slice(1));
        }

        // Check if source file exists (async)
        try {
          await fs.promises.access(sourcePath, fs.constants.R_OK);
        } catch {
          logService.debug(
            `Attachment file not found: ${sourcePath}`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          skipped++;
          processed++;
          continue;
        }

        // Generate content hash for deduplication (async)
        const contentHash = await generateContentHash(sourcePath);

        // Check if attachment record already exists for this message + filename
        const attachmentKey = `${internalMessageId}:${filename}`;
        if (existingAttachmentRecords.has(attachmentKey)) {
          // Attachment record already exists with correct message_id, skip
          skipped++;
          processed++;
          continue;
        }

        // TASK-1122: Check if attachment exists by external_message_id (stable identifier)
        // If so, update its message_id to the new internal ID (fixes stale references after re-sync)
        // BACKLOG-2743: same helper as the pre-flight's exclusion set — one
        // spelling of the key format, not three identical-by-inspection copies.
        const externalKey = attachmentStoredKey(attachment.message_guid, filename);
        const existingByExternal = externalKey ? existingByExternalId.get(externalKey) : undefined;
        if (existingByExternal) {
          // Attachment exists but may have stale message_id
          if (existingByExternal.message_id !== internalMessageId) {
            // Update the stale message_id to the new internal ID
            if (staging && !existingByExternal.inStaging) {
              // BACKLOG-2790: the row lives in the real `attachments` table, so
              // the repair waits for the swap rather than reaching into live
              // mid-rebuild. Same visibility as before — one transaction, at the
              // end — without a rebuild that can be cancelled having written
              // anything the user could see.
              staging.messageIdRepairs.push({
                attachmentId: existingByExternal.id,
                messageId: internalMessageId,
              });
            } else {
              updateMessageIdStmt.run(internalMessageId, existingByExternal.id);
            }
            updated++;
            logService.debug(
              `Updated stale attachment message_id: ${existingByExternal.id}`,
              MacOSMessagesImportService.SERVICE_NAME,
              { oldMessageId: existingByExternal.message_id, newMessageId: internalMessageId }
            );
          } else {
            // message_id is already correct, count as skipped
            skipped++;
          }
          // Update our tracking sets
          existingAttachmentRecords.add(attachmentKey);
          processed++;
          continue;
        }

        // Skip if we already have this content
        if (existingHashes.has(contentHash)) {
          // File already exists - just link to existing file
          const ext = path.extname(filename!);
          const existingPath = path.join(attachmentsDir, `${contentHash}${ext}`);

          // Create attachment record linking to existing file
          // TASK-1110: Include external_message_id (macOS message GUID) for stable linking
          const attachmentId = crypto.randomUUID();
          insertAttachmentStmt.run(
            attachmentId,
            internalMessageId,
            attachment.message_guid, // external_message_id for stable linking
            filename,
            attachment.mime_type || getMimeTypeFromFilename(filename!),
            attachment.total_bytes,
            existingPath
          );
          existingAttachmentRecords.add(attachmentKey);
          stored++;
          processed++;
          continue;
        }

        // Copy file to app data directory with hash as filename (async)
        const ext = path.extname(filename!);
        const destPath = path.join(attachmentsDir, `${contentHash}${ext}`);
        await fs.promises.copyFile(sourcePath, destPath);

        // Insert attachment record
        // TASK-1110: Include external_message_id (macOS message GUID) for stable linking
        const attachmentId = crypto.randomUUID();
        insertAttachmentStmt.run(
          attachmentId,
          internalMessageId,
          attachment.message_guid, // external_message_id for stable linking
          filename,
          attachment.mime_type || getMimeTypeFromFilename(filename!),
          attachment.total_bytes,
          destPath
        );

        existingAttachmentRecords.add(attachmentKey);
        stored++;
        processed++;
        existingHashes.add(contentHash);
      } catch (error) {
        // Expected, normal-for-old-messages errors are silent:
        // - FOREIGN KEY: messages that were skipped
        // - ENOENT: attachment files that have been deleted
        // - UNIQUE constraint: duplicate attachment already stored
        // BACKLOG-2262: Log anything ELSE at debug level so media-recovery
        // regressions (now that more parent messages are retained) are observable
        // rather than silently swallowed into skipped++.
        const errMsg = error instanceof Error ? error.message : String(error);
        const isExpected =
          errMsg.includes("ENOENT") ||
          errMsg.includes("FOREIGN KEY") ||
          errMsg.includes("UNIQUE constraint");
        if (!isExpected) {
          logService.debug(
            `Unexpected error storing attachment (skipped): ${errMsg}`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }
        skipped++;
        processed++;
      }

      // Update progress bar
      attachProgressBar.update(processed);

      // Report progress to UI at ~5% increments
      if (processed % attachReportInterval === 0 || processed === totalAttachments) {
        const percent = Math.round((processed / totalAttachments) * 100);
        onProgress?.({
          phase: "attachments",
          current: processed,
          total: totalAttachments,
          percent,
        });
      }

      // Yield to event loop every 100 attachments to prevent UI freeze
      if (processed % 100 === 0) {
        await yieldToEventLoop();
      }
    }

    // Stop progress bar
    attachProgressBar.stop();

    logService.info(
      `Attachments: ${stored} imported, ${updated} updated, ${skipped} skipped`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    return { stored, skipped, updated };
  }

  /**
   * Get the directory path for message attachments
   */
  getAttachmentsDirectory(): string {
    return path.join(app.getPath("userData"), ATTACHMENTS_DIR);
  }

  /**
   * Get count of messages available for import
   * TASK-1952: Supports optional filters to show filtered vs total count
   */
  async getAvailableMessageCount(plan: ImportPlan): Promise<{
    success: boolean;
    count?: number;
    /**
     * What the run will IMPORT for this plan — Cap' applied (BACKLOG-2772).
     * Present only when it differs from `count`.
     */
    filteredCount?: number;
    /**
     * What the SELECTION covers, before the cap (BACKLOG-2772).
     *
     * Kept alongside `filteredCount` because the cap warning needs both: with
     * only the admitted number, a cap that truncates 707,842 messages to 50,000
     * looks exactly like a window that happens to hold 50,000, and the user
     * stops being told anything is being left out.
     */
    windowCount?: number;
    error?: string;
    /** BACKLOG-2743: Bytes of attachments that would be copied for this window. */
    attachmentBytes?: number;
    /** BACKLOG-2743: Number of attachments that would be copied. */
    attachmentCount?: number;
    /** BACKLOG-2743: df-equivalent free space, or null when unreadable. */
    availableDiskBytes?: number | null;
    /**
     * BACKLOG-2743: Whether the attachment copy fits (estimate + headroom vs
     * available). Computed HERE, in main, by the same helper the pre-flight
     * check uses — the renderer is never asked to redo this comparison, so the
     * number the user is shown and the number the import enforces cannot drift.
     */
    fitsOnDisk?: boolean;
  }> {
    // Check platform
    if (os.platform() !== "darwin") {
      return {
        success: false,
        error: "macOS Messages import is only available on macOS",
      };
    }

    // Check permission
    const permissionCheck = await permissionService.checkFullDiskAccess();
    if (!permissionCheck.hasPermission) {
      return {
        success: false,
        error: permissionCheck.userMessage || "Full Disk Access required",
      };
    }

    try {
      const messagesDbPath = path.join(
        process.env.HOME!,
        "Library/Messages/chat.db"
      );

      // BACKLOG-2403: see openSqliteReadOnly — a bare construction here crashed
      // the app whenever chat.db could not be opened.
      const db = await openSqliteReadOnly(messagesDbPath, MacOSMessagesImportService.SERVICE_NAME);
      const dbGet = (sql: string) => db.get<{ count: number }>(sql);
      const dbAllSizes = (sql: string) => db.all<AttachmentSizeRow>(sql);
      /**
       * BACKLOG-2784: closing the macOS Messages handle, at most once.
       *
       * The same double-close shape BACKLOG-2775 fixed on the import path was
       * still live here, and this is the PRE-FLIGHT the Settings panel runs
       * before every import — so it is the first place a genuine failure gets
       * reported to the user and to Sentry.
       *
       * `ReadOnlySqliteHandle.close` is `promisify(db.close.bind(db))` from
       * node-sqlite3, and a SECOND close REJECTS with
       * `SQLITE_MISUSE: Database is closed`. There are two close sites below and
       * they are NOT mutually exclusive: the success path closes as soon as the
       * last source query is done, and a good deal of work still follows it
       * (`app.getPath`, the stored-attachment read, the estimate, the disk
       * verdict). Anything thrown in that tail reached the inner `catch`, which
       * closed AGAIN — and that rejection REPLACED the real error, so a locked
       * source database or a disk fault surfaced to the user as
       * "Database is closed".
       *
       * Making the close idempotent lets the original error through unchanged.
       * No mocked suite can catch this — a `jest.fn()` close is idempotent by
       * construction — which is why the reproduction lives in
       * `macOSMessagesImportService.preflightMaskingRealDriver-2784.test.ts`
       * against the real driver, exactly as BACKLOG-2775's does.
       */
      let sourceDbClosed = false;
      const dbClose = async (): Promise<void> => {
        if (sourceDbClosed) return;
        sourceDbClosed = true;
        await db.close();
      };

      // BACKLOG-2280: Reactions are imported now, so the available-count scope must
      // match the import SELECT scope (which also includes reactions). Keeping this
      // count in lockstep with the fetch scope is what prevents the fetch loop from
      // terminating early and dropping the newest rows.

      try {
        // Total count (importable rows, unfiltered by date)
        const totalResult = await dbGet(`
          SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL
        `);
        const totalCount = totalResult?.count || 0;

        // TASK-1952 / BACKLOG-2276: Calculate filtered count when a date filter is
        // active. Uses the same audit-period-aware cutoff as the import itself.
        // BACKLOG-2772/2760: READ from the plan, never recomputed. The estimate
        // and the run that follows it are the same decision object, so they
        // cannot describe different windows — which is what they did when each
        // assembled its own filters from whatever the renderer had sent.
        const windowSql = buildMessageWindowSql(plan);
        const { dateFilterClause } = windowSql;

        let windowCount = totalCount;
        if (plan.cutoffNano !== null) {
          const filteredResult = await dbGet(`
            SELECT COUNT(*) as count FROM message
            WHERE message.guid IS NOT NULL ${dateFilterClause}
          `);
          windowCount = filteredResult?.count || 0;
        }

        // BACKLOG-2772: apply Cap' HERE TOO, through the same function the run
        // uses. The window count is not what the run imports.
        //
        // Before Cap' the two agreed for free: any non-rejected deal switched
        // the cap off entirely, so the run covered the whole window. Cap' makes
        // the common case — deals AND a cap — precisely where they diverge, and
        // an estimate reading only the window would have shown Daniel 707,842
        // messages in Settings for a run that stores ~50,000 plus his deal
        // periods.
        const admitted = await resolveAdmittedMessageSet(
          db.all,
          plan,
          windowSql,
          windowCount
        );
        const filteredCount = admitted.targetMessageCount;

        // BACKLOG-2743: Size the attachment copy for the SAME window, before any
        // byte is copied. Every figure needed is queryable from chat.db up front;
        // previously nothing on this path looked at attachment size at all, so a
        // library whose attachments exceeded the disk was discovered only by
        // running out of space partway through the copy.
        //
        // BACKLOG-2772: scoped to the ADMITTED set, not the window. These bytes
        // feed `evaluateAttachmentSpace` and therefore `fitsOnDisk`, so a
        // window-sized sum lets the space guard refuse an import — or push the
        // user to "Text only" — over files the cap will never fetch. Over-
        // refusal is the safe direction, but it is user-visible and wrong.
        //
        // Scoped by the same date cutoff as the count: storeAttachments only
        // copies an attachment whose message resolves to a stored message ID, so
        // the window bounds the attachment set in practice even though the
        // import's own attachment SELECT is unbounded. (An attachment belonging
        // to a message imported by an EARLIER run with a wider window can still
        // be copied, which makes reality marginally exceed this estimate for
        // narrow windows; for "All time" — the case that overruns a disk — there
        // is no such gap.)
        //
        // GROUP BY attachment.ROWID: one source file counts ONCE even when it is
        // joined to several messages. Same ROWID = same source path = same
        // content hash = a single copy on disk.
        const attachmentWhere =
          `WHERE message.guid IS NOT NULL AND attachment.filename IS NOT NULL ` +
          `${dateFilterClause} ${admitted.capFetchClause}`;
        const attachmentRows = await dbAllSizes(`
          SELECT
            attachment.filename as filename,
            attachment.transfer_name as transfer_name,
            attachment.total_bytes as total_bytes,
            message.guid as message_guid
          FROM attachment
          JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
          JOIN message ON message.ROWID = message_attachment_join.message_id
          ${attachmentWhere}
          GROUP BY attachment.ROWID
        `);

        await dbClose();

        // Exclude attachments already in app storage, exactly as the pre-flight
        // does. Without this the panel would show the FIRST import's size
        // forever and block a user who had already imported successfully.
        // Failure to read the app DB leaves the set unfiltered (a higher, safer
        // estimate) rather than aborting the count.
        const alreadyStoredKeys = new Set<string>();
        try {
          const appDb = databaseService.getRawDatabase();
          for (const row of appDb
            .prepare(
              `SELECT external_message_id, filename FROM attachments WHERE external_message_id IS NOT NULL`
            )
            .all() as { external_message_id: string; filename: string }[]) {
            const key = attachmentStoredKey(row.external_message_id, row.filename);
            if (key) alreadyStoredKeys.add(key);
          }
        } catch (dbError) {
          logService.warn(
            "Could not read stored attachments for the import estimate; reporting the unfiltered total",
            MacOSMessagesImportService.SERVICE_NAME,
            { error: dbError instanceof Error ? dbError.message : String(dbError) }
          );
        }

        const estimate = summarizeAttachmentEstimate(
          filterUnstoredAttachments(attachmentRows, alreadyStoredKeys)
        );
        const availableDiskBytes = await getAvailableDiskBytes(app.getPath("userData"));
        const verdict = evaluateAttachmentSpace(estimate.eligibleBytes, availableDiskBytes);

        return {
          success: true,
          count: totalCount,
          filteredCount: filteredCount !== totalCount ? filteredCount : undefined,
          // BACKLOG-2772: the window BEFORE the cap. `filteredCount` is what the
          // run imports; this is what the selection covers, and the cap warning
          // needs both to say "of N in this window, M will be imported".
          windowCount,
          attachmentBytes: estimate.eligibleBytes,
          attachmentCount: estimate.eligibleCount,
          availableDiskBytes,
          fitsOnDisk: verdict.fits,
        };
      } catch (error) {
        await dbClose();
        throw error;
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get attachments for a specific message (TASK-1012)
   * TASK-1110: Query by both message_id and external_message_id for backward compatibility
   */
  getAttachmentsByMessageId(messageId: string): MessageAttachment[] {
    const db = databaseService.getRawDatabase();

    // First try direct message_id lookup
    let rows = db
      .prepare(
        `
        SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
        FROM attachments
        WHERE message_id = ?
      `
      )
      .all(messageId) as MessageAttachment[];

    // If no results and this is a valid message, try external_message_id fallback
    // TASK-1110: This handles the case where attachments have stale message_id but valid external_message_id
    if (rows.length === 0) {
      // Look up the message's external_id (macOS GUID)
      const message = db
        .prepare(`SELECT external_id FROM messages WHERE id = ?`)
        .get(messageId) as { external_id: string } | undefined;

      if (message?.external_id) {
        rows = db
          .prepare(
            `
            SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
            FROM attachments
            WHERE external_message_id = ?
          `
          )
          .all(message.external_id) as MessageAttachment[];

        // If found via external_message_id, update the message_id for future queries
        if (rows.length > 0) {
          logService.info(
            `[Attachments] Found ${rows.length} attachments via external_message_id fallback, updating message_id`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          const updateStmt = db.prepare(`UPDATE attachments SET message_id = ? WHERE external_message_id = ?`);
          updateStmt.run(messageId, message.external_id);
          // Update the returned rows to reflect the corrected message_id
          rows = rows.map(row => ({ ...row, message_id: messageId }));
        }
      }
    }

    return rows;
  }

  /**
   * Get attachments for multiple messages at once (TASK-1012)
   * TASK-1110: Query by both message_id and external_message_id for backward compatibility
   */
  getAttachmentsByMessageIds(messageIds: string[]): Map<string, MessageAttachment[]> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const db = databaseService.getRawDatabase();
    const result = new Map<string, MessageAttachment[]>();

    // Debug: Log total attachments in DB and sample message_ids
    const totalCount = db.prepare(`SELECT COUNT(*) as count FROM attachments`).get() as { count: number };
    logService.debug(
      `[Attachments Debug] Total: ${totalCount.count}, Querying: ${messageIds.length} IDs`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // First, try direct message_id lookup
    const placeholders = messageIds.map(() => "?").join(", ");
    const directRows = db
      .prepare(
        `
        SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
        FROM attachments
        WHERE message_id IN (${placeholders})
      `
      )
      .all(...messageIds) as MessageAttachment[];

    // Group direct results by message_id
    for (const row of directRows) {
      const existing = result.get(row.message_id) || [];
      existing.push(row);
      result.set(row.message_id, existing);
    }

    // TASK-1110: For messages without direct results, try external_message_id fallback
    const missingMessageIds = messageIds.filter(id => !result.has(id));

    if (missingMessageIds.length > 0) {
      // Look up external_ids for messages that didn't have direct matches
      const missingPlaceholders = missingMessageIds.map(() => "?").join(", ");
      const messageExternalIds = db
        .prepare(
          `SELECT id, external_id FROM messages WHERE id IN (${missingPlaceholders}) AND external_id IS NOT NULL`
        )
        .all(...missingMessageIds) as { id: string; external_id: string }[];

      if (messageExternalIds.length > 0) {
        // Query attachments by external_message_id
        const externalIds = messageExternalIds.map(m => m.external_id);
        const externalPlaceholders = externalIds.map(() => "?").join(", ");
        const fallbackRows = db
          .prepare(
            `
            SELECT id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path
            FROM attachments
            WHERE external_message_id IN (${externalPlaceholders})
          `
          )
          .all(...externalIds) as (MessageAttachment & { external_message_id: string })[];

        // Build a map of external_id -> internal message id for updating
        const externalToInternalMap = new Map<string, string>();
        for (const msg of messageExternalIds) {
          externalToInternalMap.set(msg.external_id, msg.id);
        }

        // Group fallback results and update stale message_ids
        const attachmentsToUpdate: { attachmentId: string; newMessageId: string; externalMessageId: string }[] = [];

        for (const row of fallbackRows) {
          const internalMessageId = externalToInternalMap.get(row.external_message_id);
          if (internalMessageId) {
            // Update the row's message_id to the correct internal ID
            const correctedRow: MessageAttachment = {
              id: row.id,
              message_id: internalMessageId,
              filename: row.filename,
              mime_type: row.mime_type,
              file_size_bytes: row.file_size_bytes,
              storage_path: row.storage_path,
            };

            const existing = result.get(internalMessageId) || [];
            existing.push(correctedRow);
            result.set(internalMessageId, existing);

            // Track for batch update
            attachmentsToUpdate.push({
              attachmentId: row.id,
              newMessageId: internalMessageId,
              externalMessageId: row.external_message_id,
            });
          }
        }

        // Batch update stale message_ids for future queries
        if (attachmentsToUpdate.length > 0) {
          logService.info(
            `[Attachments] Found ${attachmentsToUpdate.length} attachments via external_message_id fallback, updating message_ids`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          const updateStmt = db.prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`);
          const updateMany = db.transaction((updates: typeof attachmentsToUpdate) => {
            for (const update of updates) {
              updateStmt.run(update.newMessageId, update.attachmentId);
            }
          });
          updateMany(attachmentsToUpdate);
        }
      }
    }

    logService.debug(
      `[Attachments Debug] Found ${Array.from(result.values()).reduce((sum, arr) => sum + arr.length, 0)} attachments total`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    return result;
  }

  /**
   * Read an attachment file as base64 for display (TASK-1012)
   * Returns null if file doesn't exist
   */
  getAttachmentAsBase64(storagePath: string): string | null {
    try {
      if (!fs.existsSync(storagePath)) {
        return null;
      }
      const buffer = fs.readFileSync(storagePath);
      return buffer.toString("base64");
    } catch (error) {
      logService.warn(
        `Failed to read attachment: ${error instanceof Error ? error.message : "Unknown"}`,
        MacOSMessagesImportService.SERVICE_NAME
      );
      return null;
    }
  }

  /**
   * Repair attachment message_id mappings without full re-import.
   * Looks up correct message IDs via external_id (iMessage GUID) from macOS Messages DB.
   * @returns Stats on repaired/orphaned attachments
   */
  async repairAttachmentMessageIds(): Promise<{
    total: number;
    repaired: number;
    orphaned: number;
    alreadyCorrect: number;
  }> {
    const db = databaseService.getRawDatabase();
    const stats = { total: 0, repaired: 0, orphaned: 0, alreadyCorrect: 0 };

    // Get all attachments with their storage paths
    const attachments = db
      .prepare(`SELECT id, message_id, storage_path FROM attachments`)
      .all() as { id: string; message_id: string; storage_path: string | null }[];

    stats.total = attachments.length;

    if (attachments.length === 0) {
      logService.info(
        `[Repair] No attachments to repair`,
        MacOSMessagesImportService.SERVICE_NAME
      );
      return stats;
    }

    // Build message external_id -> internal id map
    const messageMap = new Map<string, string>();
    const messageRows = db
      .prepare(`SELECT id, external_id FROM messages WHERE external_id IS NOT NULL`)
      .all() as { id: string; external_id: string }[];
    for (const row of messageRows) {
      messageMap.set(row.external_id, row.id);
    }

    logService.info(
      `[Repair] Checking ${attachments.length} attachments against ${messageMap.size} messages`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // Query macOS Messages DB to get attachment -> message_guid mapping
    const messagesDbPath = path.join(process.env.HOME!, "Library/Messages/chat.db");
    if (!fs.existsSync(messagesDbPath)) {
      logService.error(
        `[Repair] Cannot access macOS Messages database`,
        MacOSMessagesImportService.SERVICE_NAME
      );
      return stats;
    }

    try {
      // Open macOS Messages database using sqlite3 (same as import).
      // BACKLOG-2403: the existsSync check above is a race, not a guard — the file
      // can vanish or lose readability between the check and the open, and the old
      // bare construction turned that into a dead process rather than a caught error.
      const macDb = await openSqliteReadOnly(messagesDbPath, MacOSMessagesImportService.SERVICE_NAME);
      const dbAll = macDb.all;

      // Build attachment filename -> message_guid map from macOS Messages DB
      const macAttachments = await dbAll<{ filename: string; message_guid: string }>(`
        SELECT
          attachment.filename,
          message.guid as message_guid
        FROM attachment
        JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
        JOIN message ON message.ROWID = message_attachment_join.message_id
        WHERE attachment.filename IS NOT NULL AND message.guid IS NOT NULL
      `);

      // Map by basename for matching (our storage uses content hash, but original filename is in the path)
      const filenameToGuid = new Map<string, string>();
      for (const att of macAttachments) {
        // Extract just the filename from the full path
        const basename = path.basename(att.filename);
        filenameToGuid.set(basename, att.message_guid);
      }

      logService.info(
        `[Repair] Found ${filenameToGuid.size} attachment mappings in macOS Messages DB`,
        MacOSMessagesImportService.SERVICE_NAME
      );

      // Close macOS database
      await macDb.close();

      // Prepare update statement
      const updateStmt = db.prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`);

      // Check each attachment
      for (const att of attachments) {
        // First check if current message_id is valid
        const currentMsgExists = db
          .prepare(`SELECT 1 FROM messages WHERE id = ?`)
          .get(att.message_id);

        if (currentMsgExists) {
          stats.alreadyCorrect++;
          continue;
        }

        // Current message_id is invalid - try to find correct one
        // Extract original filename from storage path (stored files keep original name in metadata)
        // Our storage uses hash as filename, so we need to look at the attachment record's original filename
        const originalFilename = db
          .prepare(`SELECT filename FROM attachments WHERE id = ?`)
          .get(att.id) as { filename: string } | undefined;

        if (!originalFilename?.filename) {
          stats.orphaned++;
          continue;
        }

        // Look up the message GUID for this attachment
        const messageGuid = filenameToGuid.get(originalFilename.filename);
        if (!messageGuid) {
          stats.orphaned++;
          continue;
        }

        // Look up our internal message ID
        const internalId = messageMap.get(messageGuid);
        if (!internalId) {
          stats.orphaned++;
          continue;
        }

        // Update the attachment's message_id
        updateStmt.run(internalId, att.id);
        stats.repaired++;
      }

      logService.info(
        `[Repair] Complete: ${stats.repaired} repaired, ${stats.alreadyCorrect} already correct, ${stats.orphaned} orphaned`,
        MacOSMessagesImportService.SERVICE_NAME
      );
    } catch (error) {
      logService.error(
        `[Repair] Error: ${error instanceof Error ? error.message : "Unknown"}`,
        MacOSMessagesImportService.SERVICE_NAME
      );
    }

    return stats;
  }
}

// Export singleton instance
export const macOSMessagesImportService = new MacOSMessagesImportService();
export default macOSMessagesImportService;
