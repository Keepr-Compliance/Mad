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
import { MAC_EPOCH } from "../../constants";
// BACKLOG-2393: scoped support-access tracing. A no-op unless a user has
// granted a support window covering the message-import scope.
import { supportTrace } from "../supportAccess/trace";
// BACKLOG-2775: the two main-process timers that write on the SHARED database
// connection. The force re-import stops them for the length of its transaction
// so a rollback cannot discard their work — see quiesceBackgroundWriters().
import auditService from "../auditService";
import submissionSyncService from "../submissionSyncService";

import type {
  MessageImportFilters,
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
  DELETE_BATCH_SIZE,
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
  computeImportCutoffNano,
  shouldRetainMessageContent,
  isReactionAssociationType,
  summarizeAttachmentEstimate,
  filterUnstoredAttachments,
  filterResolvableAttachments,
  attachmentStoredKey,
} from "./importHelpers";
import type { AttachmentSizeRow } from "./importHelpers";
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
   * BACKLOG-2775: how long to wait for an already-in-flight background sync to
   * finish before opening the force transaction. It is a network round trip, so
   * a few seconds is generous; exceeding it is logged, not fatal.
   */
  private static readonly QUIESCE_TIMEOUT_MS = 5000;
  /** BACKLOG-2775: how often to re-check for an in-flight sync while waiting. */
  private static readonly QUIESCE_POLL_MS = 25;

  /**
   * Import messages from macOS Messages app
   * @param userId - User ID
   * @param onProgress - Progress callback
   * @param forceReimport - If true, delete existing messages first and re-import all
   * @param filters - Optional date range and count cap filters (TASK-1952)
   */
  async importMessages(
    userId: string,
    onProgress?: ImportProgressCallback,
    forceReimport = false,
    filters?: MessageImportFilters
  ): Promise<MacOSImportResult> {
    const startTime = Date.now();

    // If force reimport is in progress, block ALL other imports
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
      return await this.doImport(userId, onProgress, startTime, forceReimport, filters);
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
    forceReimport: boolean,
    filters?: MessageImportFilters
  ): Promise<MacOSImportResult> {
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

    // BACKLOG-2775: the force path's clear + re-import run as ONE transaction.
    // `forceTxnOpen` is the single piece of state the `finally` needs: true means
    // this run opened a transaction and has not committed it, so the exit — any
    // exit, including the cancel returns below and a thrown error — must roll it
    // back. There is deliberately no rollback anywhere else; scattering them
    // across the several return points is how one gets missed.
    const appDb = forceReimport ? databaseService.getRawDatabase() : null;
    let forceTxnOpen = false;
    /**
     * BACKLOG-2775: this run executed `BEGIN IMMEDIATE`, so any transaction open
     * on the connection at `finally` time is OURS. Set once, never cleared —
     * unlike `forceTxnOpen`, which is cleared after the COMMIT.
     *
     * It exists because the BEGIN site refuses to touch a transaction it did not
     * start ("would discard their work") by throwing — and that throw lands in
     * the outer catch and then the `finally`. Rolling back on `inTransaction`
     * alone would discard exactly the foreign work the guard just refused to
     * touch. Unreachable today (nothing else in `electron/` opens a raw
     * transaction, and `db.transaction()` cannot span an await), which is
     * precisely the kind of assumption that stops being true quietly.
     */
    let forceTxnBegun = false;
    // BACKLOG-2775: set once the background writers have been stopped for this
    // run, so the `finally` restarts exactly what was stopped and only then.
    let forceQuiesced = false;
    let resumeBackgroundWriters: () => void = () => {};
    /**
     * BACKLOG-2775 structural guard: set by every exit that INTENDS to leave the
     * transaction open for the `finally` to roll back.
     *
     * The hazard it closes is a future edit, not a present bug. This try block
     * is ~600 lines with several exits; a `return { success: true, ... }` added
     * anywhere inside it would be rolled back by the `finally` while reporting
     * success to the user — a silently emptied message store, with tsc, lint and
     * every existing test still green. Making the intent explicit means the
     * DEFAULT for a newly added return is to trip the guard rather than to lose
     * data quietly.
     */
    let forceRollbackDeclared = false;
    /** Declare a deliberate rollback exit and produce its result. */
    const rollbackAndReturn = (): MacOSImportResult => {
      forceRollbackDeclared = true;
      return this.cancelledUnchangedResult(startTime);
    };

    try {
      // If force reimport, delete existing macOS messages first
      if (forceReimport && appDb) {
        // BACKLOG-2775: check BEFORE the destructive clear. The founder cancelled
        // ~1s in and still waited out a 35-second delete of 162,961 messages: the
        // flag was only read between phases, so the entire clear ran after the
        // cancel had been requested. The cheapest fix for that run is to not
        // start it.
        if (this.abortController?.signal.aborted) {
          logService.warn(
            "Force reimport cancelled before the clear phase — nothing was deleted",
            MacOSMessagesImportService.SERVICE_NAME
          );
          return rollbackAndReturn();
        }

        // A transaction already in progress on this connection would mean the
        // COMMIT below belongs to someone else and the ROLLBACK would discard
        // their work. Nothing in the app holds one across an await today; assert
        // it rather than assume it, because the failure would be silent.
        if (appDb.inTransaction) {
          throw new Error(
            "Cannot start force re-import: a database transaction is already open on this connection"
          );
        }

        // BACKLOG-2775: quiesce the background writers BEFORE taking the write
        // lock. Everything below rides on one fact — every write in this process
        // goes through the SAME better-sqlite3 handle (`databaseService` shares
        // it with `db/core/dbConnection` via `setDb`), so a write from anywhere
        // during this window silently JOINS this transaction and is rolled back
        // with it. Rollback is the normal path here, not an exceptional one.
        //
        // Two main-process timers write on that handle every 60 seconds:
        //   - auditService's cloud sync -> markAuditLogsSynced (DROP TRIGGER +
        //     UPDATE audit_logs SET synced_at + CREATE TRIGGER). A rollback
        //     erases the synced_at marks of rows already uploaded, so they
        //     re-upload; any audit_logs row written in the window vanishes
        //     locally while its cloud copy survives.
        //   - submissionSyncService's poll -> updateTransactionSubmissionStatus.
        //
        // An earlier version of this comment claimed the exposure was bounded
        // because "the orchestrator serializes syncs and the worker pool is
        // read-only". Both are true and both describe only the RENDERER queue;
        // neither says anything about these two main-process timers.
        resumeBackgroundWriters = await this.quiesceBackgroundWriters();
        forceQuiesced = true;

        // IMMEDIATE takes the write lock now rather than on first write, so a
        // conflicting writer fails here — before the clear — instead of halfway
        // through.
        appDb.exec("BEGIN IMMEDIATE");
        forceTxnOpen = true;
        forceTxnBegun = true;

        logService.info(
          `Force reimport: clearing existing macOS messages (atomic — rolls back unless the re-import completes)`,
          MacOSMessagesImportService.SERVICE_NAME
        );
        const cleared = await this.clearMacOSMessages(userId, onProgress);
        if (!cleared) {
          // Cancelled mid-clear. Safe now, and it was not before: the delete is
          // uncommitted, so the `finally` rolls it back.
          logService.warn(
            "Force reimport cancelled during the clear phase — rolling back",
            MacOSMessagesImportService.SERVICE_NAME
          );
          return rollbackAndReturn();
        }
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
      const dbClose = db.close;

      try {
        // TASK-1952 / BACKLOG-2276: Calculate Apple epoch cutoff for date range filter.
        // macOS Messages stores dates as nanoseconds since 2001-01-01 (Apple epoch).
        // The cutoff is the EARLIER of the lookbackMonths window and the transaction
        // audit-period start (filters.auditPeriodStart) so a wide audit period is not
        // silently truncated — mirroring the email fetch, which filters by the
        // audit-period start.
        const appleDateCutoffNano: number | null = computeImportCutoffNano(filters);
        if (appleDateCutoffNano !== null) {
          const cutoffDate = new Date(MAC_EPOCH + appleDateCutoffNano / 1000000);
          logService.info(
            `Date filter: cutoff ${cutoffDate.toISOString()} ` +
              `(lookbackMonths=${filters?.lookbackMonths ?? "none"}, ` +
              `auditPeriodStart=${
                filters?.auditPeriodStart
                  ? new Date(filters.auditPeriodStart).toISOString()
                  : "none"
              })`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        // Build date filter clause for SQL queries
        const dateFilterClause = appleDateCutoffNano !== null
          ? `AND message.date > ${appleDateCutoffNano}`
          : "";

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

        // BACKLOG-2276: Apply the maxMessages cap to determine the target count.
        // When an audit period drives the window, completeness is the core product
        // guarantee, so the perf cap must NOT truncate the audit window at all —
        // an audit that is missing its oldest months is as wrong as one missing its
        // newest. In that case we import the full audit window and warn instead of
        // truncating. The cap still applies to casual, lookback-only imports (no
        // audit period active), and BACKLOG-2744 made that cap keep the NEWEST N —
        // see the window-start query below.
        const maxMessages = filters?.maxMessages ?? null;
        const auditPeriodActive = !!filters?.auditPeriodStart;
        const capApplies = !auditPeriodActive && maxMessages !== null && maxMessages > 0;
        const capWouldTruncate = capApplies && filteredMessageCount > (maxMessages as number);
        if (
          auditPeriodActive &&
          maxMessages !== null &&
          maxMessages > 0 &&
          filteredMessageCount > maxMessages
        ) {
          logService.warn(
            `Audit-period window has ${filteredMessageCount} messages, exceeding the ${maxMessages} cap — ` +
              `importing the FULL audit window for completeness (cap relaxed; not truncating newest-first)`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }

        // BACKLOG-2744: when the cap bites, keep the NEWEST N — not the oldest.
        //
        // The fetch further down is keyset pagination cursored on ROWID ASC, so
        // stopping once `targetMessageCount` rows have been read walks ROWID upward
        // from 0 and keeps the OLDEST N: the archive, where the Settings copy
        // promises "most recent". Do NOT fix this by flipping the ORDER BY — the
        // ascending ROWID order IS the pagination cursor, and reversing it breaks
        // the batching. Instead, find the ROWID of the Nth-newest importable row
        // and start the forward walk there. The loop, dedup and attachment logic
        // are untouched.
        //
        // Two things make this query's row set identical to the filtered COUNT
        // above, which is what the offset is taken against:
        //   - it reuses the same `dateFilterClause` string, so the two cannot drift;
        //   - it repeats `guid IS NOT NULL` and takes NO join. The count is
        //     join-free; joining chat_message_join here would let a message that
        //     belongs to two chats occupy two offset slots and land the window
        //     start on the wrong row.
        // ROWID is a unique integer primary key, so there are no ties to break, and
        // gaps are harmless: `lastRowId = startRowId - 1` with the strict `>` in the
        // fetch starts the walk exactly AT startRowId whether or not startRowId - 1
        // exists.
        //
        // THIS RUNS BEFORE THE TARGET COUNT IS DECIDED, AND THAT ORDER IS
        // LOAD-BEARING. The first version of this fix resolved the window start
        // AFTER `targetMessageCount` had already been pinned to `maxMessages`, so
        // the unresolved branch fell back to `lastRowId = 0` and still stopped at
        // `maxMessages` rows — walking from the beginning and keeping the OLDEST N.
        // It reproduced the exact defect this code exists to fix, behind a comment
        // asserting the opposite. Deciding the target from the RESOLVED window is
        // what makes the fallback mean what it says.
        let capWindowStartRowId: number | null = null;
        // Guarded on `capWouldTruncate` as a PERFORMANCE skip, not for correctness.
        // Widening it to `capApplies` would run one extra query whose OFFSET is out
        // of range whenever the cap cannot truncate, and change nothing else:
        // `capWindowUnresolved` below is gated on `capWouldTruncate` too, so a null
        // from that wasted query informs nothing. Do not read this guard as the
        // thing that keeps the fallback from misfiring — that is the gating below.
        if (capWouldTruncate) {
          const startRowResult = await dbAll<{ start_rowid: number }>(`
            SELECT message.ROWID as start_rowid
            FROM message
            WHERE message.guid IS NOT NULL
              ${dateFilterClause}
            ORDER BY message.ROWID DESC
            LIMIT 1 OFFSET ?
          `, [(maxMessages as number) - 1]);

          capWindowStartRowId = startRowResult[0]?.start_rowid ?? null;
        }

        // The cap is honoured only when we know where its window starts. If the
        // window start cannot be resolved we import the FULL filtered window —
        // more recent history than the user asked for, which they never notice —
        // rather than silently handing them the archive.
        //
        // Reachable in at least two ways, neither of them a throw: each `all()` is
        // its own read against a live WAL-mode chat.db that Messages is writing to,
        // so a bulk prune between the filtered COUNT above and this query drops the
        // row count below `maxMessages` and sends OFFSET out of range; and the
        // `dbAll<{ start_rowid: number }>` cast is unchecked, so a renamed column
        // alias would yield `undefined` here rather than raising.
        const capWindowUnresolved = capWouldTruncate && capWindowStartRowId === null;
        const importWasCapped = capWouldTruncate && !capWindowUnresolved;
        const targetMessageCount = importWasCapped
          ? (maxMessages as number)
          : filteredMessageCount;

        if (capWindowUnresolved) {
          // ERROR, not warn: this is the silent-wrong-data class. The import still
          // completes and still contains everything the user asked for, but the
          // reason it ignored their cap has to be visible in a support trace
          // without anyone reasoning about ROWIDs. `cap_window_unresolved` in the
          // supportTrace payload below carries the same signal.
          logService.error(
            `Cap of ${maxMessages} applies but the window-start ROWID could not be resolved — ` +
              `importing the FULL filtered window of ${filteredMessageCount} messages instead of the newest ${maxMessages}. ` +
              `The cap is NOT applied; the newest messages are present.`,
            MacOSMessagesImportService.SERVICE_NAME,
            { filteredMessageCount, maxMessages }
          );
        } else if (capWindowStartRowId !== null) {
          logService.info(
            `Cap of ${maxMessages} applies: starting at ROWID ${capWindowStartRowId} to keep the NEWEST ${maxMessages} messages`,
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
        // BACKLOG-2744: seeded one below the window start so the strict `>` in the
        // fetch includes startRowId itself. Uncapped imports still start at 0.
        let lastRowId = capWindowStartRowId !== null ? capWindowStartRowId - 1 : 0;
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
              // The clear is uncommitted now, so the `finally` restores every
              // message it deleted and the flag says so.
              rolledBack: forceTxnOpen || undefined,
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
        const attachments = filters?.skipAttachments
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
        const messageResult = await this.storeMessages(userId, allMessages, chatMembersMap, chatAccountMap, onProgress);

        // Store attachments (TASK-1012)
        const attachmentResult = await this.storeAttachments(userId, attachments, messageResult.messageIdMap, onProgress);

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
          audit_period_active: auditPeriodActive,
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

        // BACKLOG-2775: the force path's decision point. A cancel that landed
        // after the query phase leaves the message and attachment loops via
        // `break`, arriving here with partial counts — which a DELTA import
        // keeps, and a FORCE re-import must not: its transaction still holds the
        // deletion of everything the user had, so committing partial counts is
        // precisely the data loss this item exists to prevent. Fall through to
        // the `finally` with the transaction open and it rolls back instead.
        if (forceTxnOpen && this.abortController?.signal.aborted) {
          logService.warn(
            `Force reimport cancelled after ${messageResult.stored} messages — rolling back to the pre-import state`,
            MacOSMessagesImportService.SERVICE_NAME
          );
          await dbClose();
          return rollbackAndReturn();
        }

        // Send final 100% progress to update UI
        onProgress?.({
          phase: "importing",
          current: allMessages.length,
          total: allMessages.length,
          percent: 100,
        });

        // BACKLOG-2775: the re-import finished, so the clear it was paired with
        // is finally allowed to become real. Committing here — and nowhere
        // earlier — is the whole property: until this line runs, every exit
        // path restores the messages the user already had.
        if (forceTxnOpen && appDb) {
          appDb.exec("COMMIT");
          forceTxnOpen = false;
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
          // BACKLOG-2743: success stays TRUE here on purpose. By the time the
          // attachment pre-flight runs the messages are already stored, so a
          // false would render "Import failed" over a genuinely successful
          // message import. The refusal is reported as its own fact.
          attachmentsRefusedForSpace: attachmentResult.refusedForSpace,
          attachmentsSkippedByChoice: filters?.skipAttachments || undefined,
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

      // A thrown error is a declared rollback exit: the `finally` is about to
      // discard the clear, and this result already says so via `rolledBack`.
      forceRollbackDeclared = true;
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsUpdated: 0,
        attachmentsSkipped: 0,
        duration,
        error: errorMessage,
        // BACKLOG-2775: a force run that threw discarded its clear too — the
        // `finally` below is about to roll it back — so the failure card must
        // not leave the user believing their messages are gone.
        rolledBack: forceTxnOpen || undefined,
      };
    } finally {
      // BACKLOG-2775: the sole rollback. Reached by every exit that did not
      // COMMIT — cancel before the clear, cancel during it, cancel after the
      // query phase, a thrown error, a crash of this function. `inTransaction`
      // is re-read rather than trusted from `forceTxnOpen` alone because
      // ROLLBACK with no active transaction throws, and a throw in a `finally`
      // would replace the real result with a rollback error.
      // BACKLOG-2775 structural guard. Reaching the `finally` with the
      // transaction still open and NO exit having declared a rollback means new
      // code returned from inside the try without knowing a transaction was
      // open — so the store is about to be rolled back under a result that
      // probably claims success. Roll back anyway (the data comes first), then
      // fail loudly rather than hand back that result.
      //
      // Both conditions below ask the CONNECTION whether a transaction is open,
      // rather than trusting `forceTxnOpen` — which is cleared on the line after
      // the COMMIT, so a commit that silently no-opped would skip the rollback
      // entirely. (A real better-sqlite3 COMMIT either commits or throws, and a
      // throw leaves `forceTxnOpen` true, so this is hardening against a future
      // shape rather than a bug that shipped.)
      //
      // `forceTxnBegun` is the other half: it distinguishes "our transaction" —
      // this run ran BEGIN — from a transaction someone else opened, which the
      // BEGIN-site guard deliberately refuses to touch.
      const ourTransactionIsOpen = forceTxnBegun && !!appDb?.inTransaction;
      const undeclaredExit = ourTransactionIsOpen && !forceRollbackDeclared;

      if (ourTransactionIsOpen) {
        try {
          appDb.exec("ROLLBACK");
          logService.info(
            "Force reimport rolled back — the message store is unchanged",
            MacOSMessagesImportService.SERVICE_NAME
          );
        } catch (rollbackError) {
          // Nothing here can be repaired in-process, but it must be visible:
          // this is the one path where the store could be left cleared.
          logService.error(
            `Force reimport ROLLBACK failed: ${
              rollbackError instanceof Error ? rollbackError.message : "Unknown error"
            }`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }
      }

      // BACKLOG-2775: restart the background writers, after the transaction has
      // been resolved either way. Ordered after the rollback deliberately — a
      // timer that fired between the ROLLBACK and here would write outside the
      // transaction, which is correct, but one that fired BEFORE the rollback
      // would be discarded by it.
      if (forceQuiesced) {
        forceQuiesced = false;
        try {
          resumeBackgroundWriters();
        } catch (resumeError) {
          // A failure here leaves cloud sync stopped until the next app start.
          // It must be loud: the app looks fine and silently stops syncing.
          logService.error(
            `Failed to resume background sync after force reimport: ${
              resumeError instanceof Error ? resumeError.message : "Unknown error"
            }`,
            MacOSMessagesImportService.SERVICE_NAME
          );
        }
      }

      // Thrown last, after the rollback and the resume, so the guard cannot
      // leave the transaction open or the timers stopped. Throwing from a
      // `finally` discards whatever the try was returning — which is the point:
      // that result described a store this rollback has just undone.
      if (undeclaredExit) {
        logService.error(
          "Force reimport returned with its transaction still open and no rollback declared — the run was rolled back and the result discarded",
          MacOSMessagesImportService.SERVICE_NAME
        );
        throw new Error(
          "Force re-import exited with an open transaction and no declared rollback: its result would have described data that was rolled back"
        );
      }
    }
  }

  /**
   * BACKLOG-2775: stop the main-process timers that write on the shared
   * database connection, and return the function that restarts exactly the ones
   * that were running.
   *
   * Stopping the intervals prevents NEW ticks. It cannot cancel a tick already
   * in flight — BOTH services await a network round trip before they write
   * (`auditService.syncToCloud` before `markAuditLogsSynced`,
   * `submissionSyncService.syncAllSubmissions` before
   * `updateTransactionSubmissionStatus`) — so this also waits, briefly, for
   * either to finish.
   *
   * KNOWN RESIDUALS, deliberately not fixed here (PM to file the follow-up).
   * This list is load-bearing: the round-1 review of this feature rejected a
   * comment that claimed a bound the code did not have, and a residual list
   * missing a residual is the same mistake in miniature.
   *   - Event-driven `insertAuditLog` writes can still land inside the window.
   *     For an audited action that was itself a database write this is coherent
   *     (the action and its audit row roll back together); for auth or export
   *     events it is not — the event happened, and its local audit row does not
   *     survive the rollback.
   *   - `submissionSyncService`'s REALTIME subscription writes by the same path
   *     as its poll tick, and neither the suspend nor the in-flight wait covers
   *     it. Unsubscribing and resubscribing a realtime channel is a heavier
   *     lifecycle change than this fix should make. Its write is a whole
   *     statement, never a torn one — better-sqlite3 is synchronous — so it
   *     joins the transaction and rolls back whole, then self-heals on the next
   *     poll.
   *   - If the in-flight wait times out, the run proceeds anyway. Refusing
   *     would be safe rather than dangerous — no clear runs and the store is
   *     untouched — so the trade is a single background sync mark that both
   *     services re-apply on their next tick, against refusing an action the
   *     user legitimately asked for.
   */
  private async quiesceBackgroundWriters(): Promise<() => void> {
    // Each suspend is recorded the moment it happens, and the resume closure is
    // built from that record. Suspending both first and building the closure
    // afterwards would mean a throw from the SECOND suspend leaves the first
    // timer stopped with nothing able to restart it — cloud sync silently off
    // for the life of the process. Both suspends are `clearInterval` wrappers,
    // so this is close to unreachable; the ordering costs nothing.
    const suspended: Array<() => void> = [];
    try {
      if (auditService.suspendPeriodicSync()) {
        suspended.push(() => auditService.resumePeriodicSync());
      }
      if (submissionSyncService.suspendPeriodicSync()) {
        suspended.push(() => submissionSyncService.resumePeriodicSync());
      }
      return await this.waitForQuietConnection(suspended);
    } catch (quiesceError) {
      // Undo whatever was suspended before rethrowing. The caller only records
      // `forceQuiesced` once this resolves, so anything thrown from here would
      // otherwise leave the timers stopped with nothing able to restart them —
      // cloud sync silently off for the life of the process. This covers the
      // second suspend AND the wait below, which is where it actually bit
      // during development.
      for (const resume of suspended) resume();
      throw quiesceError;
    }
  }

  /**
   * BACKLOG-2775: wait (bounded) for an in-flight background sync to finish, and
   * return the closure that restarts what was suspended.
   */
  private async waitForQuietConnection(
    suspended: Array<() => void>
  ): Promise<() => void> {
    // Bounded wait for a tick that was already mid-flight when the interval was
    // stopped: both services await a network round trip before they write, and
    // `clearInterval` cannot cancel one that is already in the air.
    const deadline = Date.now() + MacOSMessagesImportService.QUIESCE_TIMEOUT_MS;
    const stillWriting = () =>
      auditService.isSyncInFlight() || submissionSyncService.isSyncInFlight();
    while (stillWriting() && Date.now() < deadline) {
      // A sleep, not `yieldToEventLoop()` — that resolves on `setImmediate` and
      // would spin the check phase for up to five seconds to learn something
      // that changes at network speed.
      await new Promise((resolve) => setTimeout(resolve, MacOSMessagesImportService.QUIESCE_POLL_MS));
    }
    if (stillWriting()) {
      // Proceeding anyway is the deliberate choice. Refusing the re-import would
      // be SAFE — no clear runs, the store is untouched — so the trade is not
      // safety against danger: it is one background sync mark, which both
      // services re-apply on their next tick, against refusing a legitimate
      // action the user asked for. The self-healing side loses.
      logService.warn(
        "Force reimport starting while a background sync is still in flight — its write may be rolled back with the run, and re-applied on the next tick",
        MacOSMessagesImportService.SERVICE_NAME
      );
    }

    logService.info(
      `Background writers quiesced for force reimport (${suspended.length} of 2 were running)`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    return () => {
      // Restart ONLY what was actually running: starting a timer the app had
      // deliberately stopped would be this feature turning something on behind
      // the user's back.
      for (const resume of suspended) resume();
      logService.info(
        "Background writers resumed after force reimport",
        MacOSMessagesImportService.SERVICE_NAME
      );
    };
  }

  /**
   * BACKLOG-2775: the outcome of a force re-import that was stopped before it
   * committed — every count 0, because the transaction is about to be rolled
   * back and the store will be exactly what it was before the run.
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
    onProgress?: ImportProgressCallback
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

    const existingIds = new Set<string>();
    const existingRows = db
      .prepare(
        `
      SELECT external_id FROM messages
      WHERE user_id = ? AND external_id IS NOT NULL
    `
      )
      .all(userId) as { external_id: string }[];

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
      INSERT OR IGNORE INTO messages (
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
      UPDATE messages
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
            insertMessageStmt.run(
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
            messageIdMap.set(msg.guid, messageId);
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
    onProgress?: ImportProgressCallback
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
        `SELECT external_message_id, filename FROM attachments WHERE external_message_id IS NOT NULL`
      )
      .all() as { external_message_id: string; filename: string }[]) {
      const key = attachmentStoredKey(row.external_message_id, row.filename);
      if (key) alreadyStoredKeys.add(key);
    }

    // Messages stored by PREVIOUS runs. Combined with this run's messageIdMap,
    // these are the only messages an attachment can be linked to — anything else
    // is skipped by the copy loop without writing a byte.
    const existingMessageIdMap = new Map<string, string>();
    const existingMsgRows = db
      .prepare(`SELECT id, external_id FROM messages WHERE external_id IS NOT NULL`)
      .all() as { id: string; external_id: string }[];
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
      .prepare(`SELECT storage_path FROM attachments WHERE storage_path IS NOT NULL`)
      .all() as { storage_path: string }[];

    // Extract hash from storage path (filename is the hash)
    for (const row of existingHashRows) {
      const filename = path.basename(row.storage_path, path.extname(row.storage_path));
      existingHashes.add(filename);
    }

    // Load existing attachment records for deduplication (message_id + filename)
    const existingAttachmentRecords = new Set<string>();
    const existingAttachRows = db
      .prepare(`SELECT message_id, filename FROM attachments WHERE message_id IS NOT NULL`)
      .all() as { message_id: string; filename: string }[];

    for (const row of existingAttachRows) {
      existingAttachmentRecords.add(`${row.message_id}:${row.filename}`);
    }

    // TASK-1122: Load existing attachments by external_message_id for stable deduplication
    // This allows us to find and UPDATE attachments with stale message_ids after re-sync
    const existingByExternalId = new Map<string, { id: string; message_id: string }>();
    const existingExternalRows = db
      .prepare(`SELECT id, message_id, external_message_id, filename FROM attachments WHERE external_message_id IS NOT NULL`)
      .all() as { id: string; message_id: string; external_message_id: string; filename: string }[];

    for (const row of existingExternalRows) {
      // Key: external_message_id:filename for unique identification.
      // BACKLOG-2743: built by attachmentStoredKey so this and the pre-flight's
      // exclusion set cannot drift into two different spellings of one format.
      const externalIdKey = attachmentStoredKey(row.external_message_id, row.filename);
      if (!externalIdKey) continue;
      existingByExternalId.set(externalIdKey, {
        id: row.id,
        message_id: row.message_id,
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
      INSERT OR IGNORE INTO attachments (
        id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    // TASK-1122: Prepare update statement for fixing stale message_ids
    const updateMessageIdStmt = db.prepare(`
      UPDATE attachments SET message_id = ? WHERE id = ?
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
            updateMessageIdStmt.run(internalMessageId, existingByExternal.id);
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
   * Clear all macOS messages for a user (for force reimport)
   * Uses batched deletes with progress reporting to keep UI responsive
   *
   * DB ROWS ONLY — this deletes `messages` and `attachments` rows and never
   * touches attachment FILES on disk (BACKLOG-2775 verified: the only
   * filesystem calls on the import path are `mkdir`, `access`, `copyFile` and
   * reads; there is no `unlink` anywhere in the service). That is what makes
   * the transaction wrap sufficient: everything this destroys is inside the
   * database and comes back on ROLLBACK.
   *
   * @returns true when the clear completed, false when it stopped early because
   *   the user cancelled. Callers MUST treat false as "the deletion is partial
   *   and uncommitted" and roll back.
   */
  private async clearMacOSMessages(
    userId: string,
    onProgress?: ImportProgressCallback
  ): Promise<boolean> {
    const db = databaseService.getRawDatabase();

    // Count messages to delete
    const countResult = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND external_id IS NOT NULL`
      )
      .get(userId) as { count: number };

    const messageCount = countResult?.count || 0;

    if (messageCount === 0) {
      logService.info(
        `No existing macOS messages to clear`,
        MacOSMessagesImportService.SERVICE_NAME
      );
      return true;
    }

    logService.info(
      `Clearing ${messageCount} existing macOS messages and attachments`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    // Report initial progress
    onProgress?.({
      phase: "deleting",
      current: 0,
      total: messageCount,
      percent: 0,
    });

    // Delete attachments first (in one go - usually much fewer than messages)
    // Delete by message_id for currently-linked attachments
    const attachResult1 = db
      .prepare(
        `
      DELETE FROM attachments
      WHERE message_id IN (
        SELECT id FROM messages WHERE user_id = ? AND external_id IS NOT NULL
      )
    `
      )
      .run(userId);

    // Also delete orphaned attachments by external_message_id
    // This catches attachments from previous imports where message_id is now stale
    const attachResult2 = db
      .prepare(
        `
      DELETE FROM attachments
      WHERE external_message_id IN (
        SELECT external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL
      )
    `
      )
      .run(userId);

    const attachmentsDeleted = attachResult1.changes + attachResult2.changes;
    logService.info(
      `Deleted ${attachmentsDeleted} attachments (${attachResult1.changes} by message_id, ${attachResult2.changes} by external_id)`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    await yieldToEventLoop();

    // Create progress bar for delete
    const deleteProgressBar = createProgressBar("Deleting");
    deleteProgressBar.start(messageCount, 0);

    // Delete messages in batches to keep UI responsive
    let totalDeleted = 0;
    const deleteStmt = db.prepare(`
      DELETE FROM messages
      WHERE id IN (
        SELECT id FROM messages
        WHERE user_id = ? AND external_id IS NOT NULL
        LIMIT ?
      )
    `);

    while (totalDeleted < messageCount) {
      // BACKLOG-2775: honour the cancel DURING the clear, not merely between
      // phases. The founder's 162,961-message clear took ~35 seconds and his
      // cancel was already in when it started; the flag was next read after the
      // delete had finished. Stopping here is only safe because the deletion is
      // uncommitted — the caller rolls it back.
      if (this.abortController?.signal.aborted) {
        deleteProgressBar.stop();
        logService.warn(
          `Clear phase cancelled at ${totalDeleted}/${messageCount} — rolling back`,
          MacOSMessagesImportService.SERVICE_NAME
        );
        return false;
      }

      const result = deleteStmt.run(userId, DELETE_BATCH_SIZE);
      totalDeleted += result.changes;

      // Update progress bar
      deleteProgressBar.update(totalDeleted);

      // Report progress to UI
      const percent = Math.round((totalDeleted / messageCount) * 100);
      onProgress?.({
        phase: "deleting",
        current: totalDeleted,
        total: messageCount,
        percent,
      });

      // Yield to event loop
      await yieldToEventLoop();

      // If no rows were deleted, we're done
      if (result.changes === 0) break;
    }

    // Stop progress bar
    deleteProgressBar.stop();

    logService.info(
      `Cleared ${totalDeleted} messages`,
      MacOSMessagesImportService.SERVICE_NAME
    );

    return true;
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
  async getAvailableMessageCount(filters?: MessageImportFilters): Promise<{
    success: boolean;
    count?: number;
    filteredCount?: number;
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
      const dbClose = db.close;

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
        let filteredCount = totalCount;
        const appleDateCutoffNano = computeImportCutoffNano(filters);
        if (appleDateCutoffNano !== null) {
          const filteredResult = await dbGet(`
            SELECT COUNT(*) as count FROM message
            WHERE guid IS NOT NULL AND date > ${appleDateCutoffNano}
          `);
          filteredCount = filteredResult?.count || 0;
        }

        // BACKLOG-2743: Size the attachment copy for the SAME window, before any
        // byte is copied. Every figure needed is queryable from chat.db up front;
        // previously nothing on this path looked at attachment size at all, so a
        // library whose attachments exceeded the disk was discovered only by
        // running out of space partway through the copy.
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
          appleDateCutoffNano !== null
            ? `WHERE message.guid IS NOT NULL AND attachment.filename IS NOT NULL AND message.date > ${appleDateCutoffNano}`
            : `WHERE message.guid IS NOT NULL AND attachment.filename IS NOT NULL`;
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
