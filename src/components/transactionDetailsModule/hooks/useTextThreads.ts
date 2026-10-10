/**
 * BACKLOG-3884: the Texts tab's data — a conversation list (counts inside the audit
 * window and overall, a few header rows each) and, per opened conversation, pages of
 * its texts. The renderer never holds every linked text of the deal.
 *
 * Before: one `transactions:get-communications(txn, "text")` reply carried every
 * linked text (183,043 rows / ~152 MB on the PC) and the tab grouped all of them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Communication } from "../types";
import type { TextPageCursor, TextThreadSummary, TextWindow } from "@electron/types/textThreads";
import { parseLocalCalendarDay } from "../../../utils/dateRangeUtils";
import { transactionService } from "../../../services/transactionService";
import logger from "../../../utils/logger";
import { logOpenPath, nowMs } from "@/utils/openPathTiming";

export type { TextThreadSummary, TextWindow, TextPageCursor };

/** Rows asked for per page (main caps it too). */
export const TEXT_PAGE_SIZE = 200;

/**
 * The audit window as the Texts tab classifies it (`isTimestampInAuditPeriod`): from
 * local midnight of the start day to the last millisecond of the end day. Null when
 * the deal has no dates.
 */
export function auditWindowMs(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): TextWindow | null {
  const s = parseLocalCalendarDay(start);
  const e = parseLocalCalendarDay(end);
  if (!s && !e) return null;
  let endMs: number | null = null;
  if (e) {
    const eod = new Date(e);
    eod.setHours(23, 59, 59, 999);
    endMs = eod.getTime();
  }
  return { startMs: s ? s.getTime() : null, endMs };
}

export interface UseTextThreadsResult {
  threads: TextThreadSummary[] | null;
  loading: boolean;
  error: string | null;
  /** First load shows the spinner; later ones refresh in place. */
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Bumped on every refresh: open conversations re-read their pages. */
  version: number;
}

export function useTextThreads(
  transactionId: string,
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): UseTextThreadsResult {
  const [threads, setThreads] = useState<TextThreadSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const startKey = start instanceof Date ? start.toISOString() : (start ?? null);
  const endKey = end instanceof Date ? end.toISOString() : (end ?? null);
  const seqRef = useRef(0);

  const fetchThreads = useCallback(async (loud: boolean): Promise<void> => {
    const seq = ++seqRef.current;
    if (loud) setLoading(true);
    const startedAt = nowMs();
    try {
      const r = await transactionService.getTextThreads(transactionId, auditWindowMs(startKey, endKey));
      if (seq !== seqRef.current) return;
      if (r.success) {
        const list = r.threads ?? [];
        logOpenPath(`text threads fetched ms=${Math.round(nowMs() - startedAt)} threads=${list.length}`);
        setThreads(list);
        setError(null);
        setVersion((v) => v + 1);
      } else {
        setError(r.error || "Failed to load messages");
      }
    } catch (err) {
      if (seq !== seqRef.current) return;
      logger.error("Failed to load text conversations:", err);
      setError("Failed to load messages");
    } finally {
      if (seq === seqRef.current && loud) setLoading(false);
    }
  }, [transactionId, startKey, endKey]);

  // A different deal or new dates: the old list is not this one.
  useEffect(() => {
    setThreads(null);
    setError(null);
  }, [transactionId, startKey, endKey]);

  const load = useCallback(() => fetchThreads(true), [fetchThreads]);
  const refresh = useCallback(() => fetchThreads(false), [fetchThreads]);
  return { threads, loading, error, load, refresh, version };
}

export interface UseTextThreadPagesResult {
  messages: Communication[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  error: string | null;
}

/**
 * Pages of one conversation (or a merged card's threads), newest first. Loads the
 * first page when `enabled`; `loadMore` appends the next. `version` re-reads the pages
 * already shown (a hide, a restore). `window` null = all history.
 */
export function useTextThreadPages(
  transactionId: string | undefined,
  threadKeys: readonly string[],
  window: TextWindow | null,
  enabled: boolean,
  version = 0,
): UseTextThreadPagesResult {
  const [messages, setMessages] = useState<Communication[]>([]);
  const [cursor, setCursor] = useState<TextPageCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keysKey = threadKeys.join("\u0001");
  const windowKey = window ? `${window.startMs ?? ""}-${window.endMs ?? ""}` : "all";
  const seqRef = useRef(0);
  const pagesRef = useRef(0);

  const readPages = useCallback(async (pages: number): Promise<void> => {
    if (!transactionId || threadKeys.length === 0) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const rows: Communication[] = [];
      let next: TextPageCursor | null = null;
      let read = 0;
      do {
        const r = await transactionService.getTextThreadPage(transactionId, [...threadKeys], window, next, TEXT_PAGE_SIZE);
        if (seq !== seqRef.current) return;
        if (!r.success) {
          setError(r.error || "Failed to load messages");
          return;
        }
        rows.push(...(r.rows ?? []));
        next = r.nextCursor ?? null;
        read += 1;
      } while (next && read < pages);
      pagesRef.current = read;
      setMessages(rows);
      setCursor(next);
      setHasMore(next !== null);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      logger.error("Failed to load conversation:", err);
      setError("Failed to load messages");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
    // keysKey/windowKey stand for threadKeys/window.
  }, [transactionId, keysKey, windowKey]);

  // A different conversation or window starts over at one page.
  useEffect(() => {
    pagesRef.current = 0;
    setMessages([]);
    setCursor(null);
    setHasMore(false);
  }, [transactionId, keysKey, windowKey]);

  useEffect(() => {
    if (!enabled) return;
    void readPages(Math.max(1, pagesRef.current));
  }, [enabled, readPages, version]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!transactionId || !cursor || loading) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const r = await transactionService.getTextThreadPage(transactionId, [...threadKeys], window, cursor, TEXT_PAGE_SIZE);
      if (seq !== seqRef.current) return;
      if (!r.success) {
        setError(r.error || "Failed to load messages");
        return;
      }
      pagesRef.current += 1;
      setMessages((prev) => [...prev, ...(r.rows ?? [])]);
      setCursor(r.nextCursor ?? null);
      setHasMore(!!r.nextCursor);
    } catch (err) {
      if (seq !== seqRef.current) return;
      logger.error("Failed to load more messages:", err);
      setError("Failed to load messages");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [transactionId, keysKey, windowKey, cursor, loading]);

  return { messages, loading, hasMore, loadMore, error };
}
