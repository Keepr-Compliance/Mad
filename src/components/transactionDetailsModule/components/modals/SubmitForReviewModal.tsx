/**
 * Submit for Review Modal Component
 *
 * Confirmation modal for submitting a transaction to the broker portal.
 * Shows summary of what will be submitted and progress during submission.
 * Part of BACKLOG-391: Submit for Review UI.
 *
 * BACKLOG-3498: for a deal that can still be submitted (no status,
 * `not_submitted`, `needs_changes`) the dialog has two screens. Screen 1 is the
 * shared date step (the same component Export's Step 1 renders), titled
 * "Verify Transaction Details" by this dialog's own header; the block's heading
 * is not drawn, so the title is not said twice. Next leads to screen 2, the
 * lead and the Submission Summary, with Back. Pressing Submit saves the confirmed dates through the shared writer,
 * waits for the save, and only then submits. The statuses the modal blocks
 * render their single screen unchanged.
 */
import React, { useEffect, useRef, useState } from "react";
import { includeAnywayQuestion, outsideDatesSentence } from "../../utils/outsideAuditDatesCopy";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import {
  TransactionDatesFields,
  VERIFY_TRANSACTION_DETAILS_TITLE,
  saveConfirmedTransactionDates,
  useCommissionForm,
  useTransactionDatesForm,
  validateTransactionDates,
} from "../../../transactionDates";
import type { Transaction } from "@/types";
import { useSubmissionScope } from "../../hooks/useSubmissionScope";

export interface SubmitProgress {
  stage:
    | "preparing"
    | "attachments"
    | "transaction"
    | "messages"
    // BACKLOG-3398: the final step; the submission can no longer be cancelled.
    | "finalizing"
    | "complete"
    | "failed";
  stageProgress: number;
  overallProgress: number;
  currentItem?: string;
}

/**
 * BACKLOG-3600: why a successful submission's checklists did not reach the
 * broker. Mirrors `SubmissionResult.checklistsNotSent` in the main process
 * (a type cannot be value-imported across the boundary, so it is restated).
 */
export type ChecklistsNotSentReason =
  | "not_in_plan"
  | "refused"
  // BACKLOG-3599 (resubmit only): the broker's review checklists were still
  // owed and could not be downloaded first.
  | "brokerChecklistsNotDownloaded";

/** The one amber line the success screen shows for each reason. */
export const CHECKLISTS_NOT_SENT_COPY: Record<ChecklistsNotSentReason, string> = {
  not_in_plan:
    "Submitted, but your checklists were not sent: checklists are not included in your current plan.",
  refused: "Submitted, but your checklists could not be sent to your broker.",
  brokerChecklistsNotDownloaded:
    "Submitted, but the checklists your broker added could not be downloaded first, so this version does not include them.",
};

/**
 * BACKLOG-3681 / BACKLOG-3403: why an attachment is not sent. Mirrors
 * `NotIncludedReason` in electron/services/submissionPreflight.ts (a type
 * cannot be value-imported across the boundary, so it is restated).
 *
 * BACKLOG-3403 supersedes BACKLOG-2758's "couldn't be uploaded" line: under
 * all-or-nothing a failed upload fails the whole submission, so a success
 * screen can no longer report one.
 */
export type NotIncludedReason =
  | "email_attachment_not_downloaded"
  | "text_attachment_not_on_this_computer"
  | "file_missing_on_this_computer"
  | "file_too_large"
  // BACKLOG-3731: why the macOS import skipped the file.
  | "text_attachment_not_downloaded_by_messages"
  | "text_attachment_too_large_to_import"
  | "text_attachment_type_not_imported"
  | "text_attachment_unreadable";

/** One attachment (or one message's attachments) that is not sent. */
export interface NotIncludedItem {
  key: string;
  kind: "text" | "email";
  localMessageId: string;
  /** BACKLOG-3731: the conversation, for grouping. Null when unknown. */
  threadId: string | null;
  sentAt: string | null;
  label: string;
  filename: string | null;
  reason: NotIncludedReason;
  localAttachmentId: string | null;
}

/**
 * BACKLOG-3764: one checklist group whose evidence this submission would not
 * send. Mirrors `ChecklistLinkGap` in
 * electron/services/submissionChecklistLinkGaps.ts (restated: the renderer
 * cannot value-import across the boundary).
 */
export interface ChecklistLinkGapItem {
  key: string;
  linkId: string;
  itemTitle: string;
  label: string;
  kind: "attachment" | "email";
  reason: "outside_audit_dates" | "not_included";
  detail: "not_on_transaction" | "cannot_be_sent" | "message_not_sent" | "not_sent" | null;
  missingIds: string[];
  sentAt: string | null;
  auditStart: string | null;
  auditEnd: string | null;
}

/** BACKLOG-3764: shown on success when evidence was dropped that was never listed. */
export const CHECKLIST_LINKS_NOT_ATTACHED_COPY =
  "Submitted, but some files or emails linked to checklist items were not attached to them.";

/**
 * BACKLOG-3764 (SR ruling §6): the line for evidence a yes cannot bring in.
 * "Not included on this checklist item", never "will not be sent": a duplicate
 * text's file may still be sent under the kept copy.
 */
export function checklistLinkGapLine(gap: ChecklistLinkGapItem): string {
  const why =
    gap.detail === "not_on_transaction"
      ? "it is no longer on this transaction."
      : gap.detail === "cannot_be_sent"
        ? "it can't be sent (listed above)."
        : gap.detail === "message_not_sent"
          ? "the message it came with isn't in this submission."
          : "it isn't in this submission.";
  return `Not included on this checklist item (${gap.itemTitle}): ${gap.label} — ${why}`;
}

/** The heading over the list, before sending and after. */
export const NOT_INCLUDED_HEADING_BEFORE =
  "These attachments can't be sent:";
export const NOT_INCLUDED_HEADING_AFTER =
  "Not included — your broker won't see these attachments:";

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * BACKLOG-3731: the import's limit for copying a text attachment. Mirrors
 * `MAX_ATTACHMENT_SIZE` in electron/services/macOSMessagesImportService/types.ts
 * (restated: the renderer cannot value-import from electron/). A parity test
 * pins the two together.
 */
export const IMPORT_SIZE_LIMIT_MB = 100;

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Which message the item came from: "Text with X" / "Email "subject"". */
export function notIncludedSource(item: NotIncludedItem): string {
  return item.kind === "text"
    ? `Text with ${item.label || "an unknown sender"}`
    : `Email "${item.label || "(no subject)"}"`;
}

/**
 * BACKLOG-3731: why the item is not sent, as one plain sentence. Each reason
 * says only what is known: a text with no recorded reason does not claim one.
 */
export function notIncludedReasonText(item: NotIncludedItem): string {
  const file = item.filename || (item.kind === "text" ? "a photo or file" : "an attachment");
  switch (item.reason) {
    case "text_attachment_not_on_this_computer":
      return "Keepr doesn't have a copy of a photo or file from this text.";
    case "text_attachment_not_downloaded_by_messages":
      return `${capitalize(file)} isn't on this Mac. To include it, open this chat in Messages on this Mac, download the attachment, then sync your messages.`;
    case "text_attachment_too_large_to_import":
      return `${capitalize(file)} is larger than ${IMPORT_SIZE_LIMIT_MB} MB, the largest file Keepr imports.`;
    case "text_attachment_type_not_imported":
      return `${capitalize(file)} is a type of file Keepr doesn't import.`;
    case "text_attachment_unreadable":
      return `Keepr couldn't read ${file} on this Mac.`;
    case "email_attachment_not_downloaded":
      return `${capitalize(file)} couldn't be downloaded from the mailbox.`;
    case "file_missing_on_this_computer":
      return `${capitalize(file)} is no longer on this computer.`;
    case "file_too_large":
      return `${capitalize(file)} is larger than 50 MB.`;
  }
}

/**
 * BACKLOG-3681: one line per item — which message, when, which file, why.
 * Factual; no "submit again" (after a successful submit the deal is with the
 * broker and cannot be resubmitted until it comes back).
 */
export function notIncludedLine(item: NotIncludedItem): string {
  const when = shortDate(item.sentAt);
  const source = notIncludedSource(item);
  const head = when ? `${source}, ${when}` : source;
  return `${head} — ${notIncludedReasonText(item)}`;
}

/** BACKLOG-3731: one conversation's items in the grouped list. */
export interface NotIncludedGroup {
  key: string;
  source: string;
  items: NotIncludedItem[];
}

/**
 * BACKLOG-3731: group items by conversation (thread), in the order each
 * conversation first appears. An item with no thread groups by its source
 * line, so it still joins others from the same contact or subject.
 */
export function groupNotIncluded(items: NotIncludedItem[]): NotIncludedGroup[] {
  const groups = new Map<string, NotIncludedGroup>();
  for (const item of items) {
    const source = notIncludedSource(item);
    const key = `${item.kind}:${item.threadId ?? `label:${source}`}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { key, source, items: [item] });
  }
  return [...groups.values()];
}

/** BACKLOG-3731: lines shown before "Show more", across all groups. */
export const NOT_INCLUDED_VISIBLE_LINES = 5;

/**
 * BACKLOG-3731 (founder 6e7b4c31): the not-included list, grouped by
 * conversation with a count, and the first few lines shown until "Show more".
 * Used before sending (the warning) and after (the success list).
 */
export function NotIncludedList({
  items,
  testId,
}: {
  items: NotIncludedItem[];
  testId: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const groups = groupNotIncluded(items);
  let budget = expanded ? Number.POSITIVE_INFINITY : NOT_INCLUDED_VISIBLE_LINES;
  const hidden = Math.max(0, items.length - NOT_INCLUDED_VISIBLE_LINES);
  return (
    <div data-testid={testId}>
      <ul className="mt-1 space-y-2">
        {groups.map((group) => {
          if (budget <= 0) return null;
          const shown = group.items.slice(0, budget);
          budget -= shown.length;
          const count = group.items.length;
          return (
            <li key={group.key} data-testid={`${testId}-group`}>
              <p className="font-medium">
                {group.source} — {count} {count === 1 ? "attachment" : "attachments"}
              </p>
              <ul className="list-disc pl-5 space-y-1">
                {shown.map((item) => {
                  const when = shortDate(item.sentAt);
                  const text = notIncludedReasonText(item);
                  return (
                    <li key={item.key} data-testid={`${testId}-line`}>
                      {when ? `${when} — ${text}` : text}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="mt-1 underline"
          data-testid={`${testId}-toggle`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show more (${hidden})`}
        </button>
      )}
    </div>
  );
}

/** BACKLOG-3398: shown after a cancel. Mirrors SUBMISSION_CANCELLED_MESSAGE. */
export const SUBMISSION_CANCELLED_COPY =
  "Submission cancelled. Nothing was sent to your broker.";

interface SubmitForReviewModalProps {
  transaction: Transaction;
  /** @deprecated Use emailCount and textThreadCount instead */
  messageCount?: number;
  /**
   * Number of EMAILS on the deal — not threads (BACKLOG-2838).
   *
   * The caller passes `transaction.email_count`, computed as
   * COUNT(DISTINCT c.email_id) (transactionDbService.ts). This prop was called
   * `emailThreadCount` and rendered under the label "Email threads:", so a deal
   * with 99 emails across 40 conversations read "Email threads: 99". The value
   * was never wrong; the name and the word around it were, and a prop whose
   * name contradicts its contents is what produced the mis-labelling in the
   * first place. Renamed to what it holds.
   *
   * `textThreadCount` below genuinely IS threads, so the two labels are
   * deliberately asymmetric — each says what its number counts.
   */
  emailCount: number;
  /** Number of text message threads */
  textThreadCount: number;
  /** Total attachment count (text + email) */
  attachmentCount: number;
  /** Email attachment count specifically */
  emailAttachmentCount: number;
  /** Total size of all attachments in bytes */
  totalSizeBytes: number;
  isSubmitting: boolean;
  progress: SubmitProgress | null;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  /**
   * Opens the export flow for this deal, closing this modal on the way.
   *
   * BACKLOG-2849 renamed it from `onExportFirst`: "first" described a
   * pre-submit nudge that no longer exists, and the SAME callback now backs
   * both offers — the action button beside Submit, and the post-submit ask.
   * One action, one handler. The label here is the founder's "Export PDF";
   * the header's restored button reaches the same place as "Export".
   *
   * The destination is the founder's ruling that "the export flow it brings up
   * should be just like the individual user export": this opens the SAME
   * ExportModal that `useCompleteTransaction` gives an individual on Complete,
   * not a brokerage-specific path. TransactionDetails owns that wiring and a
   * test pins the two entry points to one component by identity.
   */
  onExport?: () => void;
  /**
   * BACKLOG-3498: called once the confirmed dates have been SAVED, before the
   * submit runs and whatever the submit then does. TransactionDetails re-reads
   * the row here, so its tabs and the Edit form show the saved dates even when
   * the submit fails.
   */
  onDatesSaved?: () => void;
  /**
   * BACKLOG-3600: set when the submission succeeded but its checklists did not
   * reach the broker. Rendered only on the success screen.
   */
  checklistsNotSent?: ChecklistsNotSentReason | null;
  /**
   * BACKLOG-3681: each attachment left out of a successful submission, and
   * why. Rendered only on the success screen.
   */
  notIncluded?: NotIncludedItem[];
  /** BACKLOG-3403: the pre-flight (download + check) is running. */
  isCheckingFiles?: boolean;
  /**
   * BACKLOG-3403: attachments that cannot be sent, shown BEFORE anything is
   * sent with Go back / Continue anyway. `null` = no question pending.
   */
  preflightItems?: NotIncludedItem[] | null;
  /** BACKLOG-3403: the list changed after the agent confirmed it. */
  preflightChanged?: boolean;
  /** BACKLOG-3764: checklist evidence this submission would not send. */
  preflightLinkGaps?: ChecklistLinkGapItem[];
  /** BACKLOG-3764: "Include it" for a group outside the audit dates. */
  onIncludeLinkGap?: (gap: ChecklistLinkGapItem) => void;
  /** BACKLOG-3764: on success, evidence was dropped that was never listed. */
  checklistLinksNotAttached?: boolean;
  /** BACKLOG-3403: Go back — nothing is sent. */
  onPreflightBack?: () => void;
  /** BACKLOG-3403: Continue anyway — send the rest. */
  onPreflightContinue?: () => void;
  /** BACKLOG-3398: the agent cancelled; nothing was sent. */
  cancelled?: boolean;
  /** BACKLOG-3398: the cancel is being carried out. */
  isCancelling?: boolean;
  /** BACKLOG-3398: really cancel the running submission. */
  onCancelSubmit?: () => void;
}

/**
 * BACKLOG-3520 — the panel owns its height and clips (`sm:overflow-hidden`);
 * the body region inside scrolls, so the scrollbar sits inside the rounded
 * frame instead of on the panel's outer edge. Padding lives on the header,
 * body and footer rows (not here) so the scrollbar is not inset by it.
 */
const SUBMIT_PANEL = "max-w-xl sm:h-auto sm:max-h-[90vh] sm:overflow-hidden";

const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing submission...",
  attachments: "Uploading attachments...",
  transaction: "Creating submission record...",
  messages: "Uploading messages...",
  finalizing: "Finalizing submission...",
  complete: "Submission complete!",
  failed: "Submission failed",
};

/**
 * Format bytes to human-readable size (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function SubmitForReviewModal({
  transaction,
  emailCount,
  textThreadCount,
  attachmentCount,
  emailAttachmentCount,
  totalSizeBytes,
  isSubmitting,
  progress,
  error,
  onCancel,
  onSubmit,
  onExport,
  onDatesSaved,
  checklistsNotSent = null,
  notIncluded = [],
  isCheckingFiles = false,
  preflightItems = null,
  preflightChanged = false,
  preflightLinkGaps = [],
  onIncludeLinkGap,
  checklistLinksNotAttached = false,
  onPreflightBack,
  onPreflightContinue,
  cancelled = false,
  isCancelling = false,
  onCancelSubmit,
}: SubmitForReviewModalProps): React.ReactElement {
  /**
   * BACKLOG-2853 — THE DEAL ALREADY HAS A SUBMISSION SITTING WITH THE BROKER.
   *
   * These four statuses are exactly the ones `submissionService`'s
   * `blockedStatuses` refuses (electron/services/submissionService.ts), so
   * pressing the action in any of them produces a thrown error, never a
   * submission. Until this change the modal rendered a live, ENABLED button
   * reading "Submit" for every one of them — `isResubmit` was true only for
   * `needs_changes` — with nothing on screen saying a submission already
   * existed. Measured on the re-entry state the founder's report names
   * (`submission_status: "submitted"`, `progress: null`, which is what
   * `resetSubmit()` leaves behind):
   *   {"submitButtonLive":true,"submitDisabled":false,
   *    "readsResubmit":false,"warnsAboutExisting":false}
   *
   * THE LIST IS DUPLICATED, NOT SHARED, AND THAT IS DELIBERATE. The renderer
   * cannot value-import from `electron/` (Vite parses it as JavaScript) and
   * `electron/` cannot import from `src/` (`rootDir`), so a single shared
   * constant would need a mirrored module plus a parity test. BACKLOG-2853
   * judged that "out of proportion to four string literals" and pinned only
   * the SET on each end. BACKLOG-2868 is what that judgement cost: the SET was
   * pinned, THE WORDS WERE NOT, and the words are what the user reads.
   *
   * `resubmitted` IS here now — BACKLOG-3390 — and this paragraph used to end
   * "not widened here". It predicted the defect precisely and deferred it:
   *
   *   "Pressing the button there runs a plain submit that always dies on the
   *    unique key after a full attachment upload. Leaving it enabled is
   *    therefore NOT the 'honest label' that comment claimed — it is an
   *    inviting control that cannot work."
   *
   * That is exactly what the founder hit in released v2.37.0 on 2026-09-16,
   * minus the diagnosis: the app offered Resubmit for Review after a successful
   * resubmit, and the press died minutes later on a raw unique-constraint name.
   * The reason it dies is that this modal LABELS the action for `resubmitted`
   * (see `isResubmit` below) while the routing in `TransactionDetails.tsx` does
   * not — so "Resubmit" runs a plain first submit at version 1 against a deal
   * whose version 1 still exists.
   *
   * The fix is on the service's list, not in this file's routing: a
   * `resubmitted` deal is with the broker and must not be sent again at all.
   * This entry is the mirror of that decision, and the control it disables is
   * the founder's defect 1 ("offered when it cannot succeed") — which the
   * service-side guard alone could not have reached, because it only runs after
   * a press.
   */
  /**
   * BACKLOG-2868 — ONE MESSAGE FOR FOUR DIFFERENT STATES IS THREE WRONG
   * MESSAGES.
   *
   * ===========================================================================
   * THIS IS A MIRROR. THE CANONICAL COPY IS
   * `electron/services/submissionStatusMessages.ts`.
   * ===========================================================================
   *
   * Walk the case that filed this. An agent submits a deal; her broker REJECTS
   * it. `TransactionHeader` keeps Complete visible in every state and its
   * `isSubmitted` badge set covers only `submitted | under_review | approved`,
   * so a rejected deal shows no badge and a live Complete button — one click to
   * here. BACKLOG-2853 then told her, in the only lead paragraph it wrote:
   *
   *   "...is with your broker for review. It cannot be submitted again — if
   *    your broker asks for changes, you will be able to resubmit it here."
   *
   * It is not with her broker for review; he rejected it. He is not going to
   * ask for changes. She waits for a message that is never coming.
   *
   * (The walkthrough is deliberately unnamed. This repo is PUBLIC and has a
   * PII-purge history where removing a name after merge means history surgery;
   * the named version of this case lives on BACKLOG-2868 in Supabase.)
   *
   * And it compounds. The accurate line already existed in the service, and
   * before BACKLOG-2853 she reached it by pressing the (enabled) button and
   * reading the thrown error. That change disabled the button. So the wrong
   * explanation was shown AND the right one was made unreachable — which is
   * why the fix is copy that renders BEFORE any press, not a better error.
   *
   * EACH LEAD CONTAINS ITS CANONICAL SERVICE MESSAGE VERBATIM. The parity test
   * asserts containment rather than equality, so this mirror may add a
   * next-step sentence the service has no room for (see `rejected`) without
   * being able to drift from what the service would have said. Edit
   * `submissionStatusMessages.ts` without editing here and that test goes red.
   *
   * `submitted` keeps BACKLOG-2853's own phrasing rather than being harmonised
   * to the service's. It is accurate, the founder has tested this screen, and
   * rewording an accurate string for symmetry is the same unrequested widening
   * that produced this defect.
   */
  const BLOCKED_STATUS_COPY: Record<string, { title: string; lead: string }> = {
    submitted: {
      title: "Already Submitted",
      lead: "This transaction has already been submitted and is with your broker for review. It cannot be submitted again — if your broker asks for changes, you will be able to resubmit it here.",
    },
    under_review: {
      title: "Under Review",
      lead: "Cannot resubmit while broker is reviewing. Please wait for their decision.",
    },
    resubmitted: {
      /**
       * BACKLOG-3390. A distinct title, not a reuse of "Already Submitted":
       * the whole point of this map is that a status is told something true of
       * ITSELF, and the parity test asserts the other statuses' titles are
       * absent at each one.
       *
       * The lead is the canonical service string VERBATIM and adds nothing —
       * that sentence already carries both halves a blocked screen needs
       * (nothing is going to be sent; here is what unblocks it). `rejected` is
       * the case where the service's error has no room for a next step and
       * this mirror supplies one; there is no such gap here, and inventing an
       * extra sentence for symmetry is what BACKLOG-2868 was filed on.
       */
      title: "Already Resubmitted",
      lead: "This transaction has already been resubmitted and is waiting for your broker to review the new version. If your broker asks for more changes you will be able to resubmit again.",
    },
    approved: {
      title: "Already Approved",
      lead: "This submission has already been approved. There is nothing further to send.",
    },
    rejected: {
      title: "Submission Rejected",
      /**
       * The canonical string is exactly "This submission has been rejected." —
       * four words with no next step. The filing for BACKLOG-2868 quoted it as
       * "This submission was rejected. Please contact your broker." and that
       * sentence exists nowhere in this repo (swept case-insensitively). So the
       * canonical half here is the REAL string, transcribed, and the broker
       * instruction is added by this mirror — which is the whole reason the
       * parity test asserts containment. Whether the service's own error should
       * carry the instruction too is raised on BACKLOG-2868, not taken here.
       */
      lead: "This submission has been rejected. Please contact your broker.",
    },
  };
  const blockedCopy = BLOCKED_STATUS_COPY[transaction.submission_status ?? ""];

  /**
   * DERIVED FROM THE COPY MAP, NOT FROM A SECOND LIST. BACKLOG-2853 kept a
   * separate `WITH_BROKER_STATUSES` array here; once the copy is per-status,
   * carrying both means a status can be disabled with no copy written for it,
   * or given copy while staying enabled — the same two-lists-one-rule shape
   * that caused this item, reproduced inside a single file. The map's keys ARE
   * the set, so a status cannot be added to one and missed by the other.
   */
  const submissionIsWithBroker = blockedCopy !== undefined;

  /**
   * Label-only, and BACKLOG-3390 is what that cost. Routing lives in
   * TransactionDetails.tsx, which computes its own `isResubmit` from
   * `needs_changes` ALONE. So this disjunct made the button say "Resubmit" on a
   * `resubmitted` deal while the press ran a plain first submit — a label and a
   * routing that named different acts, which is how an offered action became an
   * unavoidable duplicate-key failure.
   *
   * The disjunct is now INERT, and that is stated rather than assumed: this
   * value has exactly three readers in this file — the title, the lead and the
   * button text — and at `resubmitted` all three are decided by the
   * `blockedCopy` / `submissionIsWithBroker` branch that sits in front of them.
   * It is kept rather than deleted because it is still a true statement of the
   * act, and because deleting it would move the BACKLOG-2849 button-literal
   * suite for a string nothing renders. If a fourth reader is ever added
   * WITHOUT such a branch in front of it, this disjunct wakes up — check it
   * then.
   */
  const isResubmit =
    transaction.submission_status === "needs_changes" ||
    transaction.submission_status === "resubmitted";
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const isActivelySubmitting = isSubmitting && progress?.stage !== "complete" && progress?.stage !== "failed";
  /**
   * BACKLOG-3398: the final step has begun. The server decides from here, so
   * Cancel is not offered — a cancel now could only misreport the outcome.
   */
  const isFinalizing = isActivelySubmitting && progress?.stage === "finalizing";
  /** BACKLOG-3403: the pre-flight question is on screen. */
  const showPreflight = !isSubmitting && preflightItems !== null;

  /**
   * BACKLOG-2849 — the submit SUCCEEDED. Load-bearing, and not the same test
   * as "not submitting": `isSubmitting` flips back to false in the hook's
   * `finally`, so after a successful run the state is
   * `!isSubmitting && !error` — indistinguishable from the idle state the
   * summary block was gated on. Without this flag the post-submit ask would
   * render UNDERNEATH a re-shown Submission Summary.
   *
   * `!error` is part of the condition, not decoration: `stage: "complete"` is
   * only ever set on the success branch, but pairing the two means a future
   * producer that leaves a stale "complete" behind a failure cannot offer the
   * user a keep-a-copy prompt for a submission that did not happen.
   */
  const isSuccess = progress?.stage === "complete" && !error;

  /**
   * BACKLOG-3498 — the date step.
   *
   * It applies exactly when the deal is not blocked. `blockedCopy` is the ONLY
   * gate: `screen` starts at "dates" for every status, so a blocked deal is
   * kept off the step by this term alone.
   *
   * `datesError` holds both the date-rule message and a failed save
   * ("Failed to save dates: …"). It is local, not the hook's `error`: routing a
   * failed save through `error` would hide the date fields under a
   * "Submission Failed" heading. A save that fails on a RETRY after a failed
   * submit (when the hook's `error` is still set) must also land on the date
   * step, hence the `datesError !== null` escape in `showDateStep`.
   */
  const dateStepApplies = blockedCopy === undefined;
  const [screen, setScreen] = useState<"dates" | "summary">("dates");
  const { dates, setDate } = useTransactionDatesForm(transaction);
  // BACKLOG-3520 — the commission block of the same step.
  const commission = useCommissionForm(transaction);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [savingDates, setSavingDates] = useState(false);
  // BACKLOG-3683: the summary counts what the dates on this step include.
  const { state: scopeState, load: loadScope } = useSubmissionScope(transaction.id);
  /**
   * Where the date step applies, the summary's numbers are the in-window
   * ones — never the all-linked totals passed in, which include items the
   * submission will not send (founder decision B).
   */
  const scopeApplies = dateStepApplies && scopeState.status !== "idle";
  const scopeReady = dateStepApplies && scopeState.status === "ready" ? scopeState : null;
  const scopePending = scopeApplies && scopeReady === null;
  const shownEmailCount = scopeReady ? scopeReady.scope.inWindow.emails : emailCount;
  const shownEmailAttachmentCount = scopeReady
    ? scopeReady.scope.inWindow.emailAttachments
    : emailAttachmentCount;
  const shownTextThreadCount = scopeReady ? scopeReady.scope.inWindow.textThreads : textThreadCount;
  const shownAttachmentCount = scopeReady ? scopeReady.scope.inWindow.attachments : attachmentCount;
  const shownTotalSizeBytes = scopeReady ? scopeReady.scope.inWindow.attachmentBytes : totalSizeBytes;
  const pendingMark = scopeState.status === "failed" ? "—" : "…";
  const showDateStep =
    dateStepApplies &&
    screen === "dates" &&
    !isSubmitting &&
    !isSuccess &&
    // BACKLOG-3403 / 3398: the pre-flight question, the file check and the
    // cancelled notice each replace the screen they were reached from.
    !isCheckingFiles &&
    preflightItems === null &&
    !cancelled &&
    (!error || datesError !== null);

  /**
   * Set once the dialog is dismissed or unmounted. A save still in flight must
   * not go on to submit a dialog the user has closed: while the save runs,
   * `isSubmitting` is false, so the X closes immediately (no confirm) and the
   * awaited continuation would otherwise fire `onSubmit`.
   */
  const dismissedRef = useRef(false);
  useEffect(() => {
    dismissedRef.current = false;
    return () => {
      dismissedRef.current = true;
    };
  }, []);

  const handleCancelClick = () => {
    // During the final step the confirm is not rendered (see its gate), so
    // the X raises nothing; while a cancel is running it does nothing either.
    if (isCancelling) {
      return;
    }
    if (isActivelySubmitting) {
      setShowCancelConfirm(true);
    } else {
      dismissedRef.current = true;
      onCancel();
    }
  };

  const handleNext = () => {
    const message = validateTransactionDates(dates);
    setDatesError(message);
    if (message !== null) return;
    // An unparseable figure blocks Next — its message is already shown inline
    // by the commission block. An EMPTY commission never does: the block shows
    // an inline warning and Next proceeds.
    if (!commission.parsed.ok) return;
    void loadScope(dates);
    setScreen("summary");
  };

  const handleBack = () => {
    setDatesError(null);
    setScreen("dates");
  };

  /**
   * Submit: save the confirmed dates, WAIT for the save, then submit. The
   * submission reads its audit period from the stored row, so submitting
   * before the save lands would send the old dates.
   *
   * Re-entry is prevented by `savingDates` in the button's `disabled`
   * expression, not by a check in here.
   */
  // BACKLOG-3477: the unticked-required-items warning no longer lives here.
  // TransactionDetails shows it before this window opens (ChecklistWarningDialog).
  const proceed = async () => {
    if (!dateStepApplies) {
      onSubmit();
      return;
    }
    setDatesError(null);
    setSavingDates(true);
    // With nothing to say about commission the call is exactly the two-argument
    // call it was before BACKLOG-3520.
    const saved = commission.update
      ? await saveConfirmedTransactionDates(transaction.id, dates, commission.update)
      : await saveConfirmedTransactionDates(transaction.id, dates);
    if (saved.success) onDatesSaved?.();
    if (dismissedRef.current) return;
    setSavingDates(false);
    if (!saved.success) {
      setDatesError(`Failed to save dates: ${saved.error}`);
      setScreen("dates");
      return;
    }
    onSubmit();
  };

  return (
    /*
      BACKLOG-2849 — the backdrop routes through `handleCancelClick`, the SAME
      handler as the X. It used to be wired straight to `onCancel`, so the two
      dismiss affordances disagreed: the X raised the mid-upload "Cancel Anyway
      / Keep Uploading" confirm and the backdrop dropped a running submission
      without one. Once the founder's rule is "a deal that did not submit must
      still look unsubmitted, and one that did must look submitted", an
      inconsistent dismiss is a correctness question, not polish — the two ways
      out have to land in the same state.
    */
    <ResponsiveModal
      onClose={handleCancelClick}
      zIndex="z-[70]"
      panelClassName={SUBMIT_PANEL}
      testId="submit-review-modal"
    >
        {/*
          Header. BACKLOG-2849, founder test 2026-08-24 — on SUCCESS the icon
          and the title both change, because after the success toast
          auto-dismisses (5000ms) this header is the only thing left on screen,
          and it was still asking a question the user had already answered.

          THE GREEN IS NOT A NEW GREEN. `bg-green-100 text-green-700` and the
          check path `M5 13l4 4L19 7` are lifted from the Submitted badge in
          TransactionHeader.tsx — the same badge this deal now carries on the
          screen behind this modal. The point of matching it is that the two
          read as ONE signal: whatever told him "submitted" here is what he
          sees on the deal afterwards. The colour lives on the disc and the
          glyph inherits it, exactly as the badge is built.

          Note the token: the badge's green is `text-green-700`. The RETIRED
          success callout (removed earlier in this ticket) drew its duplicate
          check in `text-green-600`. They are deliberately different tokens,
          which is what lets the suite keep asserting `.text-green-600` at zero
          as a guard against that callout returning.
        */}
        <div className="flex items-center gap-3 mb-4 flex-shrink-0 px-6 pt-6" data-testid="submit-review-header">
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${
              isSuccess ? "bg-green-100 text-green-700" : "bg-blue-100"
            }`}
          >
            <svg
              className={isSuccess ? "w-6 h-6" : "w-6 h-6 text-blue-600"}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={
                  isSuccess
                    ? "M5 13l4 4L19 7"
                    : "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                }
              />
            </svg>
          </div>
          {/*
            TITLE — his words: "the title should say successfully submitted not
            submit for review". SUCCESS ONLY; idle and mid-upload keep the
            question they are actually asking.

            ONE literal on both branches, resubmit included. He gave one
            string; "Successfully Resubmitted" would be a word he did not say,
            invented to fill a branch he did not mention. The consequence is
            real and disclosed rather than designed around: after a successful
            RESUBMIT this header reads "Successfully Submitted", so the success
            screen no longer distinguishes a first submit from a resubmit. One
            line if he wants it to.
          */}
          <h3 className="text-lg font-bold text-gray-900">
            {isSuccess
              ? "Successfully Submitted"
              : /* BACKLOG-3498 — the date screen's title (founder, 2026-09-21:
                   "I don't think we need both Submit for Review and Verify
                   Transaction Details"). The shared block's own heading is
                   not drawn on this screen. The summary screen, blocked
                   statuses and success keep their titles. */
              showDateStep
              ? VERIFY_TRANSACTION_DETAILS_TITLE
              : /* BACKLOG-2853 — the title carried the same lie as the button:
                   a deal already sitting with the broker was asked "Submit for
                   Review?", a question about an act the service will refuse.
                   Success still wins the branch, so a submit that has just
                   completed reads "Successfully Submitted" exactly as before —
                   this only changes the state the user ARRIVES in.

                   BACKLOG-2868 — and it is now the status's own title, not one
                   title for four states. "Already Submitted" over a REJECTED
                   deal describes a submission that is still in play. */
              blockedCopy
              ? blockedCopy.title
              : isResubmit
              ? "Resubmit for Review"
              : "Submit for Review"}
          </h3>
          {/*
            BACKLOG-2849 — the founder removed the Cancel button and asked for
            an X at the top right. This is ImportPlanDialog's dismiss, copied
            class-for-class: same `max-w-md p-6` ResponsiveModal, same
            icon-circle + h3 header row, and it exists there for the same
            reason he gave here — the way out of a "what are we asking?" dialog
            is an unobtrusive close, not a third button competing with the
            answers.

            It routes through `handleCancelClick`, NOT raw `onCancel`. Mid
            upload that raises the "Cancel Anyway / Keep Uploading" confirm,
            which is the whole reason that confirm exists; wiring the X
            straight to `onCancel` would silently abort a running submission.
          */}
          <button
            onClick={handleCancelClick}
            data-testid="submit-review-close"
            aria-label="Close"
            className="ml-auto -mt-1 -mr-1 p-1 text-gray-400 hover:text-gray-600 rounded transition-all"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/*
          BACKLOG-3520 — the scrolling region. The panel owns its height and
          clips (SUBMIT_PANEL), so a scrollbar can only appear here, inside the
          rounded frame; the header above and the action row below stay fixed
          and the buttons never scroll out of view.
        */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6" data-testid="submit-review-body">
        {/*
          BACKLOG-3498 — screen 1, the date step. The date fields ONLY; the
          lead ("…The following data will be sent to your broker:") stays with
          the Submission Summary on screen 2.
        */}
        {showDateStep && (
          <div className="mb-4" data-testid="submit-review-dates">
            {datesError && (
              <div
                className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg"
                data-testid="submit-review-dates-error"
              >
                <p className="text-sm text-red-800">{datesError}</p>
              </div>
            )}
            <TransactionDatesFields
              transaction={transaction}
              dates={dates}
              onDateChange={setDate}
              hideHeading
              commission={commission}
              commissionRoute="submit"
            />
          </div>
        )}

        {/* Content - not submitting, not yet submitted (screen 2 when the date step applies) */}
        {!isSubmitting && !error && !isSuccess && !showDateStep && !isCheckingFiles && !showPreflight && !cancelled && (
          <>
            <p className="text-sm text-gray-600 mb-4" data-testid="submit-review-lead">
              {/* BACKLOG-2853 — "The following data will be sent to your
                  broker" is a promise the service will not keep in these
                  states. What replaces it names the two things the user needs:
                  that nothing is going to be sent, and what the way forward is
                  (the broker asking for changes), so the dialog is not a dead
                  end with an unexplained disabled button. Export PDF stays on
                  screen beside it, which is the one action still available.

                  BACKLOG-2868 — "the way forward is the broker asking for
                  changes" is true of ONE of the four statuses this branch
                  covers. At `rejected` there is no such way forward, and at
                  `approved` there is nothing to wait for. Each status now
                  carries the line that is true of it. */}
              {blockedCopy
                ? blockedCopy.lead
                : isResubmit
                ? "You are about to resubmit this transaction for broker review. Your broker will be notified of the changes."
                : "You are about to submit this transaction for broker review. The following data will be sent to your broker:"}
            </p>

            {/* Summary */}
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">
                Submission Summary
              </h4>
              <div className="space-y-2">
                {/* Property */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                    />
                  </svg>
                  <span className="text-gray-600">Property:</span>
                  <span className="font-medium text-gray-900 truncate">
                    {transaction.property_address || "No address"}
                  </span>
                </div>

                {/* Email Threads */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  <span className="text-gray-600">Emails:</span>
                  <span className="font-medium text-gray-900" data-testid="submit-review-email-count">
                    {scopePending ? pendingMark : shownEmailCount}
                    {!scopePending && shownEmailAttachmentCount > 0 && (
                      <span className="text-gray-500 font-normal">
                        {" "}({shownEmailAttachmentCount} {shownEmailAttachmentCount === 1 ? "attachment" : "attachments"})
                      </span>
                    )}
                  </span>
                </div>

                {/* Text Threads */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                  <span className="text-gray-600">Text threads:</span>
                  <span className="font-medium text-gray-900" data-testid="submit-review-text-thread-count">
                    {scopePending ? pendingMark : shownTextThreadCount}
                  </span>
                </div>

                {/* Total Attachments with Size */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                    />
                  </svg>
                  <span className="text-gray-600">Total attachments:</span>
                  <span className="font-medium text-gray-900" data-testid="submit-review-attachment-count">
                    {scopePending ? pendingMark : (
                      <>
                        {shownAttachmentCount} {shownAttachmentCount === 1 ? "file" : "files"}
                        {shownTotalSizeBytes > 0 && (
                          <span className="text-gray-500 font-normal">
                            {" "}({formatBytes(shownTotalSizeBytes)})
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* BACKLOG-3683: the in-window counts above couldn't be loaded. */}
            {scopeState.status === "failed" && dateStepApplies && (
              <div
                className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                role="status"
                data-testid="submit-review-scope-failed"
              >
                Couldn&apos;t count what falls inside these dates. Only emails and texts dated from the start date to the end date will be sent.
              </div>
            )}

            {/*
              BACKLOG-2849 — the pre-submit export SECTION is gone: the blue
              callout, "Want to keep a local copy first?" and "Export to folder
              before submitting" with it. The founder moved that ask to AFTER a
              successful submit (see the success block below), so the offer no
              longer competes with the decision the user is here to make.

              The export ACTION survives as a plain button beside Submit — his
              point 2, "two buttons: Submit and Export PDF" — shipped as
              "Export", see the label note on that button. What moved is the
              nudge, not the capability.
            */}
          </>
        )}

        {/*
          BACKLOG-2849 — the post-submit ask. Gated on `isSuccess`, so it is
          reachable ONLY from a submission that actually succeeded: not from
          the idle screen (no progress), not from a failure (`stage: "failed"`,
          `error` set), and not mid-upload.

          ONE SENTENCE, NO CARD, NO ICON — the founder's correction of
          2026-08-24 after testing the success screen: "we don't need the same
          text and check mark twice, keep the top one, remove this". What he
          pasted was this block in its earlier shape: a blue callout with its
          OWN green check-circle and its own "Submitted to your broker." line,
          sitting directly under the header's check-circle. Two check-circle
          glyphs in one small dialog, saying the same thing twice.

          So the confirmation is left to whatever renders above this — the
          header and the success toast — and what survives here is only the
          part that is this block's job: pointing at the Export PDF button
          below. His wording, verbatim, lowercase "export pdf" and all.

          DISMISSING LOSES NOTHING — the deal is submitted either way, and the
          export is still reachable. PROVISIONAL: the founder did not rule on
          dismissibility, so this takes the conservative reading (the X and the
          backdrop both close it). See the BACKLOG-2849 report.
        */}
        {/*
          BACKLOG-3600 — the submission succeeded but the broker did not get
          its checklists (a plan without checklists, or a refused copy). A
          network failure never lands here: it fails the submission instead.
          BACKLOG-3599 — or a resubmit could not first download the
          checklists the broker added at review.
        */}
        {isSuccess && checklistLinksNotAttached && (
          <p
            data-testid="submit-review-checklist-links-not-attached"
            role="status"
            className="text-sm text-amber-700 mb-4"
          >
            {CHECKLIST_LINKS_NOT_ATTACHED_COPY}
          </p>
        )}
        {isSuccess && checklistsNotSent && (
          <p
            data-testid="submit-review-checklists-not-sent"
            role="status"
            className="text-sm text-amber-700 mb-4"
          >
            {CHECKLISTS_NOT_SENT_COPY[checklistsNotSent]}
          </p>
        )}
        {/*
          BACKLOG-3681 — the submission succeeded without some attachments
          (the agent chose Continue anyway). Grouped by conversation (BACKLOG-3731); one line per file:
          when, which file, why. Same amber as above.
        */}
        {isSuccess && notIncluded.length > 0 && (
          <div
            data-testid="submit-review-not-included"
            role="status"
            className="text-sm text-amber-700 mb-4"
          >
            <p className="font-medium">{NOT_INCLUDED_HEADING_AFTER}</p>
            <NotIncludedList items={notIncluded} testId="submit-review-not-included-list" />
          </div>
        )}
        {/* BACKLOG-3403 — downloading and checking the files before sending. */}
        {isCheckingFiles && !isSubmitting && (
          <div className="flex items-center gap-3 mb-4" data-testid="submit-review-checking">
            <svg className="w-5 h-5 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm font-medium text-gray-900">Checking attachments...</span>
          </div>
        )}
        {/*
          BACKLOG-3403 — founder 2026-10-04: warn ahead of time and let the
          agent decide. Nothing has been sent while this is on screen.
        */}
        {showPreflight && preflightItems && (
          <div
            data-testid="submit-review-preflight"
            className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 text-sm text-amber-800"
          >
            {preflightChanged && (
              <p className="mb-2" data-testid="submit-review-preflight-changed">
                Some attachments changed since you reviewed them, so nothing was sent yet.
              </p>
            )}
            {preflightItems.length > 0 && (
              <>
                <p className="font-medium">{NOT_INCLUDED_HEADING_BEFORE}</p>
                <NotIncludedList items={preflightItems} testId="submit-review-preflight-list" />
              </>
            )}
            {/* BACKLOG-3764: checklist evidence this submission would not send. */}
            {preflightLinkGaps.length > 0 && (
              <ul className={`space-y-2 ${preflightItems.length > 0 ? "mt-3" : ""}`} data-testid="submit-review-link-gaps">
                {preflightLinkGaps.map((gap) =>
                  gap.reason === "outside_audit_dates" ? (
                    <li key={gap.key} data-testid="submit-review-link-gap-outside">
                      <p className="font-medium">{gap.itemTitle}: {gap.label}</p>
                      <p>
                        {outsideDatesSentence(
                          gap.kind === "attachment" ? "file" : gap.missingIds.length > 1 ? "conversation" : "email",
                          gap.sentAt,
                          gap.auditStart,
                          gap.auditEnd,
                        )}{" "}
                        {includeAnywayQuestion(1)}
                      </p>
                      <button
                        type="button"
                        className="mt-1 underline font-medium"
                        onClick={() => onIncludeLinkGap?.(gap)}
                        data-testid="submit-review-link-gap-include"
                      >
                        Include it
                      </button>
                    </li>
                  ) : (
                    <li key={gap.key} data-testid="submit-review-link-gap-not-included">
                      {checklistLinkGapLine(gap)}
                    </li>
                  ),
                )}
              </ul>
            )}
            <p className="mt-2">
              {preflightItems.length > 0
                ? "Continue anyway to send everything else. Your broker will see which files weren't included."
                : "Continue anyway to send everything else."}
            </p>
          </div>
        )}
        {/* BACKLOG-3398 — the cancel really cancelled. */}
        {cancelled && !isSubmitting && (
          <p
            data-testid="submit-review-cancelled"
            role="status"
            className="text-sm text-gray-700 mb-4"
          >
            {SUBMISSION_CANCELLED_COPY}
          </p>
        )}
        {isSuccess && (
          <p
            data-testid="submit-review-success-ask"
            className="text-sm text-gray-600 mb-4"
          >
            Want to keep a local copy, click the export pdf button below
          </p>
        )}

        {/* Progress display */}
        {isSubmitting && progress && (
          <div className="mb-4">
            <div className="flex items-center gap-3 mb-3">
              {progress.stage !== "complete" && progress.stage !== "failed" && (
                <svg
                  className="w-5 h-5 text-blue-600 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              )}
              {progress.stage === "complete" && (
                <svg
                  className="w-5 h-5 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
              <span className="text-sm font-medium text-gray-900">
                {STAGE_LABELS[progress.stage] || progress.stage}
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  progress.stage === "complete"
                    ? "bg-green-500"
                    : progress.stage === "failed"
                    ? "bg-red-500"
                    : "bg-blue-600"
                }`}
                style={{ width: `${progress.overallProgress}%` }}
              />
            </div>

            {/* Current item */}
            {progress.currentItem && (
              <p className="text-xs text-gray-500 truncate">
                {progress.currentItem}
              </p>
            )}
          </div>
        )}

        {/* Error display. Not over the date step: a failed date save shows its own message there (BACKLOG-3498). */}
        {error && !showDateStep && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">
                  Submission Failed
                </p>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Cancel confirmation */}
        {showCancelConfirm && isActivelySubmitting && !isFinalizing && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">
                  Submission in progress
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  {/* BACKLOG-3398 — what Cancel now really does. */}
                  {isCancelling
                    ? "Cancelling..."
                    : "Cancel this submission? Nothing will be sent to your broker."}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={isCancelling}
                    className="px-3 py-1.5 bg-amber-100 text-amber-800 hover:bg-amber-200 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                  >
                    Keep Uploading
                  </button>
                  <button
                    onClick={() => {
                      // BACKLOG-3398: stop the submission in the main process;
                      // the window stays open until it reports back.
                      if (onCancelSubmit) onCancelSubmit();
                      else onCancel();
                    }}
                    disabled={isCancelling}
                    data-testid="submit-review-cancel-confirm"
                    className="px-3 py-1.5 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                  >
                    Cancel Submission
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        </div>

        {/*
          Actions. BACKLOG-2849 removed the Cancel/Close row button entirely —
          dismissal is the X in the header (and the backdrop). What is left is
          the founder's pair: Export and Submit.
        */}
        <div className="flex items-center gap-3 justify-end flex-shrink-0 px-6 pb-6 pt-4" data-testid="submit-review-footer">
          {/* BACKLOG-3498 — Back to the date step, on screen 2 only. */}
          {dateStepApplies && !isSubmitting && !error && !isSuccess && !showDateStep && !isCheckingFiles && !showPreflight && !cancelled && (
            <button
              onClick={handleBack}
              disabled={savingDates}
              data-testid="submit-review-back"
              className="mr-auto px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Back
            </button>
          )}
          {/*
            EXPORT PDF — one button, one label, one handler, in both of the
            places the founder asked for it: beside Submit before the decision,
            and as the action on the post-submit ask. Hidden only while an
            upload is actually running, where leaving the modal would abort it.

            LABEL — "Export PDF", the founder's own wording from point 2 of
            the dictation. It was briefly shipped as "Export" and reverted: a
            relabel of his words is his call to make, not one to take on his
            behalf.

            The open question, raised for him rather than answered here: this
            opens ExportModal, a FORMAT CHOOSER — `combined-pdf` is
            preselected, but `folder` and a summary `pdf` are one tile away, so
            the button names a default rather than a commitment. The header
            Export button restored beside it reaches the SAME chooser under the
            shorter label "Export" (its wording since BACKLOG-459), so the two
            routes to one destination currently read differently. SR review
            ruled the mismatch acceptable and the label keepable. See the PR
            body's label proposal.
          */}
          {onExport && !isActivelySubmitting && !showCancelConfirm && (
            <button
              onClick={onExport}
              data-testid="submit-review-export"
              className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                isSuccess
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "border border-gray-300 text-gray-700 hover:bg-gray-100"
              }`}
            >
              Export PDF
            </button>
          )}
          {showDateStep ? (
            /* BACKLOG-3498 — screen 1's primary. Disabled until Start and End
               are filled, as Export's Step 1 primary is. */
            <button
              onClick={handleNext}
              disabled={!dates.startDate || !dates.endDate}
              data-testid="submit-review-next"
              className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          ) : showPreflight ? (
            <>
              <button
                onClick={onPreflightBack}
                data-testid="submit-review-preflight-back"
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
              >
                Go back
              </button>
              <button
                onClick={onPreflightContinue}
                data-testid="submit-review-preflight-continue"
                className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all"
              >
                Continue anyway
              </button>
            </>
          ) : cancelled || isCheckingFiles ? null : !progress?.stage || progress.stage === "failed" ? (
            <button
              onClick={() => {
                void proceed();
              }}
              /* BACKLOG-2853 — disabled in the four states the service
                 refuses. The click could be left live and allowed to surface
                 the service's error, but that spends a multi-minute attachment
                 upload before the refusal in the shape this code had, and it
                 asks the user to discover by failure what the screen can just
                 say.
                 BACKLOG-3498 — and while the date save runs, so a second press
                 cannot save and submit twice (useSubmitForReview.submit has no
                 re-entry guard). */
              disabled={isSubmitting || submissionIsWithBroker || savingDates}
              data-testid="submit-review-submit"
              className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Submitting...
                </>
              ) : submissionIsWithBroker ? (
                /* BACKLOG-2853 — never a bare "Submit" on a deal that already
                   has a submission with the broker. The label states the state
                   the deal is in, which is also the reason the control is
                   dead. */
                "Already Submitted"
              ) : isResubmit ? (
                "Resubmit"
              ) : (
                /* BACKLOG-2792: the submit action reads "Submit" at EVERY
                   responsive size — never "Submit for review" and never a
                   truncated variant of it. One literal, so there is no size at
                   which a different string can appear. */
                "Submit"
              )}
            </button>
          ) : null}
          {/*
            DONE — BACKLOG-2849, founder test 2026-08-24: "can we add a done
            button next to the export pdf". Success only; it is the action that
            finishes the flow, so it sits LAST in this `justify-end` row — the
            same terminal slot Submit occupies on the idle screen, and the same
            shape as the repo's other success screens (ExportModal step 5 puts
            Done last beside the optional Open Audit; SupportTicketDialog's
            success Done is this same filled blue).

            It routes through `handleCancelClick`, the SAME handler as the X
            and the backdrop, rather than raw `onCancel`. On this screen the
            two are equivalent — a completed submit is not `isActivelySubmitting`,
            so no confirm can fire — but keeping ONE dismissal path is the
            invariant this file already holds, and it is what stops a future
            change that renders Done in another state from silently aborting a
            running upload.

            EXPORT PDF ABOVE IS UNTOUCHED — same handler, same classes, same
            position. That leaves two filled blue buttons side by side, which
            is this repo's existing success-screen convention rather than an
            oversight. Whether Export PDF should step back to the outlined
            secondary now that it is no longer the only action on the screen is
            a visual-weight preference, raised in the report for the founder,
            not decided here.
          */}
          {(isSuccess || (cancelled && !isSubmitting)) && (
            <button
              onClick={handleCancelClick}
              data-testid="submit-review-done"
              className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all"
            >
              Done
            </button>
          )}
        </div>
    </ResponsiveModal>
  );
}

export default SubmitForReviewModal;
