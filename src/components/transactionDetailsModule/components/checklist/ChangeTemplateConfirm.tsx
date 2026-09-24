/**
 * ChangeTemplateConfirm — BACKLOG-3476.
 *
 * The only path that passes `replaceExisting`. It names what will be lost,
 * counted from the checklist being replaced, before anything is written. The
 * same template may be picked again: that is the only way to reset a
 * checklist, and the dialog says so.
 */
import React from "react";
import type { ChecklistLoss } from "../../utils/checklistLinks";
import { plural } from "../../utils/checklistLinks";

interface ChangeTemplateConfirmProps {
  currentName: string;
  newName: string;
  isReset: boolean;
  loss: ChecklistLoss;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function lossSentence(loss: ChecklistLoss, currentName: string): string {
  const parts = [
    plural(loss.ticked, "ticked item"),
    plural(loss.notes, "note"),
    plural(loss.links, "link"),
  ];
  return `${parts[0]}, ${parts[1]} and ${parts[2]} on “${currentName}” will be cleared. This can’t be undone.`;
}

export function ChangeTemplateConfirm({
  currentName,
  newName,
  isReset,
  loss,
  busy = false,
  onConfirm,
  onCancel,
}: ChangeTemplateConfirmProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checklist-replace-title"
      data-testid="checklist-replace-confirm"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <h2 id="checklist-replace-title" className="text-lg font-semibold text-gray-900">
          {isReset ? "Reset this checklist?" : "Replace this checklist?"}
        </h2>
        {!isReset && (
          <p className="mt-2 text-sm text-gray-600">
            The new checklist starts from &ldquo;{newName}&rdquo;.
          </p>
        )}
        <p className="mt-2 text-sm text-gray-600" data-testid="checklist-replace-loss">
          {lossSentence(loss, currentName)}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            data-testid="checklist-replace-cancel"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-60"
            data-testid="checklist-replace-confirm-button"
          >
            {isReset ? "Reset checklist" : "Replace checklist"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChangeTemplateConfirm;
