/**
 * BACKLOG-3477 PR D — pull the checklists a broker added at review onto the
 * agent's local transaction.
 *
 * Called by `submissionSyncService` when a submission's status turns
 * `needs_changes` (edge-triggered, ruling bf8c39b4). The cloud copy is the
 * source: template name and items (title, description, is_required,
 * expected_document_type, sort order). Items arrive unticked, with no notes
 * and no links — `selectChecklistTemplate` writes exactly that.
 *
 * Idempotent through the local `UNIQUE (transaction_id, template_id)`: a
 * template the transaction already carries comes back `exists` and nothing is
 * written, so the existing section's ticks are never touched and a re-delivered
 * event adds nothing twice.
 *
 * Throws when the cloud read fails; the caller decides what that means for the
 * status write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { selectChecklistTemplate } from "./db/checklistDbService";
// BACKLOG-3599: imported directly, not through the databaseService facade, so
// the real SQL runs wherever this module does.
import { clearReviewChecklistPullOwed } from "./db/submissionDbService";
import logService from "./logService";
import { sendToMainWindow } from "../windowRegistry";
import type { ChecklistTemplateItemInput } from "../types/checklist";
import type { DocumentType } from "../types/models";

/** Mirrors the local CHECK on `transaction_checklist_items.expected_document_type`. */
const LOCAL_DOCUMENT_TYPES: ReadonlySet<string> = new Set<DocumentType>([
  "offer",
  "inspection",
  "disclosure",
  "contract",
  "appraisal",
  "amendment",
  "addendum",
  "title",
  "closing",
  "other",
]);

const FETCH_TIMEOUT_MS = 15000;

interface CloudChecklistHeader {
  id: string;
  template_id: string | null;
  template_name: string;
  sort_order: number;
}

interface CloudChecklistItem {
  submission_checklist_id: string;
  title: string;
  description: string | null;
  is_required: boolean;
  expected_document_type: string | null;
  sort_order: number;
}

export interface ReviewChecklistPullResult {
  /** Template names written onto the transaction by this call. */
  added: string[];
  /** Headers already on the transaction (same template) — nothing written. */
  existing: number;
  /** Headers with no template id, which cannot be keyed locally. */
  skipped: number;
  /** The local transaction no longer exists; nothing to write onto. */
  noTransaction: boolean;
}

/** A cloud document type the desktop does not know is stored as empty. */
export function toLocalDocumentType(value: string | null | undefined): DocumentType | null {
  return value && LOCAL_DOCUMENT_TYPES.has(value) ? (value as DocumentType) : null;
}

async function withTimeout<T>(query: PromiseLike<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${FETCH_TIMEOUT_MS / 1000}s`)),
          FETCH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pullReviewChecklists(
  client: SupabaseClient,
  submissionId: string,
  transactionId: string,
): Promise<ReviewChecklistPullResult> {
  const result: ReviewChecklistPullResult = {
    added: [],
    existing: 0,
    skipped: 0,
    noTransaction: false,
  };

  const headersResponse = await withTimeout(
    client
      .from("submission_checklists")
      .select("id, template_id, template_name, sort_order")
      .eq("submission_id", submissionId)
      .not("added_at_review_by", "is", null)
      .order("sort_order", { ascending: true }),
    "Review checklist fetch",
  );
  if (headersResponse.error) {
    throw new Error(`Review checklist fetch failed: ${headersResponse.error.message}`);
  }
  const headers = (headersResponse.data ?? []) as CloudChecklistHeader[];
  if (headers.length === 0) return result;

  const itemsResponse = await withTimeout(
    client
      .from("submission_checklist_items")
      .select(
        "submission_checklist_id, title, description, is_required, expected_document_type, sort_order",
      )
      .in(
        "submission_checklist_id",
        headers.map((header) => header.id),
      )
      .order("sort_order", { ascending: true }),
    "Review checklist items fetch",
  );
  if (itemsResponse.error) {
    throw new Error(`Review checklist items fetch failed: ${itemsResponse.error.message}`);
  }
  const items = (itemsResponse.data ?? []) as CloudChecklistItem[];

  for (const header of headers) {
    if (!header.template_id) {
      result.skipped++;
      logService.warn(
        `[ChecklistPull] Broker-added checklist ${header.id} has no template id; skipped`,
        "SubmissionChecklistPull",
      );
      continue;
    }

    const localItems: ChecklistTemplateItemInput[] = items
      .filter((item) => item.submission_checklist_id === header.id)
      .map((item) => ({
        title: item.title,
        description: item.description ?? null,
        isRequired: item.is_required === true,
        expectedDocumentType: toLocalDocumentType(item.expected_document_type),
        sortOrder: item.sort_order,
      }));

    const outcome = await selectChecklistTemplate({
      transactionId,
      templateId: header.template_id,
      templateName: header.template_name,
      items: localItems,
    });

    if (outcome.status === "added") {
      result.added.push(header.template_name);
    } else if (outcome.status === "exists") {
      result.existing++;
    } else if (outcome.status === "no_transaction") {
      result.noTransaction = true;
      return result;
    }
  }

  return result;
}

/** Statuses after which nothing more can be added at review. */
const FINAL_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected"]);

/**
 * What one owed-pull attempt did (BACKLOG-3599).
 *   pulled    the pull succeeded (or the transaction is gone); marker cleared
 *   final     the cloud says approved/rejected; marker cleared, nothing pulled
 *   kept      no positive proof the pull is done; marker kept for the next pass
 */
export type OwedPullOutcome =
  | { status: "pulled"; added: string[] }
  | { status: "final" }
  | { status: "kept"; reason: string };

/**
 * BACKLOG-3599 — retry one owed broker-checklist pull.
 *
 * The marker is cleared only after POSITIVE proof (SR condition 2): the owed
 * `transaction_submissions` row is read by id first. A read error (signed out
 * is RLS 42501) or a row that is not visible (another user signed in on the
 * same local database: RLS returns nothing) keeps the marker — an empty
 * checklist read in that state would otherwise look like "nothing to pull"
 * and clear it for good. The cloud status decides finality, not the local one.
 */
export async function retryOwedReviewChecklistPull(
  client: SupabaseClient,
  transactionId: string,
  submissionId: string,
): Promise<OwedPullOutcome> {
  try {
    const statusResponse = await withTimeout(
      client.from("transaction_submissions").select("id, status").eq("id", submissionId),
      "Owed submission status read",
    );
    if (statusResponse.error) {
      return { status: "kept", reason: `status read failed: ${statusResponse.error.message}` };
    }
    const row = ((statusResponse.data ?? []) as Array<{ id: string; status: string }>).find(
      (r) => r.id === submissionId,
    );
    if (!row) return { status: "kept", reason: "submission not visible" };

    if (FINAL_SUBMISSION_STATUSES.has(row.status)) {
      clearReviewChecklistPullOwed(transactionId, submissionId);
      return { status: "final" };
    }

    const pulled = await pullReviewChecklists(client, submissionId, transactionId);
    clearReviewChecklistPullOwed(transactionId, submissionId);
    return { status: "pulled", added: pulled.added };
  } catch (error) {
    return { status: "kept", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * BACKLOG-3595 — tell an open transaction window that an owed pull added a
 * broker checklist. Call only AFTER `retryOwedReviewChecklistPull` returned
 * `pulled` with `added.length > 0`: the rows are written by one synchronous
 * `dbTransaction` inside the pull, so they are committed by then, and the
 * renderer re-read that this event triggers finds them.
 *
 * Its own channel, never `submission-status-changed`: every event on that
 * channel raises a notification (useSubmissionSync), and nothing about the
 * submission status changed here.
 */
export function notifyChecklistsChanged(transactionId: string): void {
  if (!sendToMainWindow("transaction-checklists-changed", { transactionId })) {
    logService.debug(
      "[ChecklistPull] No main window to send the checklists-changed event",
      "SubmissionChecklistPull",
    );
  }
}
