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
 * Render `<AttachmentPreviewHost preview={…} />` once, where the modal should
 * mount; it renders nothing until an attachment is open.
 */
import React, { useCallback, useState } from "react";
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

export interface UseAttachmentPreviewResult {
  /** Open one attachment: preview it, downloading it first when it is metadata-only. */
  open: (attachment: UnifiedAttachment) => Promise<void>;
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

  const open = useCallback(
    async (attachment: UnifiedAttachment) => {
      setMessage(null);

      // Already downloaded → preview directly.
      if (attachment.storage_path) {
        setPreview(toPreview(attachment));
        return;
      }

      // Text attachments get their bytes at sync time; if missing there is no
      // on-demand path, so open the modal (it shows a "not downloaded" fallback).
      if (attachment.source === "text" || !attachment.email_id) {
        setPreview(toPreview(attachment));
        return;
      }

      // Email metadata-only row → force an on-demand download, then preview.
      setDownloadingId(attachment.id);
      try {
        const result = await window.api.transactions.ensureEmailAttachmentDownloaded(
          attachment.email_id,
        );

        if (result.downloadBlocked || result.offline) {
          setMessage(result.reason || ATTACHMENT_DOWNLOAD_FAILED);
          return;
        }

        const refreshed = (result.data || []).find((r) => r.id === attachment.id);
        if (refreshed?.storage_path) {
          setPreview(toPreview(refreshed));
          refresh?.();
        } else {
          setMessage(ATTACHMENT_DOWNLOAD_FAILED);
        }
      } catch (err) {
        logger.error("On-demand attachment download failed:", err);
        setMessage(ATTACHMENT_DOWNLOAD_FAILED);
      } finally {
        setDownloadingId(null);
      }
    },
    [refresh],
  );

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

  return { open, preview, closePreview, downloadingId, message, openWithSystem };
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
