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
import { app } from "electron";
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
import supabaseStorageService from "./supabaseStorageService";
import mime from "mime-types";
import type { SupabaseClient } from "@supabase/supabase-js";
// BACKLOG-3403: the one producer of an attachment's object path.
import { buildAttachmentStoragePath } from "./submissionAttachmentFiles";
import {
  runSubmissionPreflight,
  type NotIncludedItem,
  type NotIncludedReason,
} from "./submissionPreflight";
import {
  SubmissionCancelledError,
  SubmissionStageError,
  throwIfCancelled,
  withStageRetry,
  type SubmissionStageName,
} from "./submissionStageRetry";
import { abandonSubmission, readSubmissionStatus } from "./submissionAbandon";
import { auditPeriodFromRow, type AuditPeriodSource } from "./submissionAuditPeriod";
import { selectSubmissionTextIds } from "./transactionCommunicationSet";
import type { SelectedTextIds } from "./exportPlan";
import {
  flatAttemptCounts,
  pickRefusalCounts,
  recordSubmissionAttempt,
  reportSubmissionExclusions,
  reportSubmissionFailure,
  reportSubmissionScope,
  type FinalizeRefusalCounts,
  type ManifestCounts,
  type SubmissionFailureReason,
  inProgressAttemptCounts,
} from "./submissionReporting";
import databaseService from "./databaseService";
import logService from "./logService";
import { downloadMissingEmailAttachments as downloadMissingEmailAttachmentsShared } from "./emailAttachmentDownload";
import { snapshotSubmissionChecklists } from "./submissionChecklistSnapshot";
import {
  findChecklistLinkGaps,
  gapMemberKeys,
  type ChecklistLinkGap,
} from "./submissionChecklistLinkGaps";
import { getChecklistsForTransaction } from "./db/checklistDbService";
import {
  notifyChecklistsChanged,
  retryOwedReviewChecklistPull,
  beginResubmitChecklistGuard,
  endResubmitChecklistGuard,
} from "./submissionChecklistPull";
// BACKLOG-3599: direct, not through the databaseService facade.
import { getOwedReviewChecklistPullsFor, type SubmissionAttachment } from "./db/submissionDbService";
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
  messagesCount: number;
  attachmentsCount: number;
  /**
   * BACKLOG-3389: in-window texts and emails whose attachments are not in this
   * submission. BACKLOG-3403: the number of distinct messages in
   * {@link SubmissionResult.notIncluded}.
   */
  flaggedWithoutAttachments: number;
  /**
   * BACKLOG-3681: each attachment (or message) that was left out of a
   * SUCCESSFUL submission, and why. Display data — never logged.
   * BACKLOG-3403: on `preflightChanged`, the current list to confirm again.
   */
  notIncluded: NotIncludedItem[];
  /** BACKLOG-3398: the user cancelled; nothing was sent. */
  cancelled?: boolean;
  /**
   * BACKLOG-3403: the files that cannot be sent changed since the agent
   * confirmed them. Nothing was sent; `notIncluded` holds the new list.
   */
  preflightChanged?: boolean;
  /**
   * BACKLOG-3403: the server's answer to the final step was lost and could not
   * be read back. Nothing was deleted and the local status was not changed.
   */
  unconfirmed?: boolean;
  /**
   * BACKLOG-3600: set only on a SUCCESSFUL submission whose checklists did not
   * all reach the broker. Absent means nothing to say.
   *   not_in_plan  the org's plan does not include checklists (RLS 42501)
   *   refused      the cloud refused the copy for any other reason
   * A transient failure never sets this — it fails the submission instead.
   *   brokerChecklistsNotDownloaded  (BACKLOG-3599, resubmit only) the
   *               checklists the broker added at review were still owed and
   *               could not be downloaded first, so this version lacks them.
   *               The 3600 reasons take precedence when both apply.
   */
  checklistsNotSent?: ChecklistsNotSentReason;
  /**
   * BACKLOG-3764: on `preflightChanged`, the checklist evidence this
   * submission would not send, to confirm again.
   */
  checklistLinkGaps?: ChecklistLinkGap[];
  /**
   * BACKLOG-3764: set only on a SUCCESSFUL submission when checklist evidence
   * was dropped that the pre-flight did not list (a defect, reported to
   * Sentry). The agent is told.
   */
  checklistLinksNotAttached?: boolean;
}

/** BACKLOG-3403: what the agent confirmed on the pre-flight warning. */
export interface SubmitOptions {
  /**
   * `NotIncludedItem.key`s the agent chose to leave out. BACKLOG-3764: and
   * `ChecklistLinkGap.key`s.
   */
  acceptedExclusionKeys?: string[];
}

/** BACKLOG-3403: the pre-flight answer (`transactions:submit-preflight`). */
export interface SubmissionPreflightResult {
  success: boolean;
  notIncluded: NotIncludedItem[];
  /** BACKLOG-3764: checklist evidence this submission would not send. */
  checklistLinkGaps?: ChecklistLinkGap[];
  error?: string;
}

/** BACKLOG-3683: what a submission with these dates would send. */
export interface SubmissionScopeResult {
  success: boolean;
  inWindow?: {
    emails: number;
    texts: number;
    textThreads: number;
    attachments: number;
    emailAttachments: number;
    attachmentBytes: number;
  };
  error?: string;
}

/** BACKLOG-3398: the answer to `transactions:cancel-submit`. */
export interface CancelSubmissionResult {
  cancelled: boolean;
  /** Why nothing was cancelled. */
  reason?: "not_running" | "finalizing";
}

/** Why a submitted version lacks checklists (BACKLOG-3600, BACKLOG-3599). */
export type ChecklistsNotSentReason =
  | "not_in_plan"
  | "refused"
  | "brokerChecklistsNotDownloaded";

/**
 * BACKLOG-3600 — the agent-facing sentence when the checklist copy failed on
 * every attempt. It is thrown while the submission is still `uploading`, so the
 * catch below deletes it and the modal shows this text as the failure.
 */
export const CHECKLISTS_NOT_SENT_ERROR =
  "Your checklists could not be sent to your broker, so nothing was submitted. Check your connection and try again.";

/** BACKLOG-3403: any failure after the agent pressed Submit. Nothing reached the broker. */
export const SUBMISSION_NOT_SENT_ERROR =
  "Your submission didn't go through, so nothing was sent to your broker. Check your connection and submit again.";

/** BACKLOG-3398: the agent cancelled. Nothing reached the broker. */
export const SUBMISSION_CANCELLED_MESSAGE =
  "Submission cancelled. Nothing was sent to your broker.";

/**
 * BACKLOG-3403: the final step's answer was lost and the status could not be
 * read back. Pressing Submit again is safe: if the first one went through, the
 * existing-submission check refuses and says so; if it did not, the leftover
 * is cleared first.
 */
export const SUBMISSION_UNCONFIRMED_ERROR =
  "We couldn't confirm whether your submission reached your broker. Wait a minute, then press Submit again: if it already went through, Keepr will tell you.";

/** BACKLOG-3403: the files that cannot be sent changed after the agent confirmed them. */
export const PREFLIGHT_CHANGED_ERROR =
  "Some attachments changed since you reviewed them, so nothing was sent. Review the list and continue again.";

/**
 * BACKLOG-3403: a submit that never showed the agent the list (bulk submit
 * from the transactions list) and found attachments that cannot be sent.
 */
export const PREFLIGHT_NOT_REVIEWED_ERROR =
  "Some attachments in this transaction can't be sent, so nothing was sent. Open the transaction and press Submit to review them.";

/** Progress stages for submission flow */
export type SubmissionStage =
  | "preparing"
  | "attachments"
  | "transaction"
  | "messages"
  // BACKLOG-3398: from here the submission can no longer be cancelled.
  | "finalizing"
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
  // BACKLOG-3519 / BACKLOG-3520 (commission figures only; the split is NOT
  // part of this record). A field is `undefined` -- never `null` -- when the
  // agent entered no figure, so its key is dropped by `JSON.stringify` and the
  // INSERT body carries nothing new (`.insert()` takes a single object, so
  // postgrest-js derives no `columns=` from `Object.keys()`).
  //
  // WHEN A FIGURE IS ENTERED these keys DO reach the wire. Against a database
  // where the 3519 migration has not been applied, PostgREST answers PGRST204
  // (unknown column) and the submission fails. That is deliberate: stripping
  // the keys on failure would submit a record that silently lacks what the
  // agent typed. The migration must be applied first.
  commission_offered_rate?: number;
  commission_actual_rate?: number;
  commission_gross_amount?: number;
  commission_adjustment_reason?: string;
}

/** Record structure for submission_messages table */
interface SubmissionMessageRecord {
  /** BACKLOG-3403: minted by the desktop, so a retried insert is a no-op. */
  id: string;
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
  /** BACKLOG-3403: minted by the desktop. */
  id: string;
  submission_id: string;
  filename: string;
  mime_type?: string;
  file_size_bytes?: number;
  storage_path: string;
  document_type?: string;
  /**
   * BACKLOG-3477: the LOCAL `attachments.id` this row was uploaded from. The
   * checklist snapshot matches evidence links on it. Not unique in the cloud.
   */
  local_attachment_id: string | null;
  /**
   * BACKLOG-3682: the submission message (text or email) this file came from,
   * by its minted cloud id. Null when the owner is not in this submission.
   */
  message_id: string | null;
}

/**
 * BACKLOG-3403: one file the agent chose to leave out, as stored in
 * `submission_metadata.excluded_files` for the broker. Names are fine here —
 * the broker sees the messages themselves.
 */
interface ExcludedFileRecord {
  filename: string | null;
  kind: "text" | "email";
  /** The cloud id of the message the file came from (in this submission). */
  message_id: string | null;
  sent_at: string | null;
  source_label: string;
  reason: NotIncludedReason;
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
const ATTACHMENT_ROW_BATCH_SIZE = 100;

/** BACKLOG-3600: the checklist copy failed on every attempt (transient). */
class ChecklistsNotSentError extends Error {
  constructor() {
    super(CHECKLISTS_NOT_SENT_ERROR);
    this.name = "ChecklistsNotSentError";
  }
}

/** BACKLOG-3403: finalize did not commit, for a known reason. */
class FinalizeFailedError extends Error {
  readonly reason: SubmissionFailureReason;
  readonly stage: SubmissionStageName;
  readonly code: string | null;
  constructor(reason: SubmissionFailureReason, stage: SubmissionStageName, code: string | null = null) {
    super(`finalize: ${reason}`);
    this.name = "FinalizeFailedError";
    this.reason = reason;
    this.stage = stage;
    this.code = code;
  }
}

/** BACKLOG-3403: finalize's answer was lost and the row could not be read. */
class UnconfirmedSubmissionError extends Error {
  constructor() {
    super("finalize unconfirmed");
    this.name = "UnconfirmedSubmissionError";
  }
}

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
    onProgress?: (progress: SubmissionProgress) => void,
    submitOptions?: SubmitOptions
  ): Promise<SubmissionResult> {
    return this.submitTransactionInternal(
      transactionId,
      undefined,
      onProgress,
      submitOptions
    );
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
    onProgress?: (progress: SubmissionProgress) => void,
    submitOptions?: SubmitOptions
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

    // BACKLOG-3599 (SR condition 3): a broker checklist still owed from an
    // earlier review would be missing from this version's snapshot. Try the
    // owed pull once, BEFORE Stage 1 — no 'uploading' row exists yet, so the
    // pull's timeouts never hold one open. Never blocks the resubmit.
    //
    // BACKLOG-3607 (SR R-1): from here until the submit returns, no other pull
    // writes onto this transaction's checklists (the sync pass returns kept).
    beginResubmitChecklistGuard(transactionId);
    let owedPullsLanded: boolean;
    let result: SubmissionResult;
    try {
      owedPullsLanded = await this.pullOwedReviewChecklistsBeforeResubmit(
        transactionId
      );

      result = await this.submitTransactionInternal(
        transactionId,
        {
          version: newVersion,
          parentSubmissionId: transaction.submission_id,
        },
        onProgress,
        submitOptions
      );
    } finally {
      endResubmitChecklistGuard(transactionId);
    }
    if (result.success && !owedPullsLanded && !result.checklistsNotSent) {
      result.checklistsNotSent = "brokerChecklistsNotDownloaded";
    }
    return result;
  }

  /**
   * BACKLOG-3599: attempt every owed broker-checklist pull of this transaction.
   * Returns true when nothing is owed afterwards (or nothing was owed). A
   * success clears the marker (inside `retryOwedReviewChecklistPull`); a
   * failure keeps it for the sync pass. Never throws.
   *
   * If the local owed set cannot be READ, it returns true (logged): with no
   * evidence anything is owed, the agent is not told something is missing.
   * The sync pass still retries any marker that exists.
   */
  private async pullOwedReviewChecklistsBeforeResubmit(
    transactionId: string
  ): Promise<boolean> {
    let owed: string[];
    try {
      owed = getOwedReviewChecklistPullsFor(transactionId);
    } catch (error) {
      logService.warn(
        `[Submission] Could not read owed broker checklist pulls before resubmit: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
      return true;
    }
    if (owed.length === 0) return true;
    try {
      const client = supabaseService.getClient();
      let allLanded = true;
      for (const submissionId of owed) {
        // The resubmit's own pull: it runs inside the guard, before the new
        // version reads the local set.
        const outcome = await retryOwedReviewChecklistPull(
          client,
          transactionId,
          submissionId,
          { ownResubmit: true }
        );
        // BACKLOG-3595: the rows are committed; an open Checklist tab re-reads.
        if (
          outcome.status === "pulled" &&
          (outcome.added.length > 0 || outcome.removed.length > 0)
        ) {
          notifyChecklistsChanged(transactionId);
        }
        // BACKLOG-3607: "superseded" counts as landed - the version that pull
        // would have fed already exists, and the agent was told when it was
        // submitted. Only "kept" means something is still missing.
        if (outcome.status === "kept") {
          allLanded = false;
          logService.warn(
            `[Submission] Owed broker checklists for submission ${submissionId} could not be downloaded before resubmit: ${outcome.reason}`,
            "SubmissionService"
          );
        }
      }
      return allLanded;
    } catch (error) {
      logService.warn(
        `[Submission] Owed broker checklist check failed before resubmit: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
      return false;
    }
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
   * BACKLOG-3403: what can and cannot be sent, decided before anything is sent.
   * Runs the on-demand email attachment download first (inside the gather), so
   * an attachment that only needed downloading is never listed.
   */
  async preflightSubmission(
    transactionId: string
  ): Promise<SubmissionPreflightResult> {
    try {
      const gathered = await this.gatherForSubmission(transactionId);
      return {
        success: true,
        notIncluded: gathered.preflight.notIncluded,
        checklistLinkGaps: gathered.checklistLinkGaps,
      };
    } catch (error) {
      logService.warn(
        `[Submission] Pre-flight failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
      return {
        success: false,
        notIncluded: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * BACKLOG-3683 (founder decision B, narrowed 2026-10-05: the summary shows
   * in-window counts only, never an out-of-window notice): what a submission
   * with these dates would send. The dates are the ones on the date step, not
   * yet saved — `candidate` is the payload the renderer will save
   * (`confirmedDatesUpdate`), read through the same `auditPeriodFromRow` and
   * the same queries the submit uses. Nothing is downloaded here; the
   * pre-flight after the save stays the authority on which files can be sent.
   */
  async getSubmissionScope(
    transactionId: string,
    candidate: AuditPeriodSource
  ): Promise<SubmissionScopeResult> {
    try {
      const { auditStartDate, auditEndDate } = auditPeriodFromRow(candidate);
      // BACKLOG-3733: the texts the export would include, as the submit sends.
      const selected = await selectSubmissionTextIds(transactionId);
      const texts = databaseService.getTransactionMessages(transactionId, auditStartDate, auditEndDate, selected);
      const emails = databaseService.getTransactionEmails(transactionId, auditStartDate, auditEndDate);
      const attachments = databaseService.getTransactionAttachments(
        transactionId,
        auditStartDate,
        auditEndDate,
        selected
      );

      const inWindow = {
        emails: emails.length,
        texts: texts.length,
        textThreads: new Set(texts.map((m) => m.thread_id || `msg:${m.id}`)).size,
        attachments: attachments.length,
        emailAttachments: attachments.filter((a) => (a as Attachment & { email_id?: string | null }).email_id).length,
        attachmentBytes: attachments.reduce((sum, a) => sum + (Number(a.file_size_bytes) || 0), 0),
      };

      reportSubmissionScope(transactionId, {
        inWindow: {
          emails: inWindow.emails,
          texts: inWindow.texts,
          textThreads: inWindow.textThreads,
          attachments: inWindow.attachments,
        },
      });

      return { success: true, inWindow };
    } catch (error) {
      logService.warn(
        `[Submission] Scope preview failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService"
      );
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * BACKLOG-3398: stop the running submission. Refused once the final step has
   * begun — from then the server decides, and a cancel could only lie about
   * the outcome.
   */
  cancelSubmission(transactionId: string): CancelSubmissionResult {
    const active = this.active;
    if (!active || active.transactionId !== transactionId) {
      return { cancelled: false, reason: "not_running" };
    }
    if (active.finalizing) {
      return { cancelled: false, reason: "finalizing" };
    }
    active.controller.abort();
    logService.info(
      `[Submission] Cancel requested for ${transactionId}`,
      "SubmissionService"
    );
    return { cancelled: true };
  }

  /** BACKLOG-3398: the running submission, for {@link cancelSubmission}. */
  private active: {
    transactionId: string;
    controller: AbortController;
    finalizing: boolean;
  } | null = null;

  /**
   * Gather everything a submission sends, after the on-demand download, and
   * run the pre-flight over it. Shared by the pre-flight IPC and the submit,
   * so both see the same list.
   */
  private async gatherForSubmission(transactionId: string): Promise<{
    transaction: Transaction;
    messages: Message[];
    emails: Record<string, unknown>[];
    partyNames: HandleNameResolution;
    currentUserId: string;
    preflight: Awaited<ReturnType<typeof runSubmissionPreflight>>;
    checklistLinkGaps: ChecklistLinkGap[];
    sentEmailIds: Set<string>;
    sentAttachmentIds: Set<string>;
  }> {
    const transaction = await this.loadTransaction(transactionId);
    // BACKLOG-3683: the same reader the scope preview uses.
    const { auditStartDate, auditEndDate } = auditPeriodFromRow({
      started_at: transaction.started_at ?? null,
      closed_at: transaction.closed_at ?? null,
    });

    // BACKLOG-3733: one text set for the texts AND their attachments — the
    // texts the export of this deal would include (owner's copies, hidden
    // texts and reactions to them removed, duplicates collapsed).
    const selected = await selectSubmissionTextIds(transactionId);
    const messages = await this.loadTransactionMessages(
      transactionId,
      auditStartDate,
      auditEndDate,
      selected
    );
    const emails = await this.loadTransactionEmails(
      transactionId,
      auditStartDate,
      auditEndDate
    );
    // Downloads missing email attachment bytes FIRST (BACKLOG-1369), then reads.
    const attachments = await this.loadTransactionAttachments(
      transactionId,
      auditStartDate,
      auditEndDate,
      selected
    );
    const emailIds = emails
      .map((e) => e.id)
      .filter((id): id is string => typeof id === "string");
    const undownloaded =
      (emailIds.length > 0
        ? databaseService.getUndownloadedEmailAttachments(emailIds)
        : []) ?? [];

    const currentUserId = await this.getCurrentUserId();
    // BACKLOG-2757/2758: one resolver, scoped to this user and this
    // transaction, returning the same honest label the PDF prints.
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

    const preflight = await runSubmissionPreflight({
      messages,
      emails,
      attachments,
      undownloadedEmailAttachments: undownloaded,
      textLabel: (m) => this.textOtherPartyLabel(m, partyNames),
    });

    if (preflight.notIncluded.length > 0) {
      // Counts only: the list itself holds names.
      const byReason: Record<string, number> = {};
      for (const i of preflight.notIncluded) byReason[i.reason] = (byReason[i.reason] ?? 0) + 1;
      logService.warn(
        `[Submission] ${preflight.notIncluded.length} attachments cannot be sent`,
        "SubmissionService",
        { transactionId, byReason, attachmentsSendable: preflight.sendable.length }
      );
    }

    // BACKLOG-3764: checklist evidence that would not be sent, against the
    // dates on the row — which the date step saved before this ran
    // (SubmitForReviewModal `proceed` awaits the save, then submits).
    const sentEmailIds = new Set(emailIds);
    const sentAttachmentIds = new Set(preflight.sendable.map((a) => a.id));
    // A failed local read fails the submit the same way a failed checklist
    // copy does (BACKLOG-3600): nothing is sent, and the agent is told why.
    let localChecklists: Awaited<ReturnType<typeof getChecklistsForTransaction>>;
    try {
      localChecklists = await getChecklistsForTransaction(transactionId);
    } catch (error) {
      logService.warn(
        `[Submission] Checklists could not be read before submit: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionService",
        { transactionId }
      );
      throw new ChecklistsNotSentError();
    }
    const checklistLinkGaps = findChecklistLinkGaps({
      checklists: localChecklists,
      sentEmailIds,
      sentAttachmentIds,
      notIncluded: preflight.notIncluded,
      startedAt: transaction.started_at ?? null,
      closedAt: transaction.closed_at ?? null,
    });
    if (checklistLinkGaps.length > 0) {
      // Counts only: the list itself holds names.
      logService.warn(
        `[Submission] ${checklistLinkGaps.length} checklist links would not be sent`,
        "SubmissionService",
        {
          transactionId,
          outsideAuditDates: checklistLinkGaps.filter((g) => g.reason === "outside_audit_dates").length,
        }
      );
    }

    return {
      transaction,
      messages,
      emails,
      partyNames,
      currentUserId,
      preflight,
      checklistLinkGaps,
      sentEmailIds,
      sentAttachmentIds,
    };
  }

  /** The other party of a text, as the agent knows them. Display only. */
  private textOtherPartyLabel(
    message: Message,
    partyNames: HandleNameResolution
  ): string {
    let participants: Record<string, unknown> = {};
    try {
      participants =
        typeof message.participants === "string"
          ? JSON.parse(message.participants)
          : ((message.participants as unknown as Record<string, unknown>) ?? {});
    } catch {
      participants = {};
    }
    const to = Array.isArray(participants.to)
      ? (participants.to as unknown[])
      : participants.to
        ? [participants.to]
        : [];
    const handle =
      message.direction === "outbound"
        ? (to.find((h) => typeof h === "string" && h !== "me") as string | undefined)
        : (participants.from as string | undefined);
    if (!handle || typeof handle !== "string") return "";
    return nameForHandle(partyNames, handle) || handle;
  }

  /**
   * Internal submission implementation — BACKLOG-3403, all or nothing.
   *
   *   0  gather + pre-flight (download first); refuse if the agent has not
   *      confirmed exactly what will be left out
   *   1  clear a stale `uploading` row of this deal (fenced, files first)
   *   2  parent row as `uploading`         ┐ client-minted ids,
   *   3  messages, batches of 50           │ ON CONFLICT (id) DO NOTHING,
   *   4  attachment rows, exact paths      │ 3 tries each
   *   5  upload the files                  ┘ (the uploader retries 3 times)
   *   6  checklist snapshot
   *   7  finalize_submission(manifest)  — the server checks every piece and
   *      flips the status in one statement. From here no cancel.
   *   8  local status, from the server's answer only
   *
   * Any failure → the fence, then files, then rows; the agent is told nothing
   * was sent. A lost answer from step 7 → read the row before deleting
   * anything.
   */
  private async submitTransactionInternal(
    transactionId: string,
    options?: {
      version?: number;
      parentSubmissionId?: string;
    },
    onProgress?: (progress: SubmissionProgress) => void,
    submitOptions?: SubmitOptions
  ): Promise<SubmissionResult> {
    const submissionId = crypto.randomUUID();
    const controller = new AbortController();
    const signal = controller.signal;
    const isResubmit = !!options?.parentSubmissionId;
    const client = supabaseService.getClient();

    let stage: SubmissionStageName = "gather";
    let orgId: string | null = null;
    /** Set BEFORE the parent insert: once sent, the row may exist. */
    let parentSent = false;
    /** The `in_progress` attempt row was written (C1): only then a final one. */
    let attemptStarted = false;
    /** Known once the manifest is built / the snapshot ran (C3). */
    let cloudIdByLocalOuter = new Map<string, string>();
    let checklistsNotSentOuter: ChecklistsNotSentReason | undefined;
    /** BACKLOG-3764: the snapshot's backstop fired. */
    let checklistLinksNotAttached = false;
    let manifestPaths: string[] = [];
    let manifestCounts: ManifestCounts | null = null;
    let refusal: FinalizeRefusalCounts | null = null;
    let notIncluded: NotIncludedItem[] = [];

    const failedResult = (
      error: string,
      extra: Partial<SubmissionResult> = {}
    ): SubmissionResult => ({
      success: false,
      submissionId: null,
      error,
      messagesCount: 0,
      attachmentsCount: 0,
      // Nothing was submitted, so nothing was dropped from a submission.
      flaggedWithoutAttachments: 0,
      notIncluded: [],
      ...extra,
    });

    // S1: a local reference, so a second run on the singleton cannot null it.
    const active = { transactionId, controller, finalizing: false };
    this.active = active;
    this._isSubmitting = true;
    try {
      onProgress?.({
        stage: "preparing",
        stageProgress: 0,
        overallProgress: 0,
        currentItem: "Loading transaction data...",
      });

      // ---- 0. Gather + pre-flight -------------------------------------
      const gathered = await this.gatherForSubmission(transactionId);
      const { transaction, messages, emails, partyNames, currentUserId } = gathered;
      notIncluded = gathered.preflight.notIncluded;
      const sendable = gathered.preflight.sendable;

      // The agent confirmed a list; if it is no longer the same list, ask
      // again before anything is written.
      const accepted = new Set(submitOptions?.acceptedExclusionKeys ?? []);
      const checklistLinkGaps = gathered.checklistLinkGaps;
      if (
        notIncluded.some((item) => !accepted.has(item.key)) ||
        checklistLinkGaps.some((gap) => !accepted.has(gap.key))
      ) {
        logService.warn(
          `[Submission] Not sent: ${notIncluded.filter((i) => !accepted.has(i.key)).length} attachments and ${checklistLinkGaps.filter((g) => !accepted.has(g.key)).length} checklist links that would not be sent were not confirmed by the agent`,
          "SubmissionService",
          { transactionId }
        );
        return failedResult(
          submitOptions?.acceptedExclusionKeys === undefined
            ? PREFLIGHT_NOT_REVIEWED_ERROR
            : PREFLIGHT_CHANGED_ERROR,
          { preflightChanged: true, notIncluded, checklistLinkGaps }
        );
      }
      // BACKLOG-3764: what the snapshot may send, and what the agent confirmed
      // it would not.
      const snapshotSent = {
        emailIds: gathered.sentEmailIds,
        attachmentIds: gathered.sentAttachmentIds,
        acceptedMembers: gapMemberKeys(checklistLinkGaps),
      };
      throwIfCancelled(signal);

      orgId = await this.getUserOrganizationId();
      if (!orgId) {
        throw new Error("User is not a member of any organization");
      }
      const org: string = orgId;

      await this.guardExistingSubmission(client, org, transactionId, options);

      // ---- Manifest: every id minted here, every path built here ------
      const cloudIdByLocal = new Map<string, string>();
      cloudIdByLocalOuter = cloudIdByLocal;
      const textRecords = messages.map((m) => {
        const record = this.mapToSubmissionMessage(m, submissionId, partyNames);
        cloudIdByLocal.set(`text:${m.id}`, record.id);
        return record;
      });
      const emailRecords = emails.map((e) => {
        const record = this.mapEmailToSubmissionMessage(e, submissionId);
        cloudIdByLocal.set(`email:${record.local_message_id}`, record.id);
        return record;
      });
      const messageRecords = [...textRecords, ...emailRecords];

      const attachmentPlan = sendable.map((a) => {
        const row = a as SubmissionAttachment;
        // BACKLOG-3731: a text row is owned by the text the shared lookup resolved.
        const ownerKey = row.email_id ? `email:${row.email_id}` : `text:${row.resolved_message_id}`;
        const record: SubmissionAttachmentRecord = {
          id: crypto.randomUUID(),
          submission_id: submissionId,
          filename: row.filename || "unknown",
          mime_type: (mime.lookup(row.filename || "") || row.mime_type || "application/octet-stream") as string,
          file_size_bytes: gathered.preflight.sizeById.get(row.id) ?? row.file_size_bytes,
          storage_path: buildAttachmentStoragePath(org, submissionId, row.id, row.filename || "unknown"),
          document_type: row.document_type,
          local_attachment_id: row.id,
          // BACKLOG-3682: written at upload time from the manifest.
          message_id: cloudIdByLocal.get(ownerKey) ?? null,
        };
        return { local: row, record };
      });
      manifestPaths = attachmentPlan.map((p) => p.record.storage_path);

      const excludedFiles: ExcludedFileRecord[] = notIncluded.map((item) => ({
        filename: item.filename,
        kind: item.kind,
        message_id: cloudIdByLocal.get(`${item.kind}:${item.localMessageId}`) ?? null,
        sent_at: item.sentAt,
        source_label: item.label,
        reason: item.reason,
      }));

      const totalMessageCount = messageRecords.length;
      onProgress?.({
        stage: "preparing",
        stageProgress: 100,
        overallProgress: 10,
        currentItem: `Found ${messages.length} texts, ${emails.length} emails, ${attachmentPlan.length} attachments`,
      });

      // ---- 1. A stale `uploading` row of this deal ---------------------
      stage = "sweep";
      await this.sweepStaleUploads(client, org, transactionId);
      throwIfCancelled(signal);

      // ---- 2. Parent row as `uploading` --------------------------------
      stage = "parent";
      onProgress?.({
        stage: "transaction",
        stageProgress: 0,
        overallProgress: 15,
        currentItem: "Creating submission record...",
      });
      const submissionRecord = this.mapToSubmission(
        transaction,
        org,
        currentUserId,
        submissionId,
        totalMessageCount,
        attachmentPlan.length,
        options
      );
      // Hidden from the broker until finalize_submission flips it.
      submissionRecord.status = "uploading";
      if (excludedFiles.length > 0) {
        // The ONLY write of submission_metadata in this flow (a REST update
        // would replace the whole object).
        submissionRecord.submission_metadata = {
          ...(submissionRecord.submission_metadata ?? {}),
          excluded_files: excludedFiles,
        };
      }
      // C1 (SR 8fa92bef): the attempt starts HERE, after every guard and just
      // before the first write of this submission. Awaited, so a slow
      // `in_progress` can never land after (and overwrite) the final outcome.
      // A refusal before this point writes nothing and records no attempt.
      attemptStarted = true;
      await recordSubmissionAttempt(client, {
        submissionId,
        organizationId: org,
        outcome: "in_progress",
        stage: "parent",
        reasonCode: null,
        retryCount: 0,
        // BACKLOG-3715 (coordinator ruling): what this attempt is about to
        // send, flat snake_case whole numbers. The server merges counts with
        // `||`, so a later update keeps these unless it sends the same key.
        counts: inProgressAttemptCounts(
          messageRecords.length,
          attachmentPlan.length,
          excludedFiles.length
        ),
        isResubmit,
      });
      parentSent = true;
      try {
        await withStageRetry(
          "parent",
          () =>
            client
              .from("transaction_submissions")
              .upsert(submissionRecord, { onConflict: "id", ignoreDuplicates: true }),
          { signal }
        );
      } catch (error) {
        if (error instanceof SubmissionStageError && error.code === "23505") {
          /**
           * BACKLOG-3390 — THE LAST LINE OF DEFENCE DOES NOT SPEAK SQL.
           * `23505` on this insert can only be
           * UNIQUE (organization_id, local_transaction_id, version, submitted_by):
           * this user already has a submission of this transaction at this
           * version. The driver's text names the constraint; the user gets a
           * sentence. (ON CONFLICT (id) does not swallow this one.)
           */
          logService.error(
            `[Submission] Insert collided with an existing submission for ${transactionId} at version ${submissionRecord.version}`,
            "SubmissionService",
            // The driver's words stay in the local log, never in front of the user.
            { code: error.code, message: error.driverMessage }
          );
          throw new Error(
            "This transaction already has a submission at this version, so nothing new was sent. Close this window and reopen the transaction to refresh its status, then try again."
          );
        }
        throw error;
      }
      throwIfCancelled(signal);

      // ---- 3–6. Write, upload, snapshot (re-runnable) -----------------
      const writeAll = async (rerun: boolean, includeChecklists: boolean) => {
        stage = "messages";
        await this.insertMessagesBatched(client, messageRecords, signal, (pct) => {
          onProgress?.({
            stage: "messages",
            stageProgress: pct,
            overallProgress: 20 + pct * 0.2,
            currentItem: "Uploading messages...",
          });
        });

        stage = "attachment_rows";
        const rows = attachmentPlan.map((p) => p.record);
        for (let i = 0; i < rows.length; i += ATTACHMENT_ROW_BATCH_SIZE) {
          throwIfCancelled(signal);
          const batch = rows.slice(i, i + ATTACHMENT_ROW_BATCH_SIZE);
          await withStageRetry(
            "attachment_rows",
            () =>
              client
                .from("submission_attachments")
                .upsert(batch, { onConflict: "id", ignoreDuplicates: true }),
            { signal }
          );
        }

        stage = "uploads";
        for (let i = 0; i < attachmentPlan.length; i++) {
          throwIfCancelled(signal);
          const { local, record } = attachmentPlan[i];
          const base = (i / Math.max(attachmentPlan.length, 1)) * 100;
          const result = await supabaseStorageService.uploadAttachmentWithRetry(
            org,
            submissionId,
            local.id,
            local.storage_path || "",
            local.filename || "unknown",
            (progress) => {
              const pct = base + (progress.percentage / attachmentPlan.length);
              onProgress?.({
                stage: "attachments",
                stageProgress: pct,
                overallProgress: 40 + pct * 0.4,
                currentItem: `Uploading ${record.filename}...`,
              });
            },
            undefined,
            { earlierAttemptMayHaveSent: rerun }
          );
          if (!result?.success) {
            throw new SubmissionStageError(
              "uploads",
              null,
              true,
              3,
              "An attachment could not be uploaded"
            );
          }
          if (result.storagePath !== record.storage_path) {
            // One producer of the path; a mismatch is a bug, not a retry.
            throw new SubmissionStageError(
              "uploads",
              "path_mismatch",
              false,
              1,
              "An attachment was stored under an unexpected path"
            );
          }
        }

        if (includeChecklists) {
          stage = "checklists";
          throwIfCancelled(signal);
          const outcome = await snapshotSubmissionChecklists(
            client,
            submissionId,
            transactionId,
            snapshotSent
          );
          if (outcome.status === "failed") {
            if (outcome.kind === "transient") {
              throw new ChecklistsNotSentError();
            }
            return { checklists: null, checklistsNotSent: outcome.kind };
          }
          if (outcome.status === "none") return { checklists: 0, checklistsNotSent: undefined };
          if (outcome.linksNotAttached) checklistLinksNotAttached = true;
          return {
            checklists: outcome.counts ? outcome.counts.checklists : null,
            checklistsNotSent: undefined,
          };
        }
        return null;
      };

      const first = await writeAll(false, true);
      let manifestChecklists = first?.checklists ?? null;
      const checklistsNotSent: ChecklistsNotSentReason | undefined = first?.checklistsNotSent;
      checklistsNotSentOuter = checklistsNotSent;

      const manifest = () => ({
        message_ids: messageRecords.map((m) => m.id),
        attachments: attachmentPlan.map((p) => ({
          id: p.record.id,
          storage_path: p.record.storage_path,
          message_id: p.record.message_id,
        })),
        checklists: manifestChecklists,
      });
      manifestCounts = {
        messages: messageRecords.length,
        attachments: attachmentPlan.length,
        checklists: manifestChecklists,
      };

      // ---- 7. Finalize — the point of no return ------------------------
      throwIfCancelled(signal);
      stage = "finalize";
      active.finalizing = true;
      onProgress?.({
        stage: "finalizing",
        stageProgress: 0,
        overallProgress: 90,
        currentItem: "Finalizing submission...",
      });

      let answer = await this.callFinalize(client, submissionId, manifest());
      if (answer.kind === "refused" && answer.code === "incomplete") {
        // The refusal carries counts only, so re-send every piece once
        // (all idempotent) and ask again. The checklist snapshot runs again
        // only when the checklists are what is missing (it refuses a second
        // copy of a set that landed).
        refusal = pickRefusalCounts(answer.data);
        logService.warn(
          "[Submission] Finalize refused as incomplete; re-sending once",
          "SubmissionService",
          { submissionId, refusal }
        );
        const checklistsShort =
          typeof refusal.checklists_expected === "number" &&
          refusal.checklists_found !== refusal.checklists_expected;
        active.finalizing = false;
        const again = await writeAll(true, checklistsShort);
        if (again && again.checklists !== undefined && checklistsShort) {
          manifestChecklists = again.checklists;
        }
        // C2 (SR 8fa92bef): Cancel is accepted during the re-run, so check it
        // again before asking the server a second time.
        throwIfCancelled(signal);
        active.finalizing = true;
        answer = await this.callFinalize(client, submissionId, manifest());
      }

      let committedStatus: string | null = null;
      if (answer.kind === "ok") {
        committedStatus = answer.status;
      } else if (answer.kind === "refused" && answer.code === "not_uploading") {
        // The id is minted per attempt: out of `uploading` means OUR finalize
        // committed (SR condition 2). Read what it became.
        committedStatus = await this.readCommittedStatus(client, submissionId);
      } else if (answer.kind === "no_answer") {
        stage = "read_back";
        let row: { status: string } | null;
        try {
          row = await readSubmissionStatus(client, submissionId);
        } catch {
          // Do NOT clean up: it may have committed. Do not touch local state.
          throw new UnconfirmedSubmissionError();
        }
        if (!row) {
          throw new FinalizeFailedError("not_found", "finalize");
        }
        if (row.status !== "uploading") {
          committedStatus = row.status;
        } else {
          throw new FinalizeFailedError("retries_exhausted", "finalize", answer.code);
        }
      } else if (answer.kind === "refused") {
        if (answer.code === "incomplete") {
          refusal = pickRefusalCounts(answer.data);
          throw new FinalizeFailedError("finalize_refused", "finalize");
        }
        const reason: SubmissionFailureReason =
          answer.code === "abandoned"
            ? "abandoned"
            : answer.code === "not_owner"
              ? "not_owner"
              : answer.code === "not_found"
                ? "not_found"
                : "permanent_error";
        throw new FinalizeFailedError(reason, "finalize", answer.code);
      } else {
        throw new FinalizeFailedError(answer.reason, "finalize", answer.code);
      }

      // ---- 8. Local status, from the server's answer ------------------
      if (committedStatus) {
        await this.updateLocalSubmissionStatus(transactionId, {
          submission_status: committedStatus as SubmissionStatus,
          submission_id: submissionId,
          submitted_at: new Date().toISOString(),
        });
      } else {
        logService.warn(
          `[Submission] ${submissionId} committed but its status could not be read; local status left for the sync pass`,
          "SubmissionService"
        );
      }

      onProgress?.({
        stage: "complete",
        stageProgress: 100,
        overallProgress: 100,
        currentItem: "Submission complete",
      });

      const flaggedWithoutAttachments = new Set(
        notIncluded.map((i) => `${i.kind}:${i.localMessageId}`)
      ).size;
      logService.info(
        `[Submission] Transaction ${transactionId} submitted successfully as ${submissionId}`,
        "SubmissionService",
        {
          textsCount: messages.length,
          emailsCount: emails.length,
          totalMessages: totalMessageCount,
          attachmentsCount: attachmentPlan.length,
          // BACKLOG-3389: printed even when 0 — a printed zero is a measurement.
          flaggedWithoutAttachments,
          notIncluded: notIncluded.length,
        }
      );
      reportSubmissionExclusions(submissionId, notIncluded, cloudIdByLocal);

      return {
        success: true,
        submissionId,
        messagesCount: totalMessageCount,
        attachmentsCount: attachmentPlan.length,
        flaggedWithoutAttachments,
        notIncluded,
        ...(checklistsNotSent ? { checklistsNotSent } : {}),
        ...(checklistLinksNotAttached ? { checklistLinksNotAttached } : {}),
      };
    } catch (error) {
      return await this.handleSubmitFailure({
        error,
        client,
        transactionId,
        submissionId,
        orgId,
        stage,
        parentSent,
        manifestPaths,
        manifestCounts,
        refusal,
        notIncludedCount: notIncluded.length,
        notIncluded,
        cloudIdByLocal: cloudIdByLocalOuter,
        checklistsNotSent: checklistsNotSentOuter,
        checklistLinksNotAttached,
        attemptStarted,
        isResubmit,
        onProgress,
        failedResult,
      });
    } finally {
      if (this.active === active) this.active = null;
      this._isSubmitting = false;
    }
  }

  /**
   * Every failure after Submit lands here. The fence runs first (inside
   * `abandonSubmission`); if it finds the submission already committed, this
   * reports success instead — that is what "a lost answer is safe" means.
   */
  private async handleSubmitFailure(ctx: {
    error: unknown;
    client: SupabaseClient;
    transactionId: string;
    submissionId: string;
    orgId: string | null;
    stage: SubmissionStageName;
    parentSent: boolean;
    manifestPaths: string[];
    manifestCounts: ManifestCounts | null;
    refusal: FinalizeRefusalCounts | null;
    notIncludedCount: number;
    notIncluded: NotIncludedItem[];
    cloudIdByLocal: Map<string, string>;
    checklistsNotSent: ChecklistsNotSentReason | undefined;
    checklistLinksNotAttached: boolean;
    attemptStarted: boolean;
    isResubmit: boolean;
    onProgress?: (progress: SubmissionProgress) => void;
    failedResult: (error: string, extra?: Partial<SubmissionResult>) => SubmissionResult;
  }): Promise<SubmissionResult> {
    const { error, client, transactionId, submissionId, orgId, stage } = ctx;
    const cancelled = error instanceof SubmissionCancelledError;
    const unconfirmed = error instanceof UnconfirmedSubmissionError;

    let reason: SubmissionFailureReason;
    let errorCode: string | null = null;
    let attempts = 1;
    let shown: string;
    if (cancelled) {
      reason = "permanent_error";
      shown = SUBMISSION_CANCELLED_MESSAGE;
    } else if (unconfirmed) {
      reason = "unconfirmed";
      shown = SUBMISSION_UNCONFIRMED_ERROR;
    } else if (error instanceof FinalizeFailedError) {
      reason = error.reason;
      errorCode = error.code;
      shown = SUBMISSION_NOT_SENT_ERROR;
    } else if (error instanceof SubmissionStageError) {
      reason = error.transient ? "retries_exhausted" : "permanent_error";
      errorCode = error.code;
      attempts = error.attempts;
      shown = SUBMISSION_NOT_SENT_ERROR;
    } else if (error instanceof ChecklistsNotSentError) {
      reason = "retries_exhausted";
      shown = CHECKLISTS_NOT_SENT_ERROR;
    } else {
      // A guard's own refusal (already submitted, not a member, …): its
      // sentence is the report.
      reason = "permanent_error";
      shown = error instanceof Error ? error.message : "Unknown error";
    }

    logService.error(
      `[Submission] Failed to submit transaction ${transactionId} at ${stage}: ${cancelled ? "cancelled" : reason}${errorCode ? ` (${errorCode})` : ""}`,
      "SubmissionService"
    );

    // Clean up — fence first. Never after an unconfirmed finalize, and only
    // when the parent row may exist.
    let cleanupComplete: boolean | null = null;
    if (ctx.parentSent && !unconfirmed && !(error instanceof FinalizeFailedError && error.reason === "not_found")) {
      const abandoned = await abandonSubmission(client, submissionId, ctx.manifestPaths);
      cleanupComplete = abandoned.cleanupComplete;
      if (abandoned.outcome === "committed" && abandoned.status) {
        // The fence found it committed: it went through. Report the truth.
        logService.warn(
          `[Submission] ${submissionId} had committed (${abandoned.status}); nothing deleted`,
          "SubmissionService"
        );
        await this.updateLocalSubmissionStatus(transactionId, {
          submission_status: abandoned.status as SubmissionStatus,
          submission_id: submissionId,
          submitted_at: new Date().toISOString(),
        });
        ctx.onProgress?.({ stage: "complete", stageProgress: 100, overallProgress: 100, currentItem: "Submission complete" });
        // C3 (SR 8fa92bef): the same success as the main path — the agent
        // still sees what was left out, and the 3681 warning is still sent.
        reportSubmissionExclusions(submissionId, ctx.notIncluded, ctx.cloudIdByLocal);
        return {
          success: true,
          submissionId,
          messagesCount: ctx.manifestCounts?.messages ?? 0,
          attachmentsCount: ctx.manifestCounts?.attachments ?? 0,
          flaggedWithoutAttachments: new Set(
            ctx.notIncluded.map((i) => `${i.kind}:${i.localMessageId}`)
          ).size,
          notIncluded: ctx.notIncluded,
          ...(ctx.checklistsNotSent ? { checklistsNotSent: ctx.checklistsNotSent } : {}),
          ...(ctx.checklistLinksNotAttached ? { checklistLinksNotAttached: true } : {}),
        };
      }
      if (abandoned.outcome === "unknown") {
        logService.warn(
          `[Submission] Could not fence ${submissionId}; nothing deleted (it stays hidden from the broker)`,
          "SubmissionService"
        );
      }
    }

    // C1: a final outcome only for an attempt that started (its `in_progress`
    // row was written just before the parent write).
    if (orgId && ctx.attemptStarted) {
      await recordSubmissionAttempt(client, {
        submissionId,
        organizationId: orgId,
        outcome: cancelled ? "cancelled" : unconfirmed ? "unconfirmed" : "failed",
        stage,
        reasonCode: cancelled ? "user_cancelled" : reason,
        retryCount: attempts > 0 ? attempts - 1 : 0,
        counts: flatAttemptCounts(ctx.manifestCounts, ctx.notIncludedCount, ctx.refusal),
        isResubmit: ctx.isResubmit,
      });
    }

    if (!cancelled && ctx.parentSent) {
      reportSubmissionFailure({
        submissionId,
        isResubmit: ctx.isResubmit,
        stage,
        reason,
        attempts,
        errorCode,
        manifest: ctx.manifestCounts,
        refusal: ctx.refusal,
        cleanupComplete,
      });
    }

    // Supabase error_logs (fire-and-forget). The shown sentence only — never
    // the driver's text, which can carry a path or file name.
    if (!cancelled) {
      try {
        const session = await supabaseService.getAuthSession();
        await client.from("error_logs").insert({
          user_id: session?.userId ?? null,
          app_version: app.getVersion(),
          electron_version: process.versions.electron ?? null,
          os_name: os.platform(),
          os_version: os.release(),
          platform: process.arch,
          error_type: "submission_failure",
          error_message: shown,
          stack_trace: null,
          current_screen: "SubmitForReviewModal",
          app_state: { transactionId, submissionId, stage, reason, errorCode },
        });
      } catch {
        // Don't let error logging prevent the main error flow
      }
    }

    ctx.onProgress?.({
      stage: "failed",
      stageProgress: 0,
      overallProgress: 0,
      currentItem: shown,
    });

    return ctx.failedResult(shown, {
      ...(cancelled ? { cancelled: true } : {}),
      ...(unconfirmed ? { unconfirmed: true } : {}),
    });
  }

  /** Ask the server to finalize. Classifies every answer; never throws. */
  private async callFinalize(
    client: SupabaseClient,
    submissionId: string,
    manifest: Record<string, unknown>
  ): Promise<
    | { kind: "ok"; status: string }
    | { kind: "refused"; code: string; data: unknown }
    | { kind: "no_answer"; code: string | null }
    | { kind: "permanent"; reason: SubmissionFailureReason; code: string | null }
  > {
    try {
      const data = await withStageRetry("finalize", () =>
        client.rpc("finalize_submission", {
          p_submission_id: submissionId,
          p_manifest: manifest,
        })
      );
      const d = (data ?? {}) as { ok?: boolean; status?: string; code?: string };
      if (d.ok === true && typeof d.status === "string") {
        return { kind: "ok", status: d.status };
      }
      return { kind: "refused", code: typeof d.code === "string" ? d.code : "unknown", data };
    } catch (error) {
      if (error instanceof SubmissionStageError) {
        if (!error.transient) {
          // PGRST202: this database does not have finalize_submission. The
          // desktop has no fallback to the old client-side flip on purpose.
          return {
            kind: "permanent",
            reason: error.code === "PGRST202" ? "rpc_missing" : "permanent_error",
            code: error.code,
          };
        }
        return { kind: "no_answer", code: error.code };
      }
      return { kind: "no_answer", code: null };
    }
  }

  /** After `not_uploading`: the status our finalize committed, or null if unreadable. */
  private async readCommittedStatus(
    client: SupabaseClient,
    submissionId: string
  ): Promise<string | null> {
    try {
      const row = await readSubmissionStatus(client, submissionId);
      return row && row.status !== "uploading" ? row.status : null;
    } catch {
      return null;
    }
  }

  /**
   * Clear a stale `uploading` submission of this deal (an earlier attempt that
   * never finished) so the parent insert does not collide with it. Each goes
   * through the same fence → files → rows as any other abandon. Best effort: a
   * row that survives makes the insert refuse in plain words.
   */
  private async sweepStaleUploads(
    client: SupabaseClient,
    orgId: string,
    transactionId: string
  ): Promise<void> {
    let staleIds: string[] = [];
    try {
      const rows = (await withStageRetry("sweep", () =>
        client
          .from("transaction_submissions")
          .select("id")
          .eq("organization_id", orgId)
          .eq("local_transaction_id", transactionId)
          .eq("status", "uploading")
      )) as { id: string }[] | null;
      staleIds = (rows ?? []).map((r) => r.id);
    } catch {
      return;
    }
    for (const staleId of staleIds) {
      let paths: string[] = [];
      try {
        const rows = (await withStageRetry("sweep", () =>
          client
            .from("submission_attachments")
            .select("storage_path")
            .eq("submission_id", staleId)
        )) as { storage_path: string }[] | null;
        paths = (rows ?? []).map((r) => r.storage_path);
      } catch {
        // Without the paths the files cannot be named; leave the row alone.
        continue;
      }
      const result = await abandonSubmission(client, staleId, paths, {
        finishEarlierAbandon: true,
      });
      logService.info(
        `[Submission] Stale upload ${staleId}: ${result.outcome}`,
        "SubmissionService",
        { cleanupComplete: result.cleanupComplete, filesRemoved: result.filesRemoved }
      );
    }
  }

  /**
   * BACKLOG-2853 / 2867 / 3390 — refuse before anything is written when the
   * deal already has a submission the broker holds. Unchanged in substance;
   * moved out of the flow so the flow reads top to bottom.
   */
  private async guardExistingSubmission(
    client: SupabaseClient,
    orgId: string,
    transactionId: string,
    options?: { version?: number; parentSubmissionId?: string }
  ): Promise<void> {
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
      } else if (existingSubmission.status === "uploading") {
        /**
         * BACKLOG-3403 — an `uploading` row at this version is an earlier
         * attempt that never finished. It is NOT deleted here: a plain delete
         * would skip the fence and orphan its files (the bucket policies read
         * the row). The stale-upload sweep removes it — fence, files, rows —
         * right before the new parent insert.
         */
        logService.info(
          `[Submission] Earlier unfinished attempt ${existingSubmission.id} at version ${existingVersion} — left for the stale-upload sweep`,
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
    auditStartDate: Date | null | undefined,
    auditEndDate: Date | null | undefined,
    selected: SelectedTextIds
  ): Promise<Message[]> {
    const rows = databaseService.getTransactionMessages(transactionId, auditStartDate, auditEndDate, selected);

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
   * emails that advertise attachments whose BYTES are not stored locally, and
   * downloads them from the provider before querying.
   *
   * BACKLOG-3389: "whose bytes are not stored" is the corrected test. It used
   * to read "with no attachment records", which is what the SQL asked and what
   * silently dropped a metadata-only attachment from a submission.
   */
  private async loadTransactionAttachments(
    transactionId: string,
    auditStartDate: Date | null | undefined,
    auditEndDate: Date | null | undefined,
    selected: SelectedTextIds
  ): Promise<Attachment[]> {
    // Download missing email attachments before returning
    await this.downloadMissingEmailAttachments(transactionId);

    return databaseService.getTransactionAttachments(transactionId, auditStartDate, auditEndDate, selected);
  }

  private async downloadMissingEmailAttachments(transactionId: string): Promise<void> {
    // BACKLOG-3683: moved to emailAttachmentDownload.ts (shared with the PDF export).
    await downloadMissingEmailAttachmentsShared(transactionId, "[Submission]");
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
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  /**
   * BACKLOG-3403: every batch must land. Each row carries its minted id, so a
   * retried batch whose first answer was lost inserts nothing twice
   * (ON CONFLICT (id) DO NOTHING). A failure is thrown, never only warned.
   */
  private async insertMessagesBatched(
    client: SupabaseClient,
    records: SubmissionMessageRecord[],
    signal: AbortSignal,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const total = records.length;
    for (let i = 0; i < records.length; i += MESSAGE_BATCH_SIZE) {
      throwIfCancelled(signal);
      const batch = records.slice(i, i + MESSAGE_BATCH_SIZE);
      await withStageRetry(
        "messages",
        () =>
          client
            .from("submission_messages")
            .upsert(batch, { onConflict: "id", ignoreDuplicates: true }),
        { signal }
      );
      onProgress?.(Math.min(100, ((i + batch.length) / total) * 100));
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
}

// Export singleton
export const submissionService = new SubmissionService();
export default submissionService;
