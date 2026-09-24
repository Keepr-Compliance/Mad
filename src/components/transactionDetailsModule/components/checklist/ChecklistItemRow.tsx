/**
 * ChecklistItemRow — BACKLOG-3476, one row of mock state 2.
 *
 * Title, the (i) description, the Required/Optional marker and the row's
 * actions sit on one line; evidence chips and the note stack underneath.
 *
 * Read-only (the plan no longer includes checklists): everything renders, the
 * checkbox is disabled, and no action that writes is offered. Main refuses
 * those writes anyway — this only keeps the screen from offering them.
 */
import React, { useState } from "react";
import type { ChecklistItem, ChecklistLink } from "../../../../../electron/types/checklist";
import { InfoTooltip } from "../../../common/InfoTooltip";
import { ChecklistLinkChip } from "./ChecklistLinkChip";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type { EmailThread } from "../EmailThreadCard";
import type { ChecklistLinkViewer } from "./ChecklistLinkChip";

/** `ChecklistNoteSchema` (electron/schemas/checklist.ts) refuses longer notes. */
export const CHECKLIST_NOTE_MAX_LENGTH = 4000;

const LINK_ICON =
  "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13";
const NOTE_ICON =
  "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z";

interface ChecklistItemRowProps {
  item: ChecklistItem;
  links: ChecklistLink[];
  readOnly: boolean;
  pending: boolean;
  attachmentsById: ReadonlyMap<string, UnifiedAttachment>;
  threads: EmailThread[];
  onToggle: (item: ChecklistItem) => void;
  onSaveNote: (itemId: string, note: string | null) => Promise<boolean>;
  onOpenPicker: (item: ChecklistItem) => void;
  onRemoveLink: (linkId: string) => Promise<void>;
  /** How a chip's View opens its evidence. */
  viewer: ChecklistLinkViewer;
}

export function ChecklistItemRow({
  item,
  links,
  readOnly,
  pending,
  attachmentsById,
  threads,
  onToggle,
  onSaveNote,
  onOpenPicker,
  onRemoveLink,
  viewer,
}: ChecklistItemRowProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const hasNote = (item.note ?? "").trim().length > 0;

  const startEdit = () => {
    setDraft(item.note ?? "");
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = draft.trim();
      const ok = await onSaveNote(item.id, trimmed.length > 0 ? draft : null);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`border border-gray-200 rounded-lg p-4 flex items-start gap-3 sm:gap-4 hover:border-gray-300 hover:shadow-md transition-all ${
        item.isChecked ? "bg-gray-50" : "bg-white"
      }`}
      data-testid={`checklist-item-${item.id}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={item.isChecked}
        aria-label={item.title}
        disabled={readOnly || pending}
        onClick={() => onToggle(item)}
        className={`w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed ${
          item.isChecked ? "bg-blue-500 border-blue-500" : "bg-white border-gray-300 hover:border-blue-300"
        } ${pending ? "opacity-60" : ""}`}
        data-testid={`checklist-check-${item.id}`}
      >
        <svg
          className={`w-4 h-4 text-white ${item.isChecked ? "opacity-100" : "opacity-0"}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5">
          <div className="flex items-center flex-wrap gap-2 min-w-0 flex-auto">
            <h5 className={`text-base font-medium ${item.isChecked ? "text-gray-600" : "text-gray-900"}`}>
              {item.title}
            </h5>
            {item.description && item.description.trim().length > 0 && (
              <InfoTooltip text={item.description} />
            )}
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide flex-shrink-0 ${
                item.isRequired ? "bg-indigo-50 text-indigo-600" : "bg-gray-100 text-gray-500"
              }`}
            >
              {item.isRequired ? "Required" : "Optional"}
            </span>
          </div>
          {!readOnly && (
            <div className="flex items-center flex-wrap gap-3 justify-end ml-auto flex-shrink-0 max-sm:w-full max-sm:justify-start">
              <button
                type="button"
                onClick={() => onOpenPicker(item)}
                className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-blue-700 min-h-[44px] sm:min-h-0"
                data-testid={`checklist-open-picker-${item.id}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={LINK_ICON} />
                </svg>
                Link&hellip;
              </button>
              {!hasNote && !editing && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-blue-700 min-h-[44px] sm:min-h-0"
                  data-testid={`checklist-add-note-${item.id}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={NOTE_ICON} />
                  </svg>
                  Add note
                </button>
              )}
            </div>
          )}
        </div>

        {links.length > 0 && (
          <div className="flex flex-col gap-2 mt-2.5">
            {links.map((link) => (
              <ChecklistLinkChip
                key={link.id}
                link={link}
                attachmentsById={attachmentsById}
                threads={threads}
                readOnly={readOnly}
                onViewAttachment={viewer.onViewAttachment}
                downloadingAttachmentId={viewer.downloadingAttachmentId}
                onViewThread={viewer.onViewThread}
                onRemove={onRemoveLink}
              />
            ))}
          </div>
        )}

        {editing ? (
          <div className="mt-2.5" data-testid={`checklist-note-editor-${item.id}`}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={CHECKLIST_NOTE_MAX_LENGTH}
              rows={3}
              aria-label={`Note for ${item.title}`}
              className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center justify-end gap-3 mt-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60"
                data-testid={`checklist-note-save-${item.id}`}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          hasNote && (
            <div className="mt-2.5 bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Note</span>
                <p className="text-sm text-gray-700 whitespace-pre-wrap break-words" data-testid={`checklist-note-${item.id}`}>
                  {item.note}
                </p>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 flex-shrink-0"
                  data-testid={`checklist-edit-note-${item.id}`}
                >
                  Edit
                </button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default ChecklistItemRow;
