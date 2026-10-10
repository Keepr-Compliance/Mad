/**
 * useTransactionAllAttachments Hook (BACKLOG-322 Phase A)
 *
 * Loads the UNIFIED list of every attachment linked to a transaction — email AND
 * text/iMessage — including metadata-only rows whose bytes have not been
 * downloaded yet (storage_path NULL). Backed by the `transactions:get-all-attachments`
 * IPC handler, so it does not depend on the Emails/Texts communications being
 * pre-loaded.
 */
import { useState, useEffect, useCallback, useRef } from "react";
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
  /**
   * BACKLOG-3884: load only once this is true. The reader runs synchronously on
   * main and materializes every linked text to find the ones with attachments
   * (~0.6 s for 105k linked texts, twice per open), so TransactionDetails
   * enables it only when a tab that shows attachments is opened. While false,
   * nothing is fetched and `refresh` is a no-op: the first enabled load reads
   * the current state anyway. Default true (load on mount, as before).
   */
  enabled?: boolean;
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
  const enabled = scope?.enabled ?? true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAttachments = useCallback(async (): Promise<void> => {
    // BACKLOG-3884: not shown yet -> nothing to refresh; the first enabled load
    // reads the current state.
    if (!enabledRef.current) return;
    if (!transactionId) {
      setAttachments([]);
      setInWindowIds(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const startedAt = Date.now();
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

      // BACKLOG-3884: duration and row count only.
      logger.info(
        `[TxnOpen] attachments fetched ms=${Date.now() - startedAt}` +
          ` rows=${Array.isArray(result?.data) ? result.data.length : 0} windowed=${hasWindow}`,
      );
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

  // BACKLOG-3884: one read at a time. A refresh while a read is in flight does
  // not start a second, parallel read (each one runs on main); it marks ONE
  // trailing read that starts when the current one ends, so N overlapping
  // refreshes cost one extra read, and a write made before the refresh is
  // always read. Joining the in-flight read instead could return data read
  // before that write.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const trailingRef = useRef<Promise<void> | null>(null);
  const fetchRef = useRef(fetchAttachments);
  fetchRef.current = fetchAttachments;
  const loadAttachments = useCallback((): Promise<void> => {
    if (inFlightRef.current) {
      if (!trailingRef.current) {
        trailingRef.current = inFlightRef.current.then(() => {
          trailingRef.current = null;
          return loadAttachments();
        });
      }
      return trailingRef.current;
    }
    const run = fetchRef.current().finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, []);

  // `fetchAttachments` changes with the transaction / dates: reload then.
  useEffect(() => {
    if (!enabled) return;
    loadAttachments();
  }, [loadAttachments, fetchAttachments, enabled]);

  return {
    attachments,
    loading,
    error,
    count: attachments.length,
    refresh: loadAttachments,
    inWindowIds,
  };
}
