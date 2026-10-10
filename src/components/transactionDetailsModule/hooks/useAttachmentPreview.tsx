/**
 * useAttachmentPreview — BACKLOG-3476.
 *
 * The one way this module opens an attachment for preview. Moved out of
 * TransactionAttachmentsTab so every surface that offers "View" on an
 * attachment takes the same path:
 *
 *   - a row that already has bytes (`storage_path`) previews directly;
 *   - a text attachment, or one with no email, previews directly too (the
 *     modal shows its own "not downloaded" fallback — there is no on-demand
 *     path for texts);
 *   - an EMAIL row that is metadata-only first forces an on-demand download
 *     (`ensureEmailAttachmentDownloaded`, which fills the EXISTING row by id —
 *     BACKLOG-1870), then previews the refreshed row and calls `refresh` once.
 *
 * `openWithSystem` hands a downloaded file to the OS.
 *
 * BACKLOG-3884 (2.40): the email views (EmailViewModal, EmailThreadViewModal)
 * open attachments through this hook too. Their list comes from
 * `emails:get-attachments`, which only downloads when an email has ZERO rows,
 * so a metadata-only row reached the preview with no bytes and rendered an
 * empty body. `open` accepts their rows (pass `email_id`), returns whether the
 * preview opened, and `retry` re-runs the last failed open.
 *
 * Render `<AttachmentPreviewHost preview={…} />` once, where the modal should
 * mount; it renders nothing until an attachment is open.
 */
import React, { useCallback, useRef, useState } from "react";
import { AttachmentPreviewModal } from "../components/modals/AttachmentPreviewModal";
import type { UnifiedAttachment } from "./useTransactionAllAttachments";
import logger from "../../../utils/logger";

/** Shape AttachmentPreviewModal expects (a subset of the unified row). */
export interface PreviewAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

export const ATTACHMENT_DOWNLOAD_FAILED = "This attachment could not be downloaded.";

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
 * Any row that can be opened: the unified tab row, or an email view's row plus
 * the owning email id. `source` defaults to "email" when `email_id` is set.
 */
export type OpenableAttachment = PreviewAttachment & {
  source?: UnifiedAttachment["source"];
  email_id?: string | null;
};

export interface UseAttachmentPreviewResult {
  /**
   * Open one attachment: preview it, downloading it first when it is
   * metadata-only. Resolves true when the preview opened.
   */
  open: (attachment: OpenableAttachment) => Promise<boolean>;
  /** Re-run the last open that failed; resolves false when there is none. */
  retry: () => Promise<boolean>;
  /** The attachment being previewed, or null. */
  preview: PreviewAttachment | null;
  closePreview: () => void;
  /** The attachment whose on-demand download is in flight, or null. */
  downloadingId: string | null;
  /** Why the last open could not preview, or null. */
  message: string | null;
  openWithSystem: (storagePath: string) => Promise<void>;
}

/**
 * @param refresh called once after an on-demand download reconciles a row, so
 *   the caller's list shows the downloaded state.
 */
export function useAttachmentPreview(refresh?: () => void): UseAttachmentPreviewResult {
  const [preview, setPreview] = useState<PreviewAttachment | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const failedRef = useRef<OpenableAttachment | null>(null);

  const open = useCallback(
    async (attachment: OpenableAttachment): Promise<boolean> => {
      setMessage(null);
      failedRef.current = null;

      // Already downloaded → preview directly.
      if (attachment.storage_path) {
        setPreview(toPreview(attachment));
        return true;
      }

      // Text attachments get their bytes at sync time; if missing there is no
      // on-demand path, so open the modal (it shows a "not downloaded" fallback).
      if (attachment.source === "text" || !attachment.email_id) {
        setPreview(toPreview(attachment));
        return true;
      }

      const fail = (reason: string): false => {
        failedRef.current = attachment;
        setMessage(reason);
        return false;
      };

      // Email metadata-only row → force an on-demand download, then preview.
      setDownloadingId(attachment.id);
      try {
        const result = await window.api.transactions.ensureEmailAttachmentDownloaded(
          attachment.email_id,
        );

        if (result.downloadBlocked || result.offline) {
          return fail(result.reason || ATTACHMENT_DOWNLOAD_FAILED);
        }

        const refreshed = (result.data || []).find((r) => r.id === attachment.id);
        if (refreshed?.storage_path) {
          setPreview(toPreview(refreshed));
          refresh?.();
          return true;
        }
        return fail(ATTACHMENT_DOWNLOAD_FAILED);
      } catch (err) {
        logger.error("On-demand attachment download failed:", err);
        return fail(ATTACHMENT_DOWNLOAD_FAILED);
      } finally {
        setDownloadingId(null);
      }
    },
    [refresh],
  );

  const retry = useCallback(async (): Promise<boolean> => {
    const last = failedRef.current;
    if (!last) return false;
    return open(last);
  }, [open]);

  const openWithSystem = useCallback(async (storagePath: string) => {
    try {
      const result = await window.api.transactions.openAttachment(storagePath);
      if (!result.success) {
        logger.error("Failed to open attachment:", result.error);
      }
    } catch (err) {
      logger.error("Error opening attachment:", err);
    }
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  return { open, retry, preview, closePreview, downloadingId, message, openWithSystem };
}

/**
 * BACKLOG-3884: the failed-open notice — the reason plus a Retry that re-runs
 * the same open. Renders nothing while there is no message.
 */
export function AttachmentOpenError({
  preview,
  className = "",
}: {
  preview: Pick<UseAttachmentPreviewResult, "message" | "retry" | "downloadingId">;
  className?: string;
}): React.ReactElement | null {
  if (!preview.message) return null;
  return (
    <div
      role="alert"
      data-testid="attachment-open-error"
      className={`flex items-center justify-between gap-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 ${className}`}
    >
      <span>{preview.message}</span>
      <button
        type="button"
        onClick={() => void preview.retry()}
        disabled={preview.downloadingId !== null}
        className="flex-shrink-0 px-3 py-1 text-sm font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md disabled:opacity-60"
        data-testid="attachment-open-retry"
      >
        Retry
      </button>
    </div>
  );
}

/** Mounts the preview modal for a `useAttachmentPreview` result; nothing when closed. */
export function AttachmentPreviewHost({
  preview,
}: {
  preview: UseAttachmentPreviewResult;
}): React.ReactElement | null {
  if (!preview.preview) return null;
  return (
    <AttachmentPreviewModal
      attachment={preview.preview}
      onClose={preview.closePreview}
      onOpenWithSystem={(path) => void preview.openWithSystem(path)}
    />
  );
}

export default useAttachmentPreview;
