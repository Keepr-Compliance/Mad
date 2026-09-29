/**
 * ChecklistWarningDialog (BACKLOG-3477)
 *
 * The unticked-required-items warning, state 4 of the signed-off Checklist tab
 * mock. Shown by TransactionDetails BEFORE the Submit for Review window opens,
 * in the same position as the emails-needing-review gate (ReviewPromptDialog,
 * whose shell this copies class for class).
 *
 * Warn, never block: "Continue anyway" opens the Submit for Review window,
 * which still runs its own date step. "Go back" closes this and opens nothing.
 */
import React from "react";
import type { UncheckedRequiredItem } from "../../../services/checklistWarningGate";

export interface ChecklistWarningDialogProps {
  items: UncheckedRequiredItem[];
  onGoBack: () => void;
  onContinue: () => void;
}

export function ChecklistWarningDialog({
  items,
  onGoBack,
  onContinue,
}: ChecklistWarningDialogProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checklist-warning-title"
      data-testid="checklist-warning"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
            <svg className="h-5 w-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 id="checklist-warning-title" className="text-lg font-semibold text-gray-900">
              {items.length === 1
                ? "1 required item is not checked"
                : `${items.length} required items are not checked`}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              You can still submit. The checklist goes with the transaction as it stands.
            </p>
            <ul className="mt-3 flex flex-col gap-1.5" data-testid="checklist-warning-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-sm text-gray-700"
                >
                  <svg className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="min-w-0 flex-1" data-testid="checklist-warning-item-title">
                    {item.title}
                  </span>
                  {item.checklistName && (
                    <span
                      className="flex-shrink-0 text-xs text-gray-500"
                      data-testid="checklist-warning-item-checklist"
                    >
                      {item.checklistName}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onGoBack}
            data-testid="checklist-warning-go-back"
            className="rounded-lg px-4 py-2 font-medium text-gray-700 transition-all hover:bg-gray-100"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-testid="checklist-warning-continue"
            className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow-md transition-all hover:bg-blue-700"
          >
            Continue anyway
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChecklistWarningDialog;
