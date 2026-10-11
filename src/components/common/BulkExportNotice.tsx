import React, { useState } from "react";
import { ResponsiveModal } from "./ResponsiveModal";
import {
  ExportUnencryptedNotice,
  EXPORT_UNENCRYPTED_TITLE,
} from "./ExportUnencryptedNotice";

interface BulkExportNoticeProps {
  /** Hides the notice (it stays until dismissed so the full text can be read). */
  onDismiss: () => void;
}

/**
 * Shown under the bulk-export success banner (BACKLOG-3828): short line plus a
 * "Learn more" action opening a dialog with the full approved text.
 */
export function BulkExportNotice({ onDismiss }: BulkExportNoticeProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        role="note"
        data-testid="bulk-export-notice"
        className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-3"
      >
        <p className="flex-1 text-sm font-medium text-amber-900">{EXPORT_UNENCRYPTED_TITLE}</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-amber-900 underline"
        >
          Learn more
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-sm text-amber-800"
        >
          Dismiss
        </button>
      </div>
      {open && (
        <ResponsiveModal onClose={() => setOpen(false)} panelClassName="max-w-md p-6">
          <div role="dialog" aria-modal="true" aria-label={EXPORT_UNENCRYPTED_TITLE}>
            <ExportUnencryptedNotice />
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm font-medium bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </ResponsiveModal>
      )}
    </>
  );
}

export default BulkExportNotice;
