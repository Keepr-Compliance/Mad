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
import type { SupabaseClient } from "@supabase/supabase-js";
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
  /**
   * Attachments that were gathered and then FAILED TO UPLOAD. Unchanged in
   * BACKLOG-3389 — see {@link SubmissionResult.flaggedWithoutAttachments} for
   * the number this one never could have reported.
   */
  attachmentsFailed: number;
  messagesCount: number;
  attachmentsCount: number;
  /**
   * BACKLOG-3389: in-window texts and emails that ADVERTISE an attachment
   * (`has_attachments`) and contributed NOTHING to this submission.
   *
   * `attachmentsFailed` counts upload failures, so it can only ever see an
   * attachment the gather already returned. Everything lost BEFORE the gather —
   * a metadata-only row whose bytes were never downloaded, a download that
   * failed, an attachment row the importer never wrote — was invisible: the run
   * reported `attachmentsCount: 0, attachmentsFailed: 0` while silently
   * dropping a real attachment. That silent zero is what made BACKLOG-3389
   * take a month to notice.
   *
   * Counted AFTER the gather, so it is the honest residue of the whole
   * pipeline — pre-download included — and not a prediction made inside any one
   * step of it. Zero here means "nothing to send"; non-zero means "we could not
   * send these", and the two are now distinguishable.
   */
  flaggedWithoutAttachments: number;
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

/**
 * The organization record embedded by this service's membership lookup.
 *
 * BACKLOG-3364. `personal_owner_user_id` is optional because it is exactly what
 * a database without that migration omits — the whole record is selected so
 * that its absence is a missing key rather than an error.
 */
interface SubmissionEmbeddedOrganization {
  personal_owner_user_id?: string | null;
}

/**
 * One row of `select("organization_id, organizations(*)")`.
 *
 * Object on the wire, ARRAY in the inferred type: PostgREST returns a single
 * object for this many-to-one embed, but the client is built without a
 * generated `Database` type, so supabase-js infers an array from the select
 * string alone. Both are declared and both are handled — narrowing to the array
 * alone compiles and then reads `undefined` at runtime, which would make every
 * organization look non-personal and is precisely the bug this guards.
 */
interface SubmissionMembershipRow {
  organization_id: string;
  organizations?:
    | SubmissionEmbeddedOrganization
    | SubmissionEmbeddedOrganization[]
    | null;
}

/**
 * Is this membership row the user's own personal organization?
 *
 * A null, empty or missing embed reads as NOT personal, which is the
 * pre-migration answer and the safe one: it can only leave today's behaviour in
 * place.
 */
function isPersonalSubmissionMembership(row: SubmissionMembershipRow): boolean {
  const embed = row.organizations;
  const org = !embed ? null : Array.isArray(embed) ? (embed[0] ?? null) : embed;
  return !!org?.personal_owner_user_id;
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
  // BACKLOG-3519 (Commission M2, figures only). Every field here MUST be
  // `undefined`, never `null`, when there is no value — see
  // `resolveSplitSnapshot`'s header comment for why: today, with BACKLOG-3503
  // unapplied in every environment, an explicit `null` would still reach the
  // INSERT body as a real JSON key and fail with PGRST204 (unknown column) on
  // every submission, for every user. `undefined` is dropped by
  // `JSON.stringify` before the request body is built (verified against the
  // installed `@supabase/postgrest-js` — `PostgrestBuilder.ts`'s fetch call —
  // not assumed), so the key never reaches the wire until the migration is
  // live. `.insert()` is called with a single object, not an array, so
  // postgrest-js never derives a `columns=` query param from `Object.keys()`
  // either (that path only fires for a bulk array insert).
  commission_offered_rate?: number;
  commission_actual_rate?: number;
  commission_gross_amount?: number;
  commission_adjustment_reason?: string;
  split_agreement_id?: string;
  split_agent_pct?: number;
  split_brokerage_pct?: number;
  split_effective_from?: string;
  split_resolved_on?: string;
}

/**
 * What `resolveSplitSnapshot` hands back. Every field optional and,
 * critically, `undefined` (never `null`) in every "did not resolve to a
 * value" case -- see `SubmissionRecord`'s comment on why that distinction is
 * load-bearing today.
 */
interface SplitSnapshot {
  split_agreement_id?: string;
  split_agent_pct?: number;
  split_brokerage_pct?: number;
  split_effective_from?: string;
  split_resolved_on?: string;
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

      // BACKLOG-3389: what advertised an attachment and gave us nothing. Must
      // be measured HERE — after the gather, before anything is uploaded — so
      // it counts the residue of the whole pipeline rather than of one step.
      const flaggedWithoutAttachments = this.countFlaggedWithoutAttachments(
        messages,
        emails,
        attachments
      );
      if (flaggedWithoutAttachments > 0) {
        logService.warn(
          `[Submission] ${flaggedWithoutAttachments} in-window items advertise an attachment but contributed none — they will NOT be in this submission`,
          "SubmissionService",
          {
            transactionId,
            flaggedWithoutAttachments,
            attachmentsGathered: attachments.length,
          }
        );
      }

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
         * BACKLOG-3390 — `resubmitted` IS ON THE LIST NOW, and this paragraph
         * is where it used to say it was not.
         *
         * BACKLOG-2853 justified leaving it off with "it carries the identical
         * hazard one broker round trip later" — WRONG, and withdrawn. It was
         * then argued that adding the word would change nothing, because a
         * `resubmitted` row only exists at version >= 2, two rows share
         * `(organization_id, local_transaction_id)`, and the old single-row
         * lookup returned PGRST116 so execution never arrived here at all.
         * BACKLOG-2867 fixed that lookup and spent the second argument too,
         * leaving a live decision sitting in front of a user.
         *
         * It arrived as one. After a successful resubmit the deal sits at
         * `resubmitted`; the modal labels its action "Resubmit for Review"
         * while `TransactionDetails` routes only `needs_changes` to
         * `resubmitTransaction`, so the press ran a PLAIN submit holding
         * version 1. The fixed lookup named the version-2 row, the list let it
         * through, the full attachment upload ran, and the insert collided with
         * the retained version-1 row — reaching the user as a raw unique
         * constraint name. Released v2.37.0, founder QA 2026-09-16.
         *
         * The refusal now happens HERE, before the upload. The routing is
         * deliberately NOT widened to send `resubmitted` to
         * `resubmitTransaction`: that would insert version 3 and succeed,
         * sending a second package on a deal the broker has not answered.
         *
         * The version-mismatch condition on the delete below is unchanged and
         * still load-bearing — `needs_changes` at version >= 2 reaches it.
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

      // BACKLOG-3519: resolve the split AFTER orgId/currentUserId are known and
      // BEFORE mapToSubmission builds the record, so the snapshot can be merged
      // in rather than requiring mapToSubmission itself to become async. Runs on
      // every (re)submission -- a resubmission re-resolves fresh, which is
      // correct: the FROZEN copy lives on the transaction_submissions row this
      // call is about to create, not anywhere local, so there is nothing to
      // preserve from the prior version.
      const splitSnapshot = await this.resolveSplitSnapshot(
        client,
        orgId,
        currentUserId,
        transaction.closed_at
      );

      const submissionRecord = this.mapToSubmission(
        transaction,
        orgId,
        currentUserId,
        submissionId,
        totalMessageCount,
        attachmentUploadResults.filter((r) => r.success).length,
        options,
        splitSnapshot
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
        /**
         * BACKLOG-3390 — THE LAST LINE OF DEFENCE DOES NOT SPEAK SQL.
         *
         * `23505` is Postgres's unique_violation. On this insert it can only be
         * UNIQUE (organization_id, local_transaction_id, version, submitted_by)
         * — i.e. this user already has a submission of this transaction at this
         * version. The driver's `message` for it is the sentence the founder was
         * shown verbatim:
         *
         *   duplicate key value violates unique constraint
         *   "transaction_submissions_org_txn_version_user_key"
         *
         * The guard above is what stops him ever reaching this line by pressing
         * Resubmit; this is what stops the raw name reaching ANY user by any
         * other route (a second device, a service-role caller, a policy drift).
         * A guard that only covers the one reported press would leave the string
         * itself intact, and defect 2 of the item is the string.
         *
         * The raw driver text is LOGGED, not thrown — the diagnosis must survive
         * somewhere, and the application log is the right somewhere. Other
         * insert failures keep the driver's words, because they are genuinely
         * unclassified and a vague sentence would be worse than a specific one;
         * this branch is narrow on purpose.
         */
        if (insertError.code === "23505") {
          logService.error(
            `[Submission] Insert collided with an existing submission for ${transactionId} at version ${submissionRecord.version}`,
            "SubmissionService",
            {
              code: insertError.code,
              message: insertError.message,
            }
          );
          throw new Error(
            "This transaction already has a submission at this version, so nothing new was sent. Close this window and reopen the transaction to refresh its status, then try again."
          );
        }
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
          // BACKLOG-3389: the number that used to be unrecorded. Logged even
          // when it is 0 — a zero that is PRINTED is a measurement; a zero that
          // is absent is what this item was.
          flaggedWithoutAttachments,
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
        flaggedWithoutAttachments,
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
        // Nothing was submitted, so nothing was dropped from a submission. The
        // error is the report here; this field would only add a second,
        // weaker one.
        flaggedWithoutAttachments: 0,
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
   * BACKLOG-3389: how many in-window texts and emails advertise an attachment
   * and contributed none to this submission.
   *
   * Counted by SET MEMBERSHIP against the attachments actually gathered — the
   * owning `message_id` / `email_id` of each — not by re-running a query or
   * subtracting counts. Two counts agreeing is not the same as the right rows
   * being present, and this number exists precisely because a count agreed with
   * itself while an attachment went missing.
   *
   * `has_attachments` arrives as SQLite's 0/1 through a `boolean` field on
   * {@link Message} and as an unknown on the email rows, so the truth test is
   * explicit about all three spellings rather than leaning on truthiness.
   */
  private countFlaggedWithoutAttachments(
    messages: Message[],
    emails: Record<string, unknown>[],
    attachments: Attachment[]
  ): number {
    const messagesWithBytes = new Set<string>();
    const emailsWithBytes = new Set<string>();
    for (const attachment of attachments) {
      // `getTransactionAttachments` does `SELECT a.*`, so `email_id` is on the
      // row at runtime even though the `Attachment` interface omits it.
      const row = attachment as Attachment & { email_id?: string | null };
      if (row.message_id) messagesWithBytes.add(row.message_id);
      if (row.email_id) emailsWithBytes.add(row.email_id);
    }

    const advertisesAttachment = (value: unknown): boolean =>
      value === true || value === 1 || value === "1";

    let missing = 0;
    for (const message of messages) {
      const flagged = advertisesAttachment(
        (message as unknown as Record<string, unknown>).has_attachments
      );
      if (flagged && !messagesWithBytes.has(message.id)) missing += 1;
    }
    for (const email of emails) {
      const id = email.id;
      if (typeof id !== "string") continue;
      if (advertisesAttachment(email.has_attachments) && !emailsWithBytes.has(id)) {
        missing += 1;
      }
    }
    return missing;
  }

  /**
   * BACKLOG-1369: Load transaction attachments, downloading any missing email
   * attachments on-demand before returning.
   *
   * Since sync no longer downloads attachments eagerly, this method checks for
   * emails that advertise attachments whose BYTES are not stored locally, and
   * downloads them from the provider before querying.
   *
   * BACKLOG-3389: "whose bytes are not stored" is the corrected test. It used
   * to read "with no attachment records", which is what the SQL asked and what
   * silently dropped a metadata-only attachment from a submission.
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
   * Finds emails linked to this transaction that have has_attachments=true and
   * are missing the BYTES of at least one attachment, then downloads from the
   * provider.
   *
   * BACKLOG-3389: "missing the bytes" replaced "have no attachment records".
   * A normal sync writes a metadata-only row (`storage_path` NULL), which
   * satisfied the old row-existence test — so the download was skipped and the
   * gather then discarded the row for having nothing to upload. The predicate
   * and the reasoning live in `db/submissionEmailSql.ts`.
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
                      // BACKLOG-3187: a Graph attachment has no MIME part, so no identity
                      // beyond its own id. Explicitly null — the field is required so this
                      // decision cannot be left unmade at a new call site.
                      partId: null,
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
                    fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; partId?: string; attachmentId?: string; id?: string }) => ({
                      filename: att.filename || att.name || "attachment",
                      mimeType: att.mimeType || att.contentType || "application/octet-stream",
                      size: att.size || 0,
                      // BACKLOG-3187: identity (Gmail's immutable MIME part id) travels
                      // separately from the fetch token below, which rotates between calls.
                      partId: att.partId ?? null,
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
      /**
       * BACKLOG-3364 — WHICH ORGANIZATION A SUBMISSION GOES TO.
       *
       * Three things changed here, each a separate failure this query had or
       * would have acquired:
       *
       * 1. **A personal organization is refused.** A solo user now holds a
       *    membership row, so this lookup would hand back their own
       *    organization: the submission would be built, its attachments
       *    uploaded, and only then would the insert be refused by the database,
       *    which excludes personal organizations from the submission rules.
       *    Returning null makes the existing "not a member of any organization"
       *    refusal in `submitTransactionInternal` fire BEFORE any upload — the
       *    same refusal a solo user got before personal organizations existed.
       *
       * 2. **`.maybeSingle()` is gone.** Against two rows PostgREST answers
       *    PGRST116 with `data: null`, so a brokerage member who also still
       *    held a personal row could not submit at all. The rows are ordered
       *    and picked here instead.
       *
       * 3. **The column is never named.** `organizations(*)` embeds the whole
       *    record and the personal flag is read from a key that is simply
       *    absent until BACKLOG-3364's migration is applied. Naming it in the
       *    select, order or filter returns HTTP 400 / `42703` with `data: null`
       *    and no throw — which reads here as "no organization" and would stop
       *    every real brokerage member from submitting.
       *
       * The absence of a `license_status` filter here is deliberate and is NOT
       * changed by this item — it matches the rule the database already
       * applies, and narrowing it would take away something that works today.
       * Rationale on the backlog item, not here. Both `.order()` columns are
       * base columns of `organization_members`, so neither names the new column
       * nor sorts on the embed.
       */
      const { data, error } = await client
        .from("organization_members")
        .select("organization_id, organizations(*)")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });

      if (error) {
        logService.warn(
          `[Submission] Failed to get org: ${error.message}`,
          "SubmissionService"
        );
        return null;
      }

      if (!Array.isArray(data)) {
        logService.warn(
          "[Submission] Failed to get org: result was not a list of rows",
          "SubmissionService"
        );
        return null;
      }

      const brokerage = (data as SubmissionMembershipRow[]).find(
        (row) => !isPersonalSubmissionMembership(row)
      );

      if (!brokerage) {
        logService.info(
          "[Submission] No brokerage organization for this user — nothing to submit to",
          "SubmissionService"
        );
        return null;
      }

      return brokerage.organization_id || null;
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

  /**
   * BACKLOG-3519 — resolve the split agreement in force and the exact date
   * used to resolve it, or resolve to nothing at all.
   *
   * THE DATE: the founder's backdating ruling (pm_comments 92f46fb4 on
   * BACKLOG-3503) judges a deal by the terms in force on its CLOSING date, not
   * the date it happens to be recorded -- so this resolves against
   * `transaction.closed_at`, UTC-truncated exactly the way BACKLOG-3503's own
   * INSERT policy truncates `deactivated_at`
   * (`(closed_at AT TIME ZONE 'UTC')::date`), so the two dates are compared
   * the same way everywhere in this system. `.toISOString().slice(0, 10)` on a
   * JS `Date` IS that truncation: `toISOString()` always renders UTC,
   * regardless of the machine's local timezone. When `closed_at` is NULL --
   * `submitTransactionInternal` already handles that as a live state
   * (`auditEndDate` above) -- the fallback is today's date, also computed in
   * UTC for the same reason.
   *
   * NEVER THROWS, NEVER BLOCKS. A missing split, a missing table/function
   * (BACKLOG-3503 not yet applied anywhere: measured 2026-09-25 against
   * production, `split_agreement_in_force` answers PGRST202 -- "function ...
   * not found in the schema cache"), or any other RPC failure all resolve to
   * `{}`: nothing is added to the submission record, and the submission
   * proceeds. This is the founder's explicit rule (never block on a missing
   * split), and it is also the only safe behaviour while BACKLOG-3503 remains
   * unapplied -- see `SubmissionRecord`'s comment on why every key here must
   * stay `undefined` rather than `null` for that same reason.
   *
   * `split_resolved_on` IS SET ON A SUCCESSFUL CALL EVEN WHEN NO ROW IS
   * FOUND, AND ONLY THEN. Setting it on every attempt, including an RPC
   * error, would write "resolved on <date>, no agreement found" when the true
   * state is "resolution was not available at all" -- a false compliance
   * statement on a record this table exists to keep honest. Distinguishing
   * "no split configured yet" (RPC succeeded, zero rows) from "resolution
   * unavailable" (RPC failed) is the entire reason this returns `{}` in one
   * case and `{ split_resolved_on }` in the other, rather than collapsing
   * both to the same empty result.
   */
  private async resolveSplitSnapshot(
    client: SupabaseClient,
    orgId: string,
    agentUserId: string,
    closedAt: string | undefined
  ): Promise<SplitSnapshot> {
    // Computed INSIDE the try, not before it (BACKLOG-3519 SR review,
    // pm_comments 701d1100/a75ac7d7 on this item). `validation.ts:959`'s date
    // check is an unanchored prefix regex that admits "2026-13-45" and
    // "2026-00-00" -- both pass the IPC gate and both make `new Date(...)`
    // produce an Invalid Date, whose `.toISOString()` throws RangeError. A
    // throw here must land in the same `{}`-and-log path as an RPC failure,
    // not escape past this docblock's "NEVER THROWS" promise. The rejected
    // alternative (substitute today's date and proceed) was proposed and then
    // retracted during review: silently resolving the split against a date
    // the deal did not close on, and writing `split_resolved_on = <today>` as
    // if that were the answer, is the exact false-compliance statement this
    // design exists to prevent -- worse than the RangeError it would hide.
    let resolvedOn = "";
    let data: unknown;
    let error: { code?: string; message?: string } | null;
    try {
      resolvedOn = (closedAt ? new Date(closedAt) : new Date())
        .toISOString()
        .slice(0, 10);
      const result = await client.rpc("split_agreement_in_force", {
        p_organization_id: orgId,
        p_agent_user_id: agentUserId,
        p_on_date: resolvedOn,
      });
      data = result.data;
      error = result.error;
    } catch (err) {
      error = { message: err instanceof Error ? err.message : "Unknown error" };
      data = null;
    }

    if (error) {
      // PGRST202 ("function ... not found in the schema cache") is BACKLOG-3503
      // not yet applied -- expected today, logged quietly. Anything else is
      // unexpected and logged louder, but the outcome is identical either way:
      // never block a submission on this.
      const isMissingFunction = error.code === "PGRST202" || error.code === "PGRST205";
      const message = `[Submission] Split resolution unavailable (${error.code ?? "no code"}): ${
        error.message ?? "unknown error"
      }`;
      // Called through the object, never a detached reference: logService's
      // methods use `this.log(...)` internally, and `const f = logService.info`
      // loses that binding.
      if (isMissingFunction) {
        logService.info(message, "SubmissionService");
      } else {
        logService.warn(message, "SubmissionService");
      }
      return {};
    }

    const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{
      id: string;
      agent_pct: number;
      brokerage_pct: number;
      effective_from: string;
    }>;
    const row = rows[0];

    if (!row) {
      return { split_resolved_on: resolvedOn };
    }

    return {
      split_resolved_on: resolvedOn,
      split_agreement_id: row.id,
      split_agent_pct: row.agent_pct,
      split_brokerage_pct: row.brokerage_pct,
      split_effective_from: row.effective_from,
    };
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
    },
    splitSnapshot?: SplitSnapshot
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
      // BACKLOG-3519 (Commission M2, figures only). `??`, NOT `||`: a rate of
      // exactly 0 is a legal, CHECK-permitted value (a referral rebate, for
      // instance) and must survive -- `0 || undefined` would silently drop it,
      // which `sale_price`/`listing_price` above get away with only because a
      // real-world price is never legitimately 0. `commission_adjustment_reason`
      // is the one field that keeps `||`, deliberately: an empty string IS
      // absent here, because the migration's CHECK rejects a zero-length
      // (post-trim) reason and a blanked form field produces "" the same way it
      // does for the date fields elsewhere in this function.
      commission_offered_rate: transaction.commission_offered_rate ?? undefined,
      commission_actual_rate: transaction.commission_actual_rate ?? undefined,
      commission_gross_amount: transaction.commission_gross_amount ?? undefined,
      commission_adjustment_reason: transaction.commission_adjustment_reason || undefined,
      // See resolveSplitSnapshot's header comment: every key here is already
      // `undefined` throughout when resolution did not happen or found nothing,
      // never `null` -- spreading it here does not need its own guard.
      ...splitSnapshot,
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
