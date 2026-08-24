/**
 * Submit for Review Modal Component
 *
 * Confirmation modal for submitting a transaction to the broker portal.
 * Shows summary of what will be submitted and progress during submission.
 * Part of BACKLOG-391: Submit for Review UI.
 */
import React, { useState } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import type { Transaction } from "@/types";

export interface SubmitProgress {
  stage: "preparing" | "attachments" | "transaction" | "messages" | "complete" | "failed";
  stageProgress: number;
  overallProgress: number;
  currentItem?: string;
}

interface SubmitForReviewModalProps {
  transaction: Transaction;
  /** @deprecated Use emailThreadCount and textThreadCount instead */
  messageCount?: number;
  /** Number of email threads */
  emailThreadCount: number;
  /** Number of text message threads */
  textThreadCount: number;
  /** Total attachment count (text + email) */
  attachmentCount: number;
  /** Email attachment count specifically */
  emailAttachmentCount: number;
  /** Total size of all attachments in bytes */
  totalSizeBytes: number;
  isSubmitting: boolean;
  progress: SubmitProgress | null;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  onExportFirst?: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing submission...",
  attachments: "Uploading attachments...",
  transaction: "Creating submission record...",
  messages: "Uploading messages...",
  complete: "Submission complete!",
  failed: "Submission failed",
};

/**
 * Format bytes to human-readable size (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function SubmitForReviewModal({
  transaction,
  emailThreadCount,
  textThreadCount,
  attachmentCount,
  emailAttachmentCount,
  totalSizeBytes,
  isSubmitting,
  progress,
  error,
  onCancel,
  onSubmit,
  onExportFirst,
}: SubmitForReviewModalProps): React.ReactElement {
  const isResubmit = transaction.submission_status === "needs_changes";
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const isActivelySubmitting = isSubmitting && progress?.stage !== "complete" && progress?.stage !== "failed";

  const handleCancelClick = () => {
    if (isActivelySubmitting) {
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  };

  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-md p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg
              className="w-6 h-6 text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-gray-900">
            {isResubmit ? "Resubmit for Review" : "Submit for Review"}
          </h3>
        </div>

        {/* Content - not submitting */}
        {!isSubmitting && !error && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              {isResubmit
                ? "You are about to resubmit this transaction for broker review. Your broker will be notified of the changes."
                : "You are about to submit this transaction for broker review. The following data will be sent to your broker:"}
            </p>

            {/* Summary */}
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">
                Submission Summary
              </h4>
              <div className="space-y-2">
                {/* Property */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                    />
                  </svg>
                  <span className="text-gray-600">Property:</span>
                  <span className="font-medium text-gray-900 truncate">
                    {transaction.property_address || "No address"}
                  </span>
                </div>

                {/* Email Threads */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  <span className="text-gray-600">Email threads:</span>
                  <span className="font-medium text-gray-900">
                    {emailThreadCount}
                    {emailAttachmentCount > 0 && (
                      <span className="text-gray-500 font-normal">
                        {" "}({emailAttachmentCount} {emailAttachmentCount === 1 ? "attachment" : "attachments"})
                      </span>
                    )}
                  </span>
                </div>

                {/* Text Threads */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                  <span className="text-gray-600">Text threads:</span>
                  <span className="font-medium text-gray-900">
                    {textThreadCount}
                  </span>
                </div>

                {/* Total Attachments with Size */}
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                    />
                  </svg>
                  <span className="text-gray-600">Total attachments:</span>
                  <span className="font-medium text-gray-900">
                    {attachmentCount} {attachmentCount === 1 ? "file" : "files"}
                    {totalSizeBytes > 0 && (
                      <span className="text-gray-500 font-normal">
                        {" "}({formatBytes(totalSizeBytes)})
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Export option */}
            {onExportFirst && (
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 mb-4">
                <div className="flex items-start gap-2">
                  <svg
                    className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm text-blue-800">
                      Want to keep a local copy first?
                    </p>
                    <button
                      onClick={onExportFirst}
                      className="text-sm text-blue-600 hover:text-blue-800 font-medium underline"
                    >
                      Export to folder before submitting
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* Progress display */}
        {isSubmitting && progress && (
          <div className="mb-4">
            <div className="flex items-center gap-3 mb-3">
              {progress.stage !== "complete" && progress.stage !== "failed" && (
                <svg
                  className="w-5 h-5 text-blue-600 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              )}
              {progress.stage === "complete" && (
                <svg
                  className="w-5 h-5 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
              <span className="text-sm font-medium text-gray-900">
                {STAGE_LABELS[progress.stage] || progress.stage}
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  progress.stage === "complete"
                    ? "bg-green-500"
                    : progress.stage === "failed"
                    ? "bg-red-500"
                    : "bg-blue-600"
                }`}
                style={{ width: `${progress.overallProgress}%` }}
              />
            </div>

            {/* Current item */}
            {progress.currentItem && (
              <p className="text-xs text-gray-500 truncate">
                {progress.currentItem}
              </p>
            )}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">
                  Submission Failed
                </p>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Cancel confirmation */}
        {showCancelConfirm && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">
                  Submission in progress
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  Cancelling now will result in an incomplete submission. Are you sure?
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    className="px-3 py-1.5 bg-amber-100 text-amber-800 hover:bg-amber-200 rounded-lg text-sm font-medium transition-all"
                  >
                    Keep Uploading
                  </button>
                  <button
                    onClick={onCancel}
                    className="px-3 py-1.5 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-sm font-medium transition-all"
                  >
                    Cancel Anyway
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 justify-end">
          {!showCancelConfirm && (
            <button
              onClick={handleCancelClick}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
            >
              {progress?.stage === "complete" || error ? "Close" : "Cancel"}
            </button>
          )}
          {!progress?.stage || progress.stage === "failed" ? (
            <button
              onClick={onSubmit}
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Submitting...
                </>
              ) : isResubmit ? (
                "Resubmit"
              ) : (
                /* BACKLOG-2792: the submit action reads "Submit" at EVERY
                   responsive size — never "Submit for review" and never a
                   truncated variant of it. One literal, so there is no size at
                   which a different string can appear. */
                "Submit"
              )}
            </button>
          ) : null}
        </div>
    </ResponsiveModal>
  );
}

export default SubmitForReviewModal;
