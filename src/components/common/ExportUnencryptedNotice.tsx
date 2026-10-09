import React from "react";

/**
 * Non-blocking notice shown on the export-finished screen: exported files are
 * plain files and are not covered by Keepr's encryption (BACKLOG-3828).
 * Copy is the founder-approved draft; edit the strings here only.
 */
export const EXPORT_UNENCRYPTED_TITLE = "Exported files aren't encrypted";
export const EXPORT_UNENCRYPTED_BODY =
  "Your audit was saved as regular files so you can open and share it. Keepr's encryption protects your data inside Keepr only — it doesn't apply to exported files. We recommend sending the export where it needs to go, then deleting it from this computer. You're responsible for how exported files are stored, shared and deleted.";

export function ExportUnencryptedNotice(): React.ReactElement {
  return (
    <div
      role="note"
      data-testid="export-unencrypted-notice"
      className="mt-6 mx-auto max-w-md bg-amber-50 border border-amber-200 rounded-lg p-3 text-left flex items-start gap-3"
    >
      <svg
        className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <div>
        <h5 className="text-sm font-semibold text-amber-900">{EXPORT_UNENCRYPTED_TITLE}</h5>
        <p className="text-xs text-amber-800 mt-1">{EXPORT_UNENCRYPTED_BODY}</p>
      </div>
    </div>
  );
}
