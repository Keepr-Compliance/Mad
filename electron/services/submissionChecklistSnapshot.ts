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
 *   2. (BACKLOG-3600) A failure is classified before anything acts on it:
 *
 *      - TRANSIENT (no SQLSTATE, PGRST* except PGRST202 and PGRST203, 08*,
 *        40001, 57014, 53*, a timeout, a thrown error): the call is retried with the SAME payload, up to
 *        `SNAPSHOT_RETRY.attempts` calls, each bounded by
 *        `SNAPSHOT_RETRY.attemptTimeoutMs`. Still failing -> `failed` with
 *        kind `transient`, and the caller FAILS the submission while it is
 *        still `uploading`, so the broker never sees a version without its
 *        checklists and the agent can simply try again.
 *      - 23505 on a retry that follows a transient failure: the earlier call
 *        committed and its response was lost. The function is one statement
 *        (all or nothing) and the header index
 *        `submission_checklists_submission_template_key` fires on any repeat,
 *        so the copy is complete -> `written`. A 23505 on the FIRST call is
 *        contract drift and takes the permanent path.
 *      - PERMANENT: 42501 (the org's plan does not include checklists — the
 *        only term of the insert policy that can fail for the submitter's own
 *        `uploading` row) -> kind `not_in_plan`; any other code, including
 *        PGRST202 (function not in the schema cache) and PGRST203 (more than
 *        one matching signature), which fail on the first call without a
 *        retry -> kind `refused`, reported to Sentry. The caller finalizes the submission and
 *        tells the agent the checklists were not sent. A plan never locks
 *        submission. (BACKLOG-3607) This applies to a non-empty payload only:
 *        a permanent refusal of `[]` left nothing out, so it returns `none`
 *        (logged, not reported) and the agent is told nothing.
 *
 * Evidence links are sent as LOCAL ids and matched server-side:
 *   attachment -> submission_attachments.local_attachment_id (written by
 *                 `mapToSubmissionAttachment`; every match is linked, the
 *                 column is not unique)
 *   email      -> submission_messages.local_message_id with channel 'email'
 * A local id with no uploaded counterpart is dropped by the function, and the
 * dropped counts come back in the result.
 *
 * BACKLOG-3764: with `sent` given (the submit always gives it), only the local
 * ids this submission uploads are sent; a group left with none is not sent.
 * Every member held back that way was listed in the submit pre-flight and
 * confirmed by the agent (`sent.acceptedMembers`). A member held back WITHOUT
 * that, or any member the function still drops, is a defect: it is reported to
 * Sentry and the outcome says `linksNotAttached`, which the agent is told.
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
  /**
   * The local `transaction_checklist_items.id` (BACKLOG-3596). Created once by
   * `selectChecklistTemplate` and never rewritten, so every version of one
   * transaction sends the same id for the same item. The server matches it
   * against the previous version to carry the broker's review marks forward.
   */
  local_item_id: string;
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

/**
 * How a failed snapshot is treated (BACKLOG-3600).
 *   transient    -> the caller fails the submission (nothing reaches the broker)
 *   not_in_plan  -> the caller submits and tells the agent (plan has no checklists)
 *   refused      -> the caller submits and tells the agent (any other refusal)
 */
export type SnapshotFailureKind = "transient" | "not_in_plan" | "refused";

/**
 * BACKLOG-3764: what this submission uploads, and the group members the agent
 * confirmed would not be sent (`linkId:localId`).
 */
export interface SnapshotSentSets {
  emailIds: ReadonlySet<string>;
  attachmentIds: ReadonlySet<string>;
  acceptedMembers: ReadonlySet<string>;
}

export type SnapshotOutcome =
  | { status: "none" }
  | {
      status: "written";
      counts: SnapshotResultCounts | null;
      /** BACKLOG-3764: evidence was dropped that the agent was not told about. */
      linksNotAttached?: boolean;
    }
  | {
      status: "failed";
      kind: SnapshotFailureKind;
      code: string | null;
      message: string;
    };

/**
 * Retry budget (BACKLOG-3600). Mutable so tests can shorten the waits; the
 * production values give a worst case under 50 s (3 x 15 s + 1 s + 3 s).
 */
export const SNAPSHOT_RETRY: {
  attempts: number;
  attemptTimeoutMs: number;
  backoffMs: number[];
} = {
  attempts: 3,
  attemptTimeoutMs: 15000,
  backoffMs: [1000, 3000],
};

/**
 * PostgREST codes that no retry can fix (BACKLOG-3599): the function is not in
 * the schema cache (PGRST202) or more than one signature matches the call
 * (PGRST203). Both are schema drift, so they take the permanent `refused` path.
 */
const PERMANENT_PGRST_CODES: ReadonlySet<string> = new Set(["PGRST202", "PGRST203"]);

/**
 * A thrown or timed-out call carries no SQLSTATE; it is transient. Every
 * PGRST* code is transient EXCEPT PGRST202 and PGRST203, which are permanent.
 */
function isTransientCode(code: string | null): boolean {
  if (!code) return true;
  if (PERMANENT_PGRST_CODES.has(code)) return false;
  return (
    code.startsWith("PGRST") ||
    code.startsWith("08") ||
    code.startsWith("53") ||
    code === "40001" ||
    code === "57014"
  );
}

async function callWithTimeout<T>(call: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Checklist copy timed out after ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  local: ChecklistsForTransaction,
  sent?: SnapshotSentSets,
  /** Filled with `linkId:localId` of every member held back. */
  withheld?: string[]
): SnapshotChecklistPayload[] {
  const isSent = (kind: "attachment" | "email", id: string): boolean =>
    !sent || (kind === "attachment" ? sent.attachmentIds.has(id) : sent.emailIds.has(id));
  return local.checklists.map((detail) => ({
    template_id: detail.checklist.templateId || null,
    template_name: detail.checklist.templateName,
    sort_order: detail.checklist.sortOrder,
    items: detail.items.map((item) => ({
      title: item.title,
      local_item_id: item.id,
      description: item.description,
      is_required: item.isRequired,
      expected_document_type: item.expectedDocumentType,
      is_checked: item.isChecked,
      note: item.note,
      sort_order: item.sortOrder,
      links: (detail.linksByItemId[item.id] ?? [])
        .map((link) => {
          const ids = link.members
            .map((member) => (link.kind === "attachment" ? member.attachmentId : member.emailId))
            .filter((id): id is string => typeof id === "string" && id.length > 0);
          for (const id of ids) if (!isSent(link.kind, id)) withheld?.push(`${link.id}:${id}`);
          return {
            kind: link.kind,
            label: link.label,
            sort_order: link.sortOrder,
            local_ids: ids.filter((id) => isSent(link.kind, id)),
          };
        })
        // BACKLOG-3764: a group with nothing uploaded is not sent (the cloud
        // would drop it anyway); the pre-flight listed it.
        .filter((link) => !sent || link.local_ids.length > 0),
    })),
  }));
}

/**
 * Copy every checklist of `transactionId` onto the cloud submission - an
 * empty list when it has none (BACKLOG-3607). Never
 * throws: every failure is classified (header rule 2) and returned as
 * `failed` with its kind; the caller decides what the kind means.
 */
export async function snapshotSubmissionChecklists(
  client: SnapshotRpcClient,
  submissionId: string,
  transactionId: string,
  sent?: SnapshotSentSets
): Promise<SnapshotOutcome> {
  let payload: SnapshotChecklistPayload[];
  const withheld: string[] = [];
  try {
    const local = await getChecklistsForTransaction(transactionId);
    // BACKLOG-3607: a transaction with no checklist still sends [] - the
    // snapshot is the agent's whole set, and the server records a checklist
    // the agent removed since the previous version only when it is told.
    payload = buildChecklistSnapshotPayload(local, sent, withheld);
  } catch (err) {
    // The local read is not retried: the rest of the submit reads the same DB.
    return recordFailure(
      submissionId,
      transactionId,
      "transient",
      null,
      err instanceof Error ? err.message : String(err)
    );
  }

  // One payload object for every attempt — never a second local read.
  const args = { p_submission_id: submissionId, p_checklists: payload };
  let lastCode: string | null = null;
  let lastMessage = "";

  for (let attempt = 1; attempt <= SNAPSHOT_RETRY.attempts; attempt++) {
    if (attempt > 1) {
      const wait = SNAPSHOT_RETRY.backoffMs[attempt - 2] ?? 0;
      if (wait > 0) await sleep(wait);
    }

    let code: string | null;
    let message: string;
    try {
      const { data, error } = await callWithTimeout(
        client.rpc(SNAPSHOT_RPC, args),
        SNAPSHOT_RETRY.attemptTimeoutMs
      );
      if (!error) {
        const counts = (data as SnapshotResultCounts | null) ?? null;
        logService.info(
          `[Submission] Checklists copied to submission ${submissionId}`,
          LOG_CONTEXT,
          { transactionId, sent: payload.length, counts, attempt }
        );
        const linksNotAttached = reportUnconfirmedDrops(
          submissionId,
          transactionId,
          counts,
          withheld.filter((member) => !sent?.acceptedMembers.has(member)).length
        );
        return linksNotAttached ? { status: "written", counts, linksNotAttached } : { status: "written", counts };
      }
      code = error.code ? error.code : null;
      message = error.message;
    } catch (err) {
      code = null;
      message = err instanceof Error ? err.message : String(err);
    }

    // Every earlier attempt was transient (a permanent code returns below), so
    // a 23505 here means an earlier call committed and its answer was lost.
    if (code === "23505" && attempt > 1) {
      logService.info(
        `[Submission] Checklists already on submission ${submissionId} (an earlier attempt committed)`,
        LOG_CONTEXT,
        { transactionId, attempt }
      );
      return { status: "written", counts: null };
    }

    if (!isTransientCode(code)) {
      if (payload.length === 0) {
        // BACKLOG-3607: nothing was left out, so there is nothing to tell the
        // agent. A server without the 3607 migration refuses [] from an org
        // whose plan has no checklists (42501); after it, [] is accepted.
        logService.info(
          `[Submission] Empty checklist set not recorded on submission ${submissionId}`,
          LOG_CONTEXT,
          { transactionId, code, message }
        );
        return { status: "none" };
      }
      return recordFailure(
        submissionId,
        transactionId,
        code === "42501" ? "not_in_plan" : "refused",
        code,
        message
      );
    }

    lastCode = code;
    lastMessage = message;
    logService.warn(
      `[Submission] Checklist copy attempt ${attempt} of ${SNAPSHOT_RETRY.attempts} failed for submission ${submissionId}`,
      LOG_CONTEXT,
      { transactionId, code, message }
    );
  }

  return recordFailure(submissionId, transactionId, "transient", lastCode, lastMessage);
}

/**
 * BACKLOG-3764 — the backstop. Nothing the agent was not told about may be
 * dropped: a member held back here without his confirmation, or any member
 * the cloud function dropped, is a defect. Reported to Sentry (counts only),
 * and the caller tells the agent. Returns whether there was one.
 */
function reportUnconfirmedDrops(
  submissionId: string,
  transactionId: string,
  counts: SnapshotResultCounts | null,
  unconfirmedWithheld: number
): boolean {
  const droppedMembers = counts?.dropped_members ?? 0;
  const droppedLinks = counts?.dropped_links ?? 0;
  if (droppedMembers === 0 && droppedLinks === 0 && unconfirmedWithheld === 0) return false;
  logService.warn(
    `[Submission] Checklist evidence on submission ${submissionId} was not attached`,
    LOG_CONTEXT,
    { transactionId, droppedMembers, droppedLinks, unconfirmedWithheld }
  );
  Sentry.captureException(new Error("Checklist evidence was not attached at submission"), {
    tags: { area: "submission_checklist_snapshot", code: "links_not_attached" },
    extra: { submissionId, droppedMembers, droppedLinks, unconfirmedWithheld },
  });
  return true;
}

function recordFailure(
  submissionId: string,
  transactionId: string,
  kind: SnapshotFailureKind,
  code: string | null,
  message: string
): SnapshotOutcome {
  logService.warn(
    kind === "transient"
      ? `[Submission] Checklists were not copied to submission ${submissionId}; the submission will fail`
      : `[Submission] Checklists were not copied to submission ${submissionId}; the submission continues without them`,
    LOG_CONTEXT,
    { transactionId, kind, code, message }
  );
  Sentry.addBreadcrumb({
    category: "submission",
    message: "checklist snapshot failed",
    level: "warning",
    data: { submissionId, kind, code },
  });
  if (kind === "refused") {
    // Unreachable by construction (the payload is built to the contract), so
    // any refusal other than the plan's is drift worth an event, not a crumb.
    Sentry.captureException(
      new Error(`Checklist snapshot refused with ${code ?? "no code"}: ${message}`),
      { tags: { area: "submission_checklist_snapshot", code: code ?? "none" } }
    );
  }
  return { status: "failed", kind, code, message };
}
