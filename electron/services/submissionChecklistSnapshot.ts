/**
 * Submission checklist snapshot — BACKLOG-3477 (PR B).
 *
 * At submit and resubmit, every checklist on the transaction is copied to the
 * cloud submission as it stands, in ONE call to
 * `public.snapshot_submission_checklists(p_submission_id, p_checklists)`
 * (supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql §6).
 *
 * Two rules the caller depends on:
 *
 *   1. The call must happen while the submission is still `uploading`. The
 *      function runs as the caller, and the copy tables accept inserts only
 *      for the submitter's own `uploading` submission — after finalize every
 *      insert is refused. `submitTransactionInternal` calls this between the
 *      attachment insert and the finalize UPDATE.
 *
 *   2. A refused or failed snapshot never fails the submission. The function
 *      is all-or-nothing (one statement), so continuing never leaves a partial
 *      copy. The failure is logged and recorded as a breadcrumb.
 *
 * Evidence links are sent as LOCAL ids and matched server-side:
 *   attachment -> submission_attachments.local_attachment_id (written by
 *                 `mapToSubmissionAttachment`; every match is linked, the
 *                 column is not unique)
 *   email      -> submission_messages.local_message_id with channel 'email'
 * A local id with no uploaded counterpart is dropped by the function, and the
 * dropped counts come back in the result and are logged here.
 */

import * as Sentry from "@sentry/electron/main";
import { getChecklistsForTransaction } from "./db/checklistDbService";
import logService from "./logService";
import type { ChecklistsForTransaction } from "../types/checklist";

const LOG_CONTEXT = "SubmissionChecklistSnapshot";

/** The RPC name, exported so tests address the same function. */
export const SNAPSHOT_RPC = "snapshot_submission_checklists";

/** One evidence group, as the function reads it (migration §6). */
export interface SnapshotLinkPayload {
  kind: "attachment" | "email";
  label: string;
  sort_order: number;
  local_ids: string[];
}

/** One checklist row, as the function reads it (migration §6). */
export interface SnapshotItemPayload {
  title: string;
  description: string | null;
  is_required: boolean;
  expected_document_type: string | null;
  is_checked: boolean;
  note: string | null;
  sort_order: number;
  links: SnapshotLinkPayload[];
}

/** One checklist, as the function reads it (migration §6). */
export interface SnapshotChecklistPayload {
  template_id: string | null;
  template_name: string;
  sort_order: number;
  items: SnapshotItemPayload[];
}

/** The counts the function returns. */
export interface SnapshotResultCounts {
  checklists: number;
  items: number;
  links: number;
  members: number;
  dropped_members: number;
  dropped_links: number;
}

export type SnapshotOutcome =
  | { status: "none" }
  | { status: "written"; counts: SnapshotResultCounts | null }
  | { status: "failed"; code: string | null; message: string };

/** The one method of the Supabase client this module uses. */
export interface SnapshotRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

/**
 * Build the payload from the local read. Every checklist on the transaction,
 * in display order. Reviewer fields are never sent — the function refuses them.
 */
export function buildChecklistSnapshotPayload(
  local: ChecklistsForTransaction
): SnapshotChecklistPayload[] {
  return local.checklists.map((detail) => ({
    template_id: detail.checklist.templateId || null,
    template_name: detail.checklist.templateName,
    sort_order: detail.checklist.sortOrder,
    items: detail.items.map((item) => ({
      title: item.title,
      description: item.description,
      is_required: item.isRequired,
      expected_document_type: item.expectedDocumentType,
      is_checked: item.isChecked,
      note: item.note,
      sort_order: item.sortOrder,
      links: (detail.linksByItemId[item.id] ?? []).map((link) => ({
        kind: link.kind,
        label: link.label,
        sort_order: link.sortOrder,
        local_ids: link.members
          .map((member) => (link.kind === "attachment" ? member.attachmentId : member.emailId))
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      })),
    })),
  }));
}

/**
 * Copy every checklist of `transactionId` onto the cloud submission. Never
 * throws: a refusal or failure is logged and returned as `failed`.
 */
export async function snapshotSubmissionChecklists(
  client: SnapshotRpcClient,
  submissionId: string,
  transactionId: string
): Promise<SnapshotOutcome> {
  try {
    const local = await getChecklistsForTransaction(transactionId);
    if (local.checklists.length === 0) return { status: "none" };

    const payload = buildChecklistSnapshotPayload(local);
    const { data, error } = await client.rpc(SNAPSHOT_RPC, {
      p_submission_id: submissionId,
      p_checklists: payload,
    });

    if (error) {
      return recordFailure(submissionId, transactionId, error.code ?? null, error.message);
    }

    const counts = (data as SnapshotResultCounts | null) ?? null;
    logService.info(
      `[Submission] Checklists copied to submission ${submissionId}`,
      LOG_CONTEXT,
      { transactionId, sent: payload.length, counts }
    );
    return { status: "written", counts };
  } catch (err) {
    return recordFailure(
      submissionId,
      transactionId,
      null,
      err instanceof Error ? err.message : String(err)
    );
  }
}

function recordFailure(
  submissionId: string,
  transactionId: string,
  code: string | null,
  message: string
): SnapshotOutcome {
  logService.warn(
    `[Submission] Checklists were not copied to submission ${submissionId}; the submission continues without them`,
    LOG_CONTEXT,
    { transactionId, code, message }
  );
  Sentry.addBreadcrumb({
    category: "submission",
    message: "checklist snapshot failed",
    level: "warning",
    data: { submissionId, code },
  });
  return { status: "failed", code, message };
}
