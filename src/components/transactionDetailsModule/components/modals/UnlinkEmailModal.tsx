/**
 * UnlinkEmailModal Component
 * Confirmation dialog for unlinking an email from transaction
 */
import React from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import type { Communication } from "../../types";

interface UnlinkEmailModalProps {
  communication: Communication;
  isUnlinking: boolean;
  onCancel: () => void;
  onUnlink: () => void;
}

export function UnlinkEmailModal({
  communication,
  isUnlinking,
  onCancel,
  onUnlink,
}: UnlinkEmailModalProps): React.ReactElement {
  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-md p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
            <svg
              className="w-6 h-6 text-orange-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
              />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-gray-900">
            Remove Email from Transaction?
          </h3>
        </div>
        <p className="text-sm text-gray-600 mb-2">
          Are you sure this email is not related to this transaction?
        </p>
        <div className="bg-gray-50 rounded-lg p-3 mb-4">
          <p className="text-sm font-medium text-gray-900 truncate">
            {communication.subject || "(No Subject)"}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            From: {communication.sender || "Unknown"}
          </p>
        </div>
        <p className="text-sm text-gray-600 mb-6">
          This email will be removed from this transaction and won&apos;t be
          re-added during future email scans.
        </p>
        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onUnlink}
            disabled={isUnlinking}
            className="px-4 py-2 bg-orange-600 text-white hover:bg-orange-700 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            data-testid="unlink-email-confirm-button"
          >
            {isUnlinking ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Removing...
              </>
            ) : (
              "Remove Email"
            )}
          </button>
        </div>
    </ResponsiveModal>
  );
}
