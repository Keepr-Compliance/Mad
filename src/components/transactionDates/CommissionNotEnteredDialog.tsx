/**
 * BACKLOG-3520 — the warning shown when Next is pressed with no commission
 * entered. It WARNS, it never blocks: "Continue anyway" always proceeds.
 * Shape copied from ExportModal's completeness gate; wording from the signed-off
 * mock (claude.ai artifact 8NQW5ucuXGXF78LEomHEso).
 */
import React from "react";
import ReactDOM from "react-dom";

export type CommissionWarningRoute = "submit" | "export";

const BODY: Record<CommissionWarningRoute, string> = {
  submit:
    "Your broker will see this submission without a commission figure. You can add it now or continue without it.",
  export:
    "This export will not include a commission figure. You can add it now or continue without it.",
};

export function CommissionNotEnteredDialog({
  route,
  onContinue,
  onEnter,
}: {
  route: CommissionWarningRoute;
  onContinue: () => void;
  onEnter: () => void;
}): React.ReactElement {
  // Portalled to <body>: the host dialogs are transformed panels, and a
  // `fixed` overlay inside a transformed ancestor is sized to that ancestor.
  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4"
      data-testid="commission-not-entered-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="commission-not-entered-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 inline-flex items-center justify-center">
            <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-2.98l-6.93-12a2 2 0 00-3.48 0l-6.93 12A2 2 0 005.07 19z" />
            </svg>
          </span>
          <h3 id="commission-not-entered-title" className="text-lg font-bold text-gray-900">
            Commission not entered
          </h3>
        </div>
        <p className="text-sm text-gray-700 mb-3">{BODY[route]}</p>
        <div className="flex items-center justify-end gap-3 mt-5">
          <button
            type="button"
            data-testid="commission-continue-anyway"
            onClick={onContinue}
            className="px-4 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          >
            Continue anyway
          </button>
          <button
            type="button"
            data-testid="commission-enter"
            onClick={onEnter}
            autoFocus
            className="px-5 py-2 text-sm font-semibold text-white rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-md transition-all"
          >
            Enter commission
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default CommissionNotEnteredDialog;
