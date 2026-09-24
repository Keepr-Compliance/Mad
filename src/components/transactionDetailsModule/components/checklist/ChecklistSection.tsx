/**
 * ChecklistSection — BACKLOG-3476, one checklist inside the Checklist tab.
 *
 * A transaction may carry several checklists. Each renders as one section:
 * a header row (collapse toggle, template name, its own progress, Change,
 * Remove) and, when expanded, its rows.
 *
 * Every action names THIS checklist by id. The section never acts on another
 * section, and its Change is the only route by which this checklist can be
 * replaced (the tab sends `replaceChecklistId` only from this section's own
 * confirmation).
 *
 * Whether it is expanded is the tab's state, keyed by checklist id; the
 * section only reports a toggle.
 */
import React, { useState } from "react";
import type { ChecklistDetail, ChecklistItem } from "../../../../../electron/types/checklist";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type { EmailThread } from "../EmailThreadCard";
import type { ChecklistLinkViewer } from "./ChecklistLinkChip";
import { ChecklistProgress } from "./ChecklistProgress";
import { ChecklistItemRow } from "./ChecklistItemRow";
import { checklistLoss, plural } from "../../utils/checklistLinks";

const CHEVRON = "M9 5l7 7-7 7";

/** "Remove “Asbestos”? Its 3 ticked items, 1 note and 2 links are removed." */
export function removeSentence(detail: ChecklistDetail): string {
  const loss = checklistLoss(detail);
  return (
    `Remove “${detail.checklist.templateName}”? Its ${plural(loss.ticked, "ticked item")}, ` +
    `${plural(loss.notes, "note")} and ${plural(loss.links, "link")} are removed.`
  );
}

export interface ChecklistSectionProps {
  detail: ChecklistDetail;
  expanded: boolean;
  onToggleExpanded: (checklistId: string) => void;
  /** Rows are read-only (plan not confirmed as allowing checklists). */
  readOnly: boolean;
  /** Offer Change (allowed only). */
  canChange: boolean;
  /** Offer Remove (allowed, or blocked: the unhide rule). */
  canRemove: boolean;
  busy: boolean;
  pendingItemIds: ReadonlySet<string>;
  attachmentsById: ReadonlyMap<string, UnifiedAttachment>;
  threads: EmailThread[];
  onChange: (checklistId: string) => void;
  onRemove: (checklistId: string) => Promise<void>;
  onToggleItem: (item: ChecklistItem) => void;
  onSaveNote: (itemId: string, note: string | null) => Promise<boolean>;
  onOpenPicker: (item: ChecklistItem) => void;
  onRemoveLink: (linkId: string) => Promise<void>;
  viewer: ChecklistLinkViewer;
}

export function ChecklistSection({
  detail,
  expanded,
  onToggleExpanded,
  readOnly,
  canChange,
  canRemove,
  busy,
  pendingItemIds,
  attachmentsById,
  threads,
  onChange,
  onRemove,
  onToggleItem,
  onSaveNote,
  onOpenPicker,
  onRemoveLink,
  viewer,
}: ChecklistSectionProps): React.ReactElement {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const id = detail.checklist.id;
  const bodyId = `checklist-section-body-${id}`;

  return (
    <section
      className="border border-gray-200 rounded-lg bg-white"
      data-testid={`checklist-section-${id}`}
      aria-label={detail.checklist.templateName}
    >
      <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        <button
          type="button"
          onClick={() => onToggleExpanded(id)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex items-center gap-2 text-left min-w-0 flex-1 basis-48"
          data-testid={`checklist-section-toggle-${id}`}
        >
          <svg
            className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CHEVRON} />
          </svg>
          <span className="min-w-0">
            <span
              className="block text-base font-semibold text-gray-900 truncate"
              data-testid={`checklist-section-name-${id}`}
            >
              {detail.checklist.templateName}
            </span>
            <span className="block text-xs text-gray-400">
              {detail.items.length} item{detail.items.length === 1 ? "" : "s"}
            </span>
          </span>
        </button>
        <div className="flex-1 basis-48" data-testid={`checklist-section-progress-${id}`}>
          <ChecklistProgress requiredDone={detail.requiredDone} requiredTotal={detail.requiredTotal} />
        </div>
        <div className="flex items-center gap-1">
          {canChange && (
            <button
              type="button"
              onClick={() => onChange(id)}
              disabled={busy}
              title="Changing the template clears every check, note and link on this checklist."
              className="px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg"
              data-testid={`checklist-change-${id}`}
            >
              Change
            </button>
          )}
          {canRemove && !confirmingRemove && (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg"
              data-testid={`checklist-remove-${id}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {canRemove && confirmingRemove && (
        <div
          className="mx-4 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between gap-3 flex-wrap"
          data-testid={`checklist-remove-prompt-${id}`}
        >
          <span>{removeSentence(detail)}</span>
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onRemove(id).finally(() => setConfirmingRemove(false))}
              disabled={busy}
              className="font-semibold text-red-700 hover:text-red-900"
              data-testid={`checklist-remove-confirm-${id}`}
            >
              Remove
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              disabled={busy}
              className="font-medium text-gray-700"
              data-testid={`checklist-remove-cancel-${id}`}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {expanded && (
        <div
          id={bodyId}
          className="flex flex-col gap-3 px-4 pb-4"
          data-testid={`checklist-section-body-${id}`}
        >
          {[...detail.items]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((item) => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                links={detail.linksByItemId[item.id] ?? []}
                readOnly={readOnly}
                pending={pendingItemIds.has(item.id)}
                attachmentsById={attachmentsById}
                threads={threads}
                onToggle={onToggleItem}
                onSaveNote={onSaveNote}
                onOpenPicker={onOpenPicker}
                onRemoveLink={onRemoveLink}
                viewer={viewer}
              />
            ))}
        </div>
      )}
    </section>
  );
}

export default ChecklistSection;
