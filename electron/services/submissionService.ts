/**
 * Transaction Submission Service (BACKLOG-394)
 *
 * Handles pushing complete transaction data from local SQLite to Supabase cloud
 * for broker review in the B2B portal.
 *
 * Flow:
 * 1. Load local data (transaction, messages, attachments)
 * 2. Upload attachments to Storage (via supabaseStorageService)
 * 3. Insert transaction_submission record
 * 4. Insert submission_messages records
 * 5. Insert submission_attachments records
 * 6. Update local submission_status
 *
 * @see BACKLOG-394 for full design
 */

import * as crypto from "crypto";
import * as os from "os";
import { app, net } from "electron";
import supabaseService from "./supabaseService";
/**
 * BACKLOG-2868 — the refusal copy is CANONICAL in its own module because the
 * renderer needs the same words and cannot import this file. See that module's
 * header for why a plain shared import is impossible across the boundary, and
 * for the parity test that keeps the renderer's mirror honest.
 */
import {
  BLOCKED_SUBMISSION_STATUSES,
  BLOCKED_SUBMISSION_MESSAGES,
  type BlockedSubmissionStatus,
} from "./submissionStatusMessages";
import supabaseStorageService, {
  LocalAttachment,
  AttachmentUploadResult,
} from "./supabaseStorageService";
import databaseService from "./databaseService";
import logService from "./logService";
import emailAttachmentService from "./emailAttachmentService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import { TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL } from "./db/submissionEmailSql";
// BACKLOG-2758 finding 3: party names come from the SAME resolver the exported
// PDF uses, not from a second read of the macOS AddressBook. The AddressBook is
// still consulted — as tier 3 inside that resolver — so no name previously
// resolved is lost; it simply stops being an independent answer that could
// disagree with the archived artifact.
import {
  resolveHandles,
  extractParticipantHandles,
  nameForHandle,
  type HandleNameResolution,
} from "./contactResolutionService";
import type {
  Transaction,
  Message,
  Attachment,
  SubmissionStatus,
} from "../types/models";

/** Contact name map from phone/email to display name */

// ============================================
// TYPES & INTERFACES
// ============================================

/** Result of a submission operation */
export interface SubmissionResult {
  success: boolean;
  submissionId: string | null;
  error?: string;
  attachmentsFailed: number;
  messagesCount: number;
  attachmentsCount: number;
}

/** Progress stages for submission flow */
export type SubmissionStage =
  | "preparing"
  | "attachments"
  | "transaction"
  | "messages"
  | "complete"
  | "failed";

/** Progress callback data */
export interface SubmissionProgress {
  stage: SubmissionStage;
  stageProgress: number; // 0-100 within current stage
  overallProgress: number; // 0-100 total
  currentItem?: string;
}

/** Record structure for transaction_submissions table */
interface SubmissionRecord {
  id: string;
  organization_id: string;
  submitted_by: string;
  local_transaction_id: string;
  property_address: string;
  property_city?: string;
  property_state?: string;
  property_zip?: string;
  transaction_type: string;
  listing_price?: number;
  sale_price?: number;
  started_at?: string;
  closed_at?: string;
  status: string;
  version: number;
  parent_submission_id?: string;
  message_count: number;
  attachment_count: number;
  submission_metadata?: Record<string, unknown>;
}

/** Record structure for submission_messages table */
interface SubmissionMessageRecord {
  submission_id: string;
  local_message_id: string;
  channel: string;
  direction: string;
  subject?: string;
  body_text?: string;
  participants?: Record<string, unknown>;
  sent_at?: string;
  thread_id?: string;
  has_attachments: boolean;
  attachment_count: number;
  /** Message type: text, voice_message, location, attachment_only, system, unknown */
  message_type?: string;
}

/** Record structure for submission_attachments table */
interface SubmissionAttachmentRecord {
  submission_id: string;
  filename: string;
  mime_type?: string;
  file_size_bytes?: number;
  storage_path: string;
  document_type?: string;
}

/** Cloud submission status response */
interface CloudSubmissionStatus {
  id: string;
  status: string;
  review_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;
}

// ============================================
// CONSTANTS
// ============================================

const MESSAGE_BATCH_SIZE = 50;

// ============================================
// SERVICE CLASS
// ============================================

class SubmissionService {
  /** Track whether a submission is currently in progress */
  private _isSubmitting = false;

  /** Check if a submission is currently in progress */
  get isSubmitting(): boolean {
    return this._isSubmitting;
  }

  /**
   * Submit a transaction for broker review
   *
   * @param transactionId - Local transaction ID
   * @param onProgress - Progress callback
   * @returns Submission result with cloud submission ID
   */
  async submitTransaction(
    transactionId: string,
    onProgress?: (progress: SubmissionProgress) => void
  ): Promise<SubmissionResult> {
    return this.submitTransactionInternal(transactionId, undefined, onProgress);
  }

  /**
   * Resubmit a transaction (creates new version)
   *
   * @param transactionId - Local transaction ID
   * @param onProgress - Progress callback
   * @returns Submission result with new submission ID
   */
  async resubmitTransaction(
    transactionId: string,
    onProgress?: (progress: SubmissionProgress) => void
  ): Promise<SubmissionResult> {
    const transaction = await this.loadTransaction(transactionId);

    if (!transaction.submission_id) {
      throw new Error("Transaction has not been submitted before");
    }

    // Get current version from cloud
    const client = supabaseService.getClient();
    const { data: existingSubmission, error } = await client
      .from("transaction_submissions")
      .select("version")
      .eq("id", transaction.submission_id)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found"
      throw new Error(`Failed to get existing submission: ${error.message}`);
    }

    const newVersion = (existingSubmission?.version || 1) + 1;

    return this.submitTransactionInternal(
      transactionId,
      {
        version: newVersion,
        parentSubmissionId: transaction.submission_id,
      },
      onProgress
    );
  }

  /**
   * Get submission status from cloud
   *
   * @param submissionId - Cloud submission ID
   * @returns Current status and review info
   */
  async getSubmissionStatus(
    submissionId: string
  ): Promise<CloudSubmissionStatus | null> {
    try {
      const client = supabaseService.getClient();
      const { data, error } = await client
        .from("transaction_submissions")
        .select("id, status, review_notes, reviewed_by, reviewed_at")
        .eq("id", submissionId)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return null; // Not found
        }
        throw error;
      }

      return data;
    } catch (error) {
      logService.error(
        `[Submission] Failed to get status for ${submissionId}`,
        "SubmissionService",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
      throw error;
    }
  }

  /**
   * Internal submission implementation
   */
  private async submitTransactionInternal(
    transactionId: string,
    options?: {
      version?: number;
      parentSubmissionId?: string;
    },
    onProgress?: (progress: SubmissionProgress) => void
  ): Promise<SubmissionResult> {
    const submissionId = crypto.randomUUID();
    let attachmentUploadResults: AttachmentUploadResult[] = [];

    this._isSubmitting = true;
    try {
      // Stage 1: Prepare (10%)
      onProgress?.({
        stage: "preparing",
        stageProgress: 0,
        overallProgress: 0,
        currentItem: "Loading transaction data...",
      });

      const transaction = await this.loadTransaction(transactionId);

      // Parse audit period dates from transaction
      const auditStartDate = transaction.started_at
        ? new Date(transaction.started_at)
        : null;
      const auditEndDate = transaction.closed_at
        ? new Date(transaction.closed_at)
        : null;

      // Load messages and emails filtered by audit period
      const messages = await this.loadTransactionMessages(
        transactionId,
        auditStartDate,
        auditEndDate
      );
      const emails = await this.loadTransactionEmails(
        transactionId,
        auditStartDate,
        auditEndDate
      );
      const attachments = await this.loadTransactionAttachments(
        transactionId,
        auditStartDate,
        auditEndDate
      );
      const orgId = await this.getUserOrganizationId();
      const currentUserId = await this.getCurrentUserId();

      // Load contact names for phone number resolution.
      // BACKLOG-2757/2758: one resolver, scoped to this user and this
      // transaction, returning the same honest label the PDF prints — including
      // "A or B" when a handle names more than one contact. The portal and the
      // archived PDF now cannot name the same party differently.
      let partyNames: HandleNameResolution = { names: {}, matches: {} };
      try {
        partyNames = await resolveHandles(
          extractParticipantHandles(messages),
          currentUserId,
          { userId: currentUserId, transactionId }
        );
        logService.info(
          `[Submission] Resolved ${Object.keys(partyNames.names).length} handle keys for name resolution`,
          "SubmissionService"
        );
      } catch (err) {
        logService.warn(
          `[Submission] Could not resolve party names: ${err instanceof Error ? err.message : "Unknown error"}`,
          "SubmissionService"
        );
      }

      if (!orgId) {
        throw new Error("User is not a member of any organization");
      }

      // Check for existing submission
      const client = supabaseService.getClient();

      /**
       * The version this attempt will INSERT. Mirrors `mapToSubmission`, which
       * writes `version: options?.version || 1` — the two must agree, because
       * the delete below is keyed off the comparison.
       */
      const pendingVersion = options?.version || 1;

      /**
       * BACKLOG-2867 — NAME ONE ROW, AND READ THE ERROR.
       *
       * This lookup used to be
       *
       *   const { data: existingSubmission } = await client
       *     .from("transaction_submissions")
       *     .select("id, status")
       *     .eq("organization_id", orgId)
       *     .eq("local_transaction_id", transactionId)
       *     .maybeSingle();
       *
       * — no ordering, no limit, and the `error` not destructured at all.
       *
       * A deal that has been round-tripped once has TWO rows here: the unique
       * key is (organization_id, local_transaction_id, version, submitted_by),
       * so versions coexist legally, and the versioning path deliberately
       * retains its parent. `.maybeSingle()` against two rows makes PostgREST
       * answer PGRST116 with `data: null` — and with the error discarded, that
       * is indistinguishable from "this deal has never been submitted".
       * `if (existingSubmission)` was false and the entire status guard below
       * was skipped, on exactly the deals furthest along: measured live on
       * 2026-08-25, one transaction sat at versions [1, 2] / statuses
       * [rejected, under_review] and was unguarded.
       *
       * Both halves are needed, and each is proved by its own control:
       *
       *   ORDER BY version DESC LIMIT 1 — decide against the CURRENT version.
       *     Secondary order on created_at because the unique key permits a
       *     version tie between two submitters in one org; without it the row
       *     the database happens to return first would decide the guard.
       *
       *   The ERROR, read and refused on. With `limit(1)` a multi-row PGRST116
       *     can no longer occur, so there is no "no rows" case left to
       *     tolerate: `data: null` means no submission exists, and an `error`
       *     means the question could not be answered. Failing closed is the
       *     point — the alternative is what this item is about, a failed check
       *     read as a clean bill of health.
       */
      const { data: existingSubmission, error: existingSubmissionError } =
        await client
          .from("transaction_submissions")
          .select("id, status, version")
          .eq("organization_id", orgId)
          .eq("local_transaction_id", transactionId)
          .order("version", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

      if (existingSubmissionError) {
        logService.error(
          `[Submission] Existing-submission check failed for ${transactionId} — refusing to submit`,
          "SubmissionService",
          {
            code: existingSubmissionError.code ?? null,
            message: existingSubmissionError.message,
          }
        );
        throw new Error(
          `Could not check whether this transaction has already been submitted, so nothing was submitted. Please try again. (${existingSubmissionError.message})`
        );
      }

      if (existingSubmission) {
        /**
         * BACKLOG-2853 — `submitted` IS BLOCKED. This list is the whole item.
         *
         * Until this change the list was
         * ["under_review", "approved", "rejected"], so a deal sitting at
         * `submitted` — awaiting the broker, nothing wrong with it — fell
         * through to the delete below, whose own comment advertises that it
         * "cascades to messages and attachments". The renderer offered that
         * path an unqualified, enabled "Submit" button (SubmitForReviewModal
         * computed `isResubmit` from `needs_changes` alone), so one mis-click
         * on Complete → Submit aimed a cascading delete at a live submission.
         *
         * WHAT THE DATABASE ACTUALLY DOES TODAY — measured against the live
         * Keepr project (`pg_policies`, `pg_class`), not read off the
         * migration files, because it changes what this guard is FOR:
         *
         *   transaction_submissions: relrowsecurity = true,
         *                            relforcerowsecurity = true
         *   the only agent-facing DELETE policy is
         *     agents_can_delete_stale_uploads
         *     USING ((submitted_by = auth.uid())
         *            AND (status::text = 'uploading'::text))
         *
         * The desktop client holds the ANON key plus the user session
         * (supabaseService.ts — "never fall back to service_role key"), so
         * that policy governs it. A DELETE aimed at a `submitted` row matches
         * no row, PostgREST returns 204, and the result below is not checked
         * anyway. The cascade never fires. The destruction is real in THIS
         * FILE and is prevented by the database.
         *
         * So what a user hit instead was a LATE failure: the delete no-ops,
         * then the attachment upload runs — the longest stage — and only then
         * does the insert violate the live unique key
         *   UNIQUE (organization_id, local_transaction_id, version,
         *           submitted_by)
         * with a duplicate-key error, having already pushed files to Storage
         * under a submission id that will never exist. This check runs BEFORE
         * that upload, so blocking here replaces a multi-minute walk to a
         * confusing error with an immediate, accurate refusal.
         *
         * And it is the ONLY application-layer guard: `service_role_full_access_submissions`
         * grants ALL on this table and is live, so any service-role caller
         * that ever reaches this code is not covered by the RLS that covers
         * the desktop today.
         *
         * `resubmitted` is deliberately NOT in the list. BACKLOG-2853 justified
         * that with "it carries the identical hazard one broker round trip
         * later" — WRONG, and withdrawn. It was then argued that adding the
         * word would change nothing, because a `resubmitted` row only exists
         * at version >= 2, two rows share `(organization_id,
         * local_transaction_id)`, and the old single-row lookup returned
         * PGRST116 so execution never arrived here at all.
         *
         * BACKLOG-2867 FIXED THAT LOOKUP, so that argument is now spent too:
         * a `resubmitted` deal DOES reach this check. It is still not on the
         * list, and it still must not fall into a delete — which is why the
         * branch below now refuses to delete a row at a version this attempt
         * is not replacing. Whether `resubmitted` belongs on the list is a
         * separate decision, deliberately not taken here; see
         * `submissionStatusMessages.ts`.
         *
         * BACKLOG-2868 — THE LIST AND THE MESSAGES NOW LIVE IN THEIR OWN
         * MODULE. Not for tidiness: the renderer must tell the user the same
         * thing this throw does, cannot import this file, and drifted the
         * moment it had to write the words a second time. The modal's mirror
         * is pinned to these strings by a parity test.
         */
        if (
          (BLOCKED_SUBMISSION_STATUSES as readonly string[]).includes(
            existingSubmission.status
          )
        ) {
          throw new Error(
            BLOCKED_SUBMISSION_MESSAGES[
              existingSubmission.status as BlockedSubmissionStatus
            ] || `Cannot resubmit with status: ${existingSubmission.status}`
          );
        }

        /**
         * BACKLOG-2853 — THE VERSIONING PATH NEVER DELETES ITS OWN PARENT.
         *
         * `resubmitTransaction` reads the current version, adds one, and calls
         * this method with `parentSubmissionId` set to the row it is
         * versioning FROM — the same row `existingSubmission` names here. The
         * delete below would therefore have destroyed the parent, and the
         * insert that follows carries
         *   parent_submission_id -> that id
         * against a foreign key that is plain
         *   FOREIGN KEY (parent_submission_id)
         *   REFERENCES transaction_submissions(id)
         * with NO ON DELETE clause (verified live via pg_constraint). Had the
         * delete ever succeeded, the resubmit would have destroyed the
         * original AND then failed its own insert on that FK — losing the
         * broker's review round trip outright.
         *
         * It has not fired in production only because the RLS policy quoted
         * above no-ops the delete; the broker round trip works today by
         * accident of the database, not by intent of this code. Skipping the
         * delete when a version is being created makes the intent explicit and
         * is what "needs_changes reaches the versioning path, never the delete
         * branch" means. The unique key includes `version`, so the old and new
         * rows coexist legally — nothing forces the delete.
         *
         * Production behaviour is unchanged by this branch: the delete it
         * skips was already a no-op for every status that reaches it.
         */
        const existingVersion: number = existingSubmission.version ?? 1;

        if (options?.parentSubmissionId) {
          logService.info(
            `[Submission] Versioning from submission ${existingSubmission.id} (status: ${existingSubmission.status}) — previous version retained`,
            "SubmissionService"
          );
        } else if (existingVersion !== pendingVersion) {
          /**
           * BACKLOG-2867 — THE DELETE MAY ONLY REMOVE THE ROW THIS INSERT
           * WOULD COLLIDE WITH.
           *
           * This condition exists because of the fix above, not despite it.
           * Before it, the lookup could not name a row on a multi-version
           * deal, so this branch was unreachable there. Now that the lookup
           * names the CURRENT version, a plain `submitTransaction` on a
           * round-tripped deal arrives here holding version 2 while about to
           * insert version 1 — and would have deleted the live submission.
           * Under the desktop's RLS that delete no-ops, but
           * `service_role_full_access_submissions` is live on this table and
           * grants ALL, and under it the row and its cascaded messages and
           * attachments are gone and the version-1 insert then fails on the
           * unique key anyway. Destruction with nothing to show for it, newly
           * reachable, caused by a fix. Closed here rather than shipped.
           *
           * What the delete is FOR is clearing
           *   UNIQUE (organization_id, local_transaction_id, version,
           *           submitted_by)
           * for the row about to be inserted at `pendingVersion`. A row at any
           * OTHER version does not block that insert, so deleting it buys
           * nothing and costs a submission.
           *
           * Every path that reached the delete before BACKLOG-2867 reached it
           * at equal versions, so production behaviour is unchanged.
           */
          logService.warn(
            `[Submission] Existing submission ${existingSubmission.id} is at version ${existingVersion} but this submit inserts version ${pendingVersion} — leaving it in place`,
            "SubmissionService"
          );
        } else {
          // Allowed to replace (status is 'resubmitted' or 'needs_changes')
          logService.info(
            `[Submission] Replacing existing submission ${existingSubmission.id} (status: ${existingSubmission.status}) at version ${existingVersion}`,
            "SubmissionService"
          );
          // Delete old submission (cascades to messages and attachments)
          await client
            .from("transaction_submissions")
            .delete()
            .eq("id", existingSubmission.id);
        }
      }

      const totalMessageCount = messages.length + emails.length;
      onProgress?.({
        stage: "preparing",
        stageProgress: 100,
        overallProgress: 10,
        currentItem: `Found ${messages.length} texts, ${emails.length} emails, ${attachments.length} attachments`,
      });

      // Stage 2: Upload attachments (30%)
      if (attachments.length > 0) {
        onProgress?.({
          stage: "attachments",
          stageProgress: 0,
          overallProgress: 10,
          currentItem: `Uploading ${attachments.length} attachments...`,
        });

        const localAttachments: LocalAttachment[] = attachments.map((a) => ({
          id: a.id,
          localPath: a.storage_path || "",
          filename: a.filename,
        }));

        const uploadResult = await supabaseStorageService.uploadAttachments(
          orgId,
          submissionId,
          localAttachments,
          (overallPct, current) => {
            onProgress?.({
              stage: "attachments",
              stageProgress: overallPct,
              overallProgress: 10 + overallPct * 0.3,
              currentItem: `Uploading ${current.filename}...`,
            });
          }
        );

        attachmentUploadResults = uploadResult.results;

        if (uploadResult.failedCount > 0) {
          logService.warn(
            `[Submission] ${uploadResult.failedCount} attachments failed to upload`,
            "SubmissionService"
          );
        }
      }

      // Stage 3: Insert transaction submission (20%)
      onProgress?.({
        stage: "transaction",
        stageProgress: 0,
        overallProgress: 40,
        currentItem: "Creating submission record...",
      });

      const submissionRecord = this.mapToSubmission(
        transaction,
        orgId,
        currentUserId,
        submissionId,
        totalMessageCount,
        attachmentUploadResults.filter((r) => r.success).length,
        options
      );

      // Two-phase commit: insert as 'uploading' first, then finalize to 'submitted'
      // after all messages and attachments are written. This prevents partial
      // submissions from being visible on the broker portal if the app crashes mid-upload.
      submissionRecord.status = "uploading";

      // Clean up any stale 'uploading' record from a previous failed attempt
      // (same org + local transaction = unique constraint)
      const { data: staleRows } = await client
        .from("transaction_submissions")
        .select("id")
        .eq("organization_id", orgId)
        .eq("local_transaction_id", submissionRecord.local_transaction_id)
        .eq("status", "uploading");

      if (staleRows && staleRows.length > 0) {
        const staleIds = staleRows.map((r: { id: string }) => r.id);
        await client
          .from("submission_attachments")
          .delete()
          .in("submission_id", staleIds);
        await client
          .from("submission_messages")
          .delete()
          .in("submission_id", staleIds);
        await client
          .from("transaction_submissions")
          .delete()
          .in("id", staleIds);
      }

      const { error: insertError } = await client
        .from("transaction_submissions")
        .insert(submissionRecord);

      if (insertError) {
        throw new Error(
          `Failed to insert submission: ${insertError.message}`
        );
      }

      onProgress?.({
        stage: "transaction",
        stageProgress: 100,
        overallProgress: 60,
        currentItem: "Submission record created",
      });

      // Stage 4: Insert messages + emails (30%)
      if (totalMessageCount > 0) {
        onProgress?.({
          stage: "messages",
          stageProgress: 0,
          overallProgress: 60,
          currentItem: `Uploading ${messages.length} texts, ${emails.length} emails...`,
        });

        // Map text messages
        const textRecords = messages.map((m) =>
          this.mapToSubmissionMessage(m, submissionId, partyNames)
        );
        // Map emails
        const emailRecords = emails.map((e) =>
          this.mapEmailToSubmissionMessage(e, submissionId)
        );
        const allMessageRecords = [...textRecords, ...emailRecords];

        await this.insertMessagesBatched(
          allMessageRecords,
          (batchProgress) => {
            onProgress?.({
              stage: "messages",
              stageProgress: batchProgress,
              overallProgress: 60 + batchProgress * 0.3,
              currentItem: `Uploading messages...`,
            });
          }
        );
      }

      // Stage 5: Insert attachment metadata (10%)
      const successfulUploads = attachmentUploadResults.filter((r) => r.success);
      if (successfulUploads.length > 0) {
        const attachmentRecords = successfulUploads.map((upload, idx) => {
          const originalAttachment = attachments.find(
            (a) => a.storage_path === upload.localId || a.id === upload.localId
          );
          return this.mapToSubmissionAttachment(
            upload,
            submissionId,
            originalAttachment
          );
        });

        const { error: attachError } = await client
          .from("submission_attachments")
          .insert(attachmentRecords);

        if (attachError) {
          logService.warn(
            `[Submission] Failed to insert attachment records: ${attachError.message}`,
            "SubmissionService"
          );
        }
      }

      // Stage 6: Finalize submission — all data written, mark as 'submitted'
      // This is the commit point: only now does the submission become visible to brokers
      const finalStatus = options?.version ? "resubmitted" : "submitted";
      const { error: finalizeError } = await client
        .from("transaction_submissions")
        .update({ status: finalStatus })
        .eq("id", submissionId);

      if (finalizeError) {
        throw new Error(
          `Failed to finalize submission: ${finalizeError.message}`
        );
      }

      // Stage 7: Update local status
      await this.updateLocalSubmissionStatus(transactionId, {
        submission_status: options?.version
          ? "resubmitted"
          : ("submitted" as SubmissionStatus),
        submission_id: submissionId,
        submitted_at: new Date().toISOString(),
      });

      onProgress?.({
        stage: "complete",
        stageProgress: 100,
        overallProgress: 100,
        currentItem: "Submission complete",
      });

      logService.info(
        `[Submission] Transaction ${transactionId} submitted successfully as ${submissionId}`,
        "SubmissionService",
        {
          textsCount: messages.length,
          emailsCount: emails.length,
          totalMessages: totalMessageCount,
          attachmentsCount: successfulUploads.length,
          attachmentsFailed: attachmentUploadResults.filter((r) => !r.success)
            .length,
        }
      );

      this._isSubmitting = false;
      return {
        success: true,
        submissionId,
        messagesCount: totalMessageCount,
        attachmentsCount: successfulUploads.length,
        attachmentsFailed: attachmentUploadResults.filter((r) => !r.success)
          .length,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logService.error(
        `[Submission] Failed to submit transaction ${transactionId}: ${errorMessage}`,
        "SubmissionService"
      );

      // Log to Supabase error_logs (fire-and-forget)
      try {
        const client = supabaseService.getClient();
        const session = await supabaseService.getAuthSession();
        await client.from("error_logs").insert({
          user_id: session?.userId ?? null,
          app_version: app.getVersion(),
          electron_version: process.versions.electron ?? null,
          os_name: os.platform(),
          os_version: os.release(),
          platform: process.arch,
          error_type: "submission_failure",
          error_message: errorMessage,
          stack_trace: error instanceof Error ? error.stack : null,
          current_screen: "SubmitForReviewModal",
          app_state: { transactionId, submissionId },
        });
      } catch {
        // Don't let error logging prevent the main error flow
      }

      onProgress?.({
        stage: "failed",
        stageProgress: 0,
        overallProgress: 0,
        currentItem: errorMessage,
      });

      // Cleanup on failure
      await this.cleanupFailedSubmission(submissionId);

      this._isSubmitting = false;
      return {
        success: false,
        submissionId: null,
        error: errorMessage,
        messagesCount: 0,
        attachmentsCount: 0,
        attachmentsFailed: 0,
      };
    }
  }

  // ============================================
  // DATA LOADING
  // ============================================

  private async loadTransaction(transactionId: string): Promise<Transaction> {
    const transaction = await databaseService.getTransactionById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }
    return transaction;
  }

  private async loadTransactionMessages(
    transactionId: string,
    auditStartDate?: Date | null,
    auditEndDate?: Date | null
  ): Promise<Message[]> {
    const rows = databaseService.getTransactionMessages(transactionId, auditStartDate, auditEndDate);

    logService.info(
      `[Submission] Loaded ${rows.length} text messages for audit period`,
      "SubmissionService",
      {
        transactionId,
        auditStart: auditStartDate?.toISOString(),
        auditEnd: auditEndDate?.toISOString(),
      }
    );

    return rows;
  }

  /**
   * Load emails linked to a transaction via communications.email_id
   * Returns raw email rows from the emails table
   */
  private async loadTransactionEmails(
    transactionId: string,
    auditStartDate?: Date | null,
    auditEndDate?: Date | null
  ): Promise<Record<string, unknown>[]> {
    const rows = databaseService.getTransactionEmails(transactionId, auditStartDate, auditEndDate);

    logService.info(
      `[Submission] Loaded ${rows.length} emails for audit period`,
      "SubmissionService",
      {
        transactionId,
        auditStart: auditStartDate?.toISOString(),
        auditEnd: auditEndDate?.toISOString(),
      }
    );

    return rows;
  }

  /**
   * BACKLOG-1369: Load transaction attachments, downloading any missing email
   * attachments on-demand before returning.
   *
   * Since sync no longer downloads attachments eagerly, this method checks for
   * emails with has_attachments=true but no attachment records, and downloads
   * them from the provider before querying.
   */
  private async loadTransactionAttachments(
    transactionId: string,
    auditStartDate?: Date | null,
    auditEndDate?: Date | null
  ): Promise<Attachment[]> {
    // Download missing email attachments before returning
    await this.downloadMissingEmailAttachments(transactionId);

    return databaseService.getTransactionAttachments(transactionId, auditStartDate, auditEndDate);
  }

  /**
   * BACKLOG-1369: Download missing email attachments for a transaction.
   * Finds emails linked to this transaction that have has_attachments=true but
   * no attachment records in the DB, then downloads from the provider.
   */
  private async downloadMissingEmailAttachments(transactionId: string): Promise<void> {
    // Check network connectivity first
    try {
      if (!net.isOnline()) {
        logService.warn(
          "[Submission] Cannot download missing attachments: device is offline",
          "SubmissionService",
          { transactionId }
        );
        return;
      }
    } catch {
      // net.isOnline() may not be available in all contexts; proceed anyway
    }

    try {
      const db = databaseService.getRawDatabase();

      // Find emails linked to this transaction that have attachments but no records
      const emailsMissing = db
        .prepare(TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL)
        .all(transactionId) as { id: string; external_id: string; source: string; user_id: string }[];

      if (emailsMissing.length === 0) return;

      logService.info(
        `[Submission] Downloading attachments for ${emailsMissing.length} emails before export`,
        "SubmissionService",
        { transactionId }
      );

      // Group by source for efficient provider initialization
      const outlookEmails = emailsMissing.filter(e => e.source === "outlook");
      const gmailEmails = emailsMissing.filter(e => e.source === "gmail");

      if (outlookEmails.length > 0) {
        const userId = outlookEmails[0].user_id;
        try {
          const isReady = await outlookFetchService.initialize(userId);
          if (isReady) {
            for (const email of outlookEmails) {
              try {
                const graphAttachments = await outlookFetchService.getAttachments(email.external_id);
                if (graphAttachments.length > 0) {
                  await emailAttachmentService.downloadEmailAttachments(
                    email.user_id, email.id, email.external_id, "outlook",
                    graphAttachments.map((att: { id: string; name: string; contentType: string; size: number }) => ({
                      filename: att.name || "attachment",
                      mimeType: att.contentType || "application/octet-stream",
                      size: att.size || 0,
                      attachmentId: att.id,
                    })),
                  );
                }
              } catch (err) {
                logService.warn("[Submission] Failed to download Outlook attachment for export", "SubmissionService", {
                  emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
                });
              }
            }
          }
        } catch (err) {
          logService.warn("[Submission] Outlook init failed for attachment download", "SubmissionService", {
            error: err instanceof Error ? err.message : "Unknown",
          });
        }
      }

      if (gmailEmails.length > 0) {
        const userId = gmailEmails[0].user_id;
        try {
          const isReady = await gmailFetchService.initialize(userId);
          if (isReady) {
            for (const email of gmailEmails) {
              try {
                const fullEmail = await gmailFetchService.getEmailById(email.external_id);
                if (fullEmail.attachments && fullEmail.attachments.length > 0) {
                  await emailAttachmentService.downloadEmailAttachments(
                    email.user_id, email.id, email.external_id, "gmail",
                    fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; attachmentId?: string; id?: string }) => ({
                      filename: att.filename || att.name || "attachment",
                      mimeType: att.mimeType || att.contentType || "application/octet-stream",
                      size: att.size || 0,
                      attachmentId: att.attachmentId || att.id || "",
                    })),
                  );
                }
              } catch (err) {
                logService.warn("[Submission] Failed to download Gmail attachment for export", "SubmissionService", {
                  emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
                });
              }
            }
          }
        } catch (err) {
          logService.warn("[Submission] Gmail init failed for attachment download", "SubmissionService", {
            error: err instanceof Error ? err.message : "Unknown",
          });
        }
      }
    } catch (err) {
      logService.warn("[Submission] Failed to download missing email attachments for export", "SubmissionService", {
        transactionId,
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  private async getUserOrganizationId(): Promise<string | null> {
    // Use async getAuthSession() to discover sessions restored via deep-link auth
    // The sync getAuthUserId() only checks local cache which may be empty after app restart
    const session = await supabaseService.getAuthSession();
    const userId = session?.userId ?? null;

    if (!userId) {
      logService.warn(
        "[Submission] No Supabase auth session — cannot determine organization",
        "SubmissionService"
      );
      return null;
    }

    try {
      const client = supabaseService.getClient();
      const { data, error } = await client
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        logService.warn(
          `[Submission] Failed to get org: ${error.message}`,
          "SubmissionService"
        );
        return null;
      }

      return data?.organization_id || null;
    } catch (err) {
      logService.error(
        `[Submission] Error fetching org: ${err instanceof Error ? err.message : "Unknown"}`,
        "SubmissionService"
      );
      return null;
    }
  }

  private async getCurrentUserId(): Promise<string> {
    // Use async getAuthSession() to discover sessions restored via deep-link auth
    const session = await supabaseService.getAuthSession();
    const userId = session?.userId ?? null;
    if (userId) return userId;

    throw new Error("No authenticated user — cannot submit");
  }

  // ============================================
  // DATA MAPPING
  // ============================================

  private mapToSubmission(
    transaction: Transaction,
    orgId: string,
    userId: string,
    submissionId: string,
    messageCount: number,
    attachmentCount: number,
    options?: {
      version?: number;
      parentSubmissionId?: string;
    }
  ): SubmissionRecord {
    // Parse address parts if available
    let city = "";
    let state = "";
    let zip = "";

    if (transaction.property_city) city = transaction.property_city;
    if (transaction.property_state) state = transaction.property_state;
    if (transaction.property_zip) zip = transaction.property_zip;

    return {
      id: submissionId,
      organization_id: orgId,
      submitted_by: userId,
      local_transaction_id: transaction.id,
      property_address: transaction.property_address || "",
      property_city: city || undefined,
      property_state: state || undefined,
      property_zip: zip || undefined,
      transaction_type: transaction.transaction_type || "other",
      listing_price: transaction.listing_price || undefined,
      sale_price: transaction.sale_price || undefined,
      started_at: transaction.started_at
        ? new Date(transaction.started_at).toISOString()
        : undefined,
      closed_at: transaction.closed_at
        ? new Date(transaction.closed_at).toISOString()
        : undefined,
      status: "submitted",
      version: options?.version || 1,
      parent_submission_id: options?.parentSubmissionId,
      message_count: messageCount,
      attachment_count: attachmentCount,
      submission_metadata: {
        desktop_version: app.getVersion(),
        detection_source: transaction.detection_source,
        detection_confidence: transaction.detection_confidence,
      },
    };
  }

  private mapToSubmissionMessage(
    message: Message,
    submissionId: string,
    partyNames: HandleNameResolution = { names: {}, matches: {} }
  ): SubmissionMessageRecord {
    // Parse participants JSON
    let participants: Record<string, unknown> = {};
    if (message.participants) {
      try {
        participants =
          typeof message.participants === "string"
            ? JSON.parse(message.participants)
            : message.participants;
      } catch {
        participants = { from: "", to: [] };
      }
    }

    // Resolve contact names and add to participants.
    // BACKLOG-2758: `nameForHandle` is the SAME accessor, over the SAME map,
    // that the export reads — the hand-rolled last-10-digit scan that used to
    // live here was a third key derivation and a third chance to disagree.
    const resolvePhone = (phone: string): string | undefined => {
      if (!phone || phone === "me" || phone === "unknown") return undefined;
      return nameForHandle(partyNames, phone);
    };

    // Add resolved names to participants
    if (participants.from && typeof participants.from === "string") {
      const name = resolvePhone(participants.from);
      if (name) participants.from_name = name;
    }
    if (participants.to) {
      const toList = Array.isArray(participants.to)
        ? participants.to
        : [participants.to];
      const toNames: Record<string, string> = {};
      toList.forEach((phone: string) => {
        const name = resolvePhone(phone);
        if (name) toNames[phone] = name;
      });
      if (Object.keys(toNames).length > 0) {
        participants.to_names = toNames;
      }
    }
    if (
      participants.chat_members &&
      Array.isArray(participants.chat_members)
    ) {
      const memberNames: Record<string, string> = {};
      participants.chat_members.forEach((phone: string) => {
        const name = resolvePhone(phone);
        if (name) memberNames[phone] = name;
      });
      if (Object.keys(memberNames).length > 0) {
        participants.chat_member_names = memberNames;
      }
    }

    return {
      submission_id: submissionId,
      local_message_id: message.id,
      channel: message.channel || "email",
      direction: message.direction || "inbound",
      subject: message.subject || undefined,
      body_text: message.body_text || undefined,
      participants,
      sent_at: message.sent_at
        ? new Date(message.sent_at as string).toISOString()
        : undefined,
      thread_id: message.thread_id || undefined,
      has_attachments: message.has_attachments || false,
      attachment_count: 0, // Would need to count from attachments table
      // TASK-1803: Include message_type for broker portal special message display
      message_type: message.message_type || "text",
    };
  }

  /**
   * Map an email row from the emails table to a SubmissionMessageRecord
   */
  private mapEmailToSubmissionMessage(
    email: Record<string, unknown>,
    submissionId: string
  ): SubmissionMessageRecord {
    // Build participants from email fields
    const participants: Record<string, unknown> = {};
    if (email.sender) participants.from = email.sender;
    if (email.recipients) {
      const recipientStr = email.recipients as string;
      participants.to = recipientStr.split(",").map((r: string) => r.trim());
    }
    if (email.cc) {
      const ccStr = email.cc as string;
      participants.cc = ccStr.split(",").map((r: string) => r.trim());
    }
    if (email.bcc) {
      const bccStr = email.bcc as string;
      participants.bcc = bccStr.split(",").map((r: string) => r.trim());
    }

    return {
      submission_id: submissionId,
      local_message_id: email.id as string,
      channel: "email",
      direction: (email.direction as string) || "inbound",
      subject: (email.subject as string) || undefined,
      body_text: (email.body_plain as string) || undefined,
      participants,
      sent_at: email.sent_at
        ? new Date(email.sent_at as string).toISOString()
        : undefined,
      thread_id: (email.thread_id as string) || undefined,
      has_attachments: (email.has_attachments as number) === 1,
      attachment_count: (email.attachment_count as number) || 0,
      message_type: "email",
    };
  }

  private mapToSubmissionAttachment(
    uploadResult: AttachmentUploadResult,
    submissionId: string,
    originalAttachment?: Attachment
  ): SubmissionAttachmentRecord {
    return {
      submission_id: submissionId,
      filename: originalAttachment?.filename || "unknown",
      mime_type: uploadResult.mimeType || originalAttachment?.mime_type,
      file_size_bytes:
        uploadResult.fileSizeBytes || originalAttachment?.file_size_bytes,
      storage_path: uploadResult.storagePath,
      document_type: originalAttachment?.document_type,
    };
  }

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  private async insertMessagesBatched(
    records: SubmissionMessageRecord[],
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const client = supabaseService.getClient();
    const total = records.length;

    for (let i = 0; i < records.length; i += MESSAGE_BATCH_SIZE) {
      const batch = records.slice(i, i + MESSAGE_BATCH_SIZE);

      const { error } = await client.from("submission_messages").insert(batch);

      if (error) {
        logService.warn(
          `[Submission] Batch insert warning: ${error.message}`,
          "SubmissionService"
        );
      }

      const progress = Math.min(100, ((i + batch.length) / total) * 100);
      onProgress?.(progress);
    }
  }

  private async updateLocalSubmissionStatus(
    transactionId: string,
    updates: {
      submission_status: SubmissionStatus;
      submission_id: string;
      submitted_at: string;
    }
  ): Promise<void> {
    try {
      await databaseService.updateTransaction(transactionId, {
        submission_status: updates.submission_status,
        submission_id: updates.submission_id,
        submitted_at: updates.submitted_at,
      });
    } catch (error) {
      logService.error(
        `[Submission] Failed to update local status: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
      // Don't throw - the cloud submission succeeded
    }
  }

  // ============================================
  // CLEANUP
  // ============================================

  private async cleanupFailedSubmission(submissionId: string): Promise<void> {
    try {
      const client = supabaseService.getClient();

      // Delete messages (cascade will handle this, but be explicit)
      await client
        .from("submission_messages")
        .delete()
        .eq("submission_id", submissionId);

      // Delete attachments records
      await client
        .from("submission_attachments")
        .delete()
        .eq("submission_id", submissionId);

      // Delete submission record
      await client
        .from("transaction_submissions")
        .delete()
        .eq("id", submissionId);

      // Note: Storage files are NOT deleted here (orphaned files are cleaned up separately)

      logService.info(
        `[Submission] Cleaned up failed submission ${submissionId}`,
        "SubmissionService"
      );
    } catch (error) {
      logService.warn(
        `[Submission] Cleanup warning: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
    }
  }
}

// Export singleton
export const submissionService = new SubmissionService();
export default submissionService;
