/**
 * AttachmentCard Component (BACKLOG-322 Phase A)
 *
 * Displays a single unified attachment (email OR text/iMessage) with a file-type
 * icon, size, a source badge, a context line (email subject / sender + date) and
 * a "not downloaded" affordance for metadata-only rows. Clicking the card opens
 * the preview (the parent handles on-demand download for email rows).
 */
import React from "react";
import { formatFileSize, formatDate } from "../../../utils/formatUtils";
import {
  getAttachmentTypeBucket,
  type AttachmentTypeBucket,
} from "../utils/attachmentType";
import type { UnifiedAttachment } from "../hooks/useTransactionAllAttachments";

interface AttachmentCardProps {
  attachment: UnifiedAttachment;
  /** Open/preview this attachment. */
  onOpen: (attachment: UnifiedAttachment) => void;
  /** True while an on-demand download for this attachment is in flight. */
  downloading?: boolean;
}

/**
 * Icon + color for a file-type bucket.
 */
function getBucketIcon(bucket: AttachmentTypeBucket): {
  icon: React.ReactNode;
  colorClass: string;
} {
  switch (bucket) {
    case "pdf":
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            <text x="8" y="16" fontSize="6" fill="currentColor" fontWeight="bold">PDF</text>
          </svg>
        ),
        colorClass: "text-red-500 bg-red-50",
      };
    case "doc":
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        ),
        colorClass: "text-blue-500 bg-blue-50",
      };
    case "image":
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        ),
        colorClass: "text-purple-500 bg-purple-50",
      };
    case "video":
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        ),
        colorClass: "text-amber-500 bg-amber-50",
      };
    case "audio":
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
        ),
        colorClass: "text-teal-500 bg-teal-50",
      };
    default:
      return {
        icon: (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        ),
        colorClass: "text-gray-500 bg-gray-50",
      };
  }
}

/**
 * Small source badge — Email (indigo) vs Text (emerald).
 */
function SourceBadge({ source }: { source: "email" | "text" }): React.ReactElement {
  const isEmail = source === "email";
  return (
    <span
      data-testid={`attachment-source-${source}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
        isEmail ? "bg-indigo-50 text-indigo-600" : "bg-emerald-50 text-emerald-600"
      }`}
    >
      {isEmail ? "Email" : "Text"}
    </span>
  );
}

/**
 * Build the context line shown under the filename.
 * Email → subject; Text → sender (flattened participants) or a generic label.
 */
function getContextText(attachment: UnifiedAttachment): string {
  if (attachment.source === "email") {
    return attachment.context_subject || attachment.context_sender || "Email";
  }
  return attachment.context_sender || "Text message";
}

export function AttachmentCard({
  attachment,
  onOpen,
  downloading = false,
}: AttachmentCardProps): React.ReactElement {
  const bucket = getAttachmentTypeBucket(attachment.mime_type);
  const { icon, colorClass } = getBucketIcon(bucket);
  const isDownloaded = Boolean(attachment.storage_path);
  const contextText = getContextText(attachment);

  return (
    <button
      type="button"
      onClick={() => onOpen(attachment)}
      disabled={downloading}
      data-testid={`attachment-card-${attachment.id}`}
      className="w-full text-left bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md hover:border-gray-300 transition-all disabled:opacity-60 disabled:cursor-wait"
    >
      <div className="flex items-start gap-4">
        {/* File type icon */}
        <div className={`relative flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center ${colorClass}`}>
          {downloading ? (
            <div
              className="w-5 h-5 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin"
              data-testid={`attachment-downloading-${attachment.id}`}
            />
          ) : (
            icon
          )}
        </div>

        {/* File info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-gray-900 truncate" title={attachment.filename}>
              {attachment.filename}
            </h4>
            <SourceBadge source={attachment.source} />
          </div>

          <div className="flex items-center flex-wrap gap-2 mt-1 text-sm text-gray-500">
            {attachment.file_size_bytes !== null && (
              <span>{formatFileSize(attachment.file_size_bytes)}</span>
            )}
            {attachment.source_date && (
              <>
                <span className="text-gray-300">|</span>
                <span>{formatDate(attachment.source_date, { fallback: "" })}</span>
              </>
            )}
            {!isDownloaded && (
              <span
                data-testid={`attachment-not-downloaded-${attachment.id}`}
                className="inline-flex items-center gap-1 text-xs text-amber-600"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Not downloaded
              </span>
            )}
          </div>

          {/* Context line (subject / sender) */}
          <div className="mt-2 text-xs text-gray-400 truncate" title={contextText}>
            {contextText}
          </div>
        </div>
      </div>
    </button>
  );
}
