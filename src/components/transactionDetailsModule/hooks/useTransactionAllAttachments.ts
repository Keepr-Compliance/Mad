/**
 * useTransactionAllAttachments Hook (BACKLOG-322 Phase A)
 *
 * Loads the UNIFIED list of every attachment linked to a transaction — email AND
 * text/iMessage — including metadata-only rows whose bytes have not been
 * downloaded yet (storage_path NULL). Backed by the `transactions:get-all-attachments`
 * IPC handler, so it does not depend on the Emails/Texts communications being
 * pre-loaded.
 */
import { useState, useEffect, useCallback } from "react";
import logger from "../../../utils/logger";

/**
 * A single attachment row in the unified Attachments tab.
 * Mirrors the DB service `TransactionAttachmentRow` shape.
 */
export interface UnifiedAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  /** NULL when the file has not been downloaded yet (metadata-only row). */
  storage_path: string | null;
  created_at: string | null;
  source: "email" | "text";
  /** Owning email/message date — shown in the context line and used for date sort. */
  source_date: string | null;
  direction: string | null;
  /** Email subject (email rows only). */
  context_subject: string | null;
  /** Email sender, or a text message's flattened participants. */
  context_sender: string | null;
  email_id: string | null;
  message_id: string | null;
}

interface UseTransactionAllAttachmentsResult {
  /** Unified email + text attachments linked to the transaction. */
  attachments: UnifiedAttachment[];
  /** Whether attachments are currently being loaded. */
  loading: boolean;
  /** Error message if loading failed. */
  error: string | null;
  /** Total count of attachments (for the tab badge). */
  count: number;
  /** Reload the attachments list (e.g. after an on-demand download). */
  refresh: () => Promise<void>;
  /**
   * BACKLOG-3730: ids of the attachments dated inside the transaction's
   * start–end window, as main computes it for the submission. `null` when the
   * transaction has no dates (nothing to scope to).
   */
  inWindowIds: Set<string> | null;
}

/**
 * BACKLOG-3730: the transaction's raw dates. They are handed to main as-is;
 * main reads them through `auditPeriodFromRow` and the submit's window query,
 * so the renderer applies no date logic of its own.
 */
export interface AttachmentWindow {
  startedAt?: string | null;
  closedAt?: string | null;
}

/**
 * Load all attachments (email + text) for a transaction.
 *
 * @param transactionId - Transaction to load attachments for
 * @param auditStart - Optional audit window start (ISO). Omit to match the
 *   Emails/Texts tabs, which show all linked content regardless of date.
 * @param auditEnd - Optional audit window end (ISO)
 * @param scope - BACKLOG-3730: the transaction's raw dates. When either is set,
 *   a second, windowed fetch yields `inWindowIds`; `attachments` stays the full list.
 */
export function useTransactionAllAttachments(
  transactionId: string,
  auditStart?: string,
  auditEnd?: string,
  scope?: AttachmentWindow,
): UseTransactionAllAttachmentsResult {
  const [attachments, setAttachments] = useState<UnifiedAttachment[]>([]);
  const [inWindowIds, setInWindowIds] = useState<Set<string> | null>(null);
  const windowStart = scope?.startedAt || undefined;
  const windowEnd = scope?.closedAt || undefined;
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadAttachments = useCallback(async (): Promise<void> => {
    if (!transactionId) {
      setAttachments([]);
      setInWindowIds(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const hasWindow = Boolean(windowStart || windowEnd);
      const [result, windowed] = await Promise.all([
        window.api.transactions.getAllAttachments(
          transactionId,
          auditStart,
          auditEnd,
        ),
        hasWindow
          ? window.api.transactions.getAllAttachments(
              transactionId,
              windowStart,
              windowEnd,
            )
          : Promise.resolve(null),
      ]);

      if (result.success && result.data) {
        if (windowed && !(windowed.success && windowed.data)) {
          setError(windowed.error || "Failed to load attachments");
          setAttachments([]);
          setInWindowIds(null);
        } else {
          setAttachments(result.data);
          setInWindowIds(
            windowed?.data
              ? new Set(windowed.data.map((a: UnifiedAttachment) => a.id))
              : null,
          );
        }
      } else {
        setError(result.error || "Failed to load attachments");
        setAttachments([]);
        setInWindowIds(null);
      }
    } catch (err) {
      logger.error("Failed to load transaction attachments:", err);
      setError("Failed to load attachments");
      setAttachments([]);
      setInWindowIds(null);
    } finally {
      setLoading(false);
    }
  }, [transactionId, auditStart, auditEnd, windowStart, windowEnd]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  return {
    attachments,
    loading,
    error,
    count: attachments.length,
    refresh: loadAttachments,
    inWindowIds,
  };
}
