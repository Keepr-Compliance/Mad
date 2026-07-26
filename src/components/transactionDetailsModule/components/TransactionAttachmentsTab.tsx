/**
 * TransactionAttachmentsTab Component (BACKLOG-322 Phase A)
 *
 * One unified, filterable, sortable list of EVERY attachment linked to a
 * transaction — email AND text/iMessage — including metadata-only rows whose
 * bytes have not been downloaded yet. Filtering/sorting is client-side and
 * memoized so the tab stays responsive for hundreds of attachments.
 *
 * Preview reuses AttachmentPreviewModal. For a not-yet-downloaded EMAIL
 * attachment the tab first forces an on-demand download (reconciling the
 * metadata row in place — BACKLOG-1870) and then previews the refreshed row.
 */
import React, { useMemo, useState, useCallback } from "react";
import { AttachmentCard } from "./AttachmentCard";
import { AttachmentPreviewModal } from "./modals/AttachmentPreviewModal";
import type { UnifiedAttachment } from "../hooks/useTransactionAllAttachments";
import {
  getAttachmentTypeBucket,
  ATTACHMENT_TYPE_LABELS,
  ATTACHMENT_TYPE_ORDER,
  type AttachmentTypeBucket,
} from "../utils/attachmentType";
import logger from "../../../utils/logger";

type SourceFilter = "all" | "email" | "text";
type TypeFilter = "all" | AttachmentTypeBucket;
type SortKey = "date" | "name" | "size" | "type" | "source";

/** Shape AttachmentPreviewModal expects (a subset of the unified row). */
interface PreviewAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

interface TransactionAttachmentsTabProps {
  /** Unified attachments linked to the transaction. */
  attachments: UnifiedAttachment[];
  /** Whether attachments are being loaded. */
  loading: boolean;
  /** Error message if loading failed. */
  error: string | null;
  /** Reload the list after an on-demand download reconciles a row. */
  refresh?: () => void;
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "date", label: "Date (newest)" },
  { value: "name", label: "Name (A–Z)" },
  { value: "size", label: "Size (largest)" },
  { value: "type", label: "Type" },
  { value: "source", label: "Source" },
];

function toPreview(a: UnifiedAttachment | PreviewAttachment): PreviewAttachment {
  return {
    id: a.id,
    filename: a.filename,
    mime_type: a.mime_type,
    file_size_bytes: a.file_size_bytes,
    storage_path: a.storage_path,
  };
}

/**
 * A single filter chip button.
 */
function FilterChip({
  active,
  onClick,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  testId: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active
          ? "bg-green-600 text-white"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      {label}
    </button>
  );
}

export function TransactionAttachmentsTab({
  attachments,
  loading,
  error,
  refresh,
}: TransactionAttachmentsTabProps): React.ReactElement {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [previewAttachment, setPreviewAttachment] = useState<PreviewAttachment | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  // Which type buckets are actually present (drives which type chips render).
  const presentBuckets = useMemo(() => {
    const set = new Set<AttachmentTypeBucket>();
    for (const a of attachments) set.add(getAttachmentTypeBucket(a.mime_type));
    return set;
  }, [attachments]);

  const filteredSorted = useMemo(() => {
    const filtered = attachments.filter((a) => {
      if (sourceFilter !== "all" && a.source !== sourceFilter) return false;
      if (typeFilter !== "all" && getAttachmentTypeBucket(a.mime_type) !== typeFilter) {
        return false;
      }
      return true;
    });

    const dateOf = (a: UnifiedAttachment) =>
      a.source_date ? new Date(a.source_date).getTime() : 0;

    const sorted = [...filtered];
    switch (sortBy) {
      case "name":
        sorted.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
      case "size":
        sorted.sort((a, b) => (b.file_size_bytes || 0) - (a.file_size_bytes || 0));
        break;
      case "type":
        sorted.sort((a, b) => {
          const cmp = getAttachmentTypeBucket(a.mime_type).localeCompare(
            getAttachmentTypeBucket(b.mime_type),
          );
          return cmp !== 0 ? cmp : a.filename.localeCompare(b.filename);
        });
        break;
      case "source":
        sorted.sort((a, b) => {
          const cmp = a.source.localeCompare(b.source);
          return cmp !== 0 ? cmp : dateOf(b) - dateOf(a);
        });
        break;
      case "date":
      default:
        sorted.sort((a, b) => dateOf(b) - dateOf(a));
        break;
    }
    return sorted;
  }, [attachments, sourceFilter, typeFilter, sortBy]);

  const handleOpen = useCallback(
    async (attachment: UnifiedAttachment) => {
      setDownloadMessage(null);

      // Already downloaded → preview directly.
      if (attachment.storage_path) {
        setPreviewAttachment(toPreview(attachment));
        return;
      }

      // Text attachments get their bytes at sync time; if missing there is no
      // on-demand path, so open the modal (it shows a "not downloaded" fallback).
      if (attachment.source === "text" || !attachment.email_id) {
        setPreviewAttachment(toPreview(attachment));
        return;
      }

      // Email metadata-only row → force an on-demand download, then preview.
      setDownloadingId(attachment.id);
      try {
        const result = await window.api.transactions.ensureEmailAttachmentDownloaded(
          attachment.email_id,
        );

        if (result.downloadBlocked || result.offline) {
          setDownloadMessage(
            result.reason || "This attachment could not be downloaded.",
          );
          return;
        }

        const refreshed = (result.data || []).find((r) => r.id === attachment.id);
        if (refreshed?.storage_path) {
          setPreviewAttachment(toPreview(refreshed));
          refresh?.();
        } else {
          setDownloadMessage("This attachment could not be downloaded.");
        }
      } catch (err) {
        logger.error("On-demand attachment download failed:", err);
        setDownloadMessage("This attachment could not be downloaded.");
      } finally {
        setDownloadingId(null);
      }
    },
    [refresh],
  );

  const handleOpenWithSystem = useCallback(async (storagePath: string) => {
    try {
      const result = await window.api.transactions.openAttachment(storagePath);
      if (!result.success) {
        logger.error("Failed to open attachment:", result.error);
      }
    } catch (err) {
      logger.error("Error opening attachment:", err);
    }
  }, []);

  // ---- Loading / error / empty states -----------------------------------
  if (loading) {
    return (
      <div className="text-center py-12" data-testid="attachments-loading">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="text-gray-500 mt-4">Loading attachments...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12" data-testid="attachments-error">
        <svg className="w-16 h-16 text-red-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-red-600 mb-2">{error}</p>
        <p className="text-sm text-gray-500">
          Please try again or contact support if the issue persists.
        </p>
      </div>
    );
  }

  if (attachments.length === 0) {
    return (
      <div className="text-center py-12" data-testid="attachments-empty">
        <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
        <p className="text-gray-600 mb-2">No attachments found</p>
        <p className="text-sm text-gray-500">
          Attachments from emails and texts linked to this transaction will appear here
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar: filters + sort */}
      <div className="mb-6 space-y-3">
        {/* Source filter */}
        <div className="flex items-center flex-wrap gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-14">
            Source
          </span>
          <FilterChip label="All" active={sourceFilter === "all"} onClick={() => setSourceFilter("all")} testId="filter-source-all" />
          <FilterChip label="Emails" active={sourceFilter === "email"} onClick={() => setSourceFilter("email")} testId="filter-source-email" />
          <FilterChip label="Texts" active={sourceFilter === "text"} onClick={() => setSourceFilter("text")} testId="filter-source-text" />
        </div>

        {/* Type filter */}
        <div className="flex items-center flex-wrap gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-14">
            Type
          </span>
          <FilterChip label="All" active={typeFilter === "all"} onClick={() => setTypeFilter("all")} testId="filter-type-all" />
          {ATTACHMENT_TYPE_ORDER.filter((b) => presentBuckets.has(b)).map((bucket) => (
            <FilterChip
              key={bucket}
              label={ATTACHMENT_TYPE_LABELS[bucket]}
              active={typeFilter === bucket}
              onClick={() => setTypeFilter(bucket)}
              testId={`filter-type-${bucket}`}
            />
          ))}
        </div>

        {/* Count + sort */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-sm text-gray-500" data-testid="attachments-count">
            {filteredSorted.length} of {attachments.length} attachment
            {attachments.length === 1 ? "" : "s"}
          </span>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <span className="text-gray-400">Sort</span>
            <select
              data-testid="attachments-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="text-sm text-gray-900 bg-white border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Download error banner */}
      {downloadMessage && (
        <div
          className="mb-4 p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm text-amber-700"
          data-testid="attachments-download-message"
        >
          {downloadMessage}
        </div>
      )}

      {/* Grid */}
      {filteredSorted.length === 0 ? (
        <div className="text-center py-12" data-testid="attachments-filtered-empty">
          <p className="text-gray-600 mb-2">No attachments match these filters</p>
          <p className="text-sm text-gray-500">Try a different source or file type.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="attachments-grid">
          {filteredSorted.map((attachment) => (
            <AttachmentCard
              key={attachment.id}
              attachment={attachment}
              onOpen={handleOpen}
              downloading={downloadingId === attachment.id}
            />
          ))}
        </div>
      )}

      {/* Preview modal */}
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
          onOpenWithSystem={handleOpenWithSystem}
        />
      )}
    </div>
  );
}
