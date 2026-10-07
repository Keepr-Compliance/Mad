/**
 * Checklist Warning Gate (BACKLOG-3477)
 *
 * Before the Submit for Review window opens, warn when required checklist
 * items are not ticked. WARN, NEVER BLOCK (founder, 2026-09-28): the agent can
 * always continue. Shaped like `exportReviewGate.ts` + `ReviewPromptDialog` —
 * the emails-needing-review gate the founder named as the model ("just like
 * the emails") — except that this one has no power to stop anything.
 *
 * A failed read shows no warning. The warning cannot stop a submission when
 * the checklist CAN be read; a read failure must not give it that power.
 */
import { checklistService } from "./checklistService";
import type { ChecklistsForTransaction } from "../../electron/types/checklist";
import logger from "../utils/logger";

/** One required item the agent has not ticked, as the warning lists it. */
export interface UncheckedRequiredItem {
  id: string;
  title: string;
  /**
   * The checklist the item belongs to, shown muted beside the title — only
   * when the transaction has two or more checklists. `null` with exactly one:
   * the row is the title alone (mock state 4).
   */
  checklistName: string | null;
}

/**
 * BACKLOG-3477: every required, unticked item across ALL checklists on the
 * transaction, in display order. Optional items never count. The warning's
 * title is this array's length, so the number and the list cannot disagree.
 *
 * BACKLOG-3618: `notSentTemplateIds` — the user's own templates set not to be
 * sent with submissions. The server drops those checklists at submit, so
 * they cannot be "missing" from what the broker receives, and the warning
 * skips them.
 */
export function listUncheckedRequiredItems(
  data: ChecklistsForTransaction,
  notSentTemplateIds: ReadonlySet<string> = new Set(),
): UncheckedRequiredItem[] {
  const out: UncheckedRequiredItem[] = [];
  // Missing arrays read as empty: malformed data must never throw here, or the
  // Complete press would end with nothing on screen.
  const checklists = (data.checklists ?? []).filter(
    (detail) => !notSentTemplateIds.has(detail.checklist?.templateId),
  );
  const named = checklists.length >= 2;
  for (const detail of checklists) {
    for (const item of detail.items ?? []) {
      if (item.isRequired && !item.isChecked) {
        out.push({
          id: item.id,
          title: item.title,
          checklistName: named ? detail.checklist.templateName : null,
        });
      }
    }
  }
  return out;
}

/**
 * BACKLOG-3618: the ids of the user's own templates set not to be sent. A
 * listing that cannot be read gives an empty set — warn on everything. Wrong
 * in that direction costs one extra warning, which never blocks; the server
 * drops a not-sent checklist at submit either way.
 */
async function readNotSentTemplateIds(): Promise<ReadonlySet<string>> {
  try {
    const listing = await checklistService.listTemplates();
    if (!listing.success || !listing.data) return new Set();
    return new Set(
      listing.data.templates
        .filter((t) => t.isMine === true && t.includeInSubmission === false)
        .map((t) => t.id),
    );
  } catch {
    return new Set();
  }
}

/**
 * Read the transaction's checklists NOW and list the unticked required items.
 * A refused read or a throw returns `[]` — no warning, the flow continues.
 * An IPC rejection arrives as a refusal (`checklistService.get` catches it).
 * The catch below is defensive: only `listUncheckedRequiredItems` throwing on
 * a shape main never emits reaches it (BACKLOG-3599).
 */
export async function readUncheckedRequiredItems(
  transactionId: string,
): Promise<UncheckedRequiredItem[]> {
  try {
    const [result, notSent] = await Promise.all([
      checklistService.get(transactionId),
      readNotSentTemplateIds(),
    ]);
    if (result.success && result.data) {
      return listUncheckedRequiredItems(result.data, notSent);
    }
    logger.warn(
      "[ChecklistWarningGate] checklist read failed; continuing without the warning:",
      result.error,
    );
  } catch (err) {
    logger.warn(
      "[ChecklistWarningGate] checklist check failed; continuing without the warning:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return [];
}
