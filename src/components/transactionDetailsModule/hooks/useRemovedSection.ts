/**
 * useRemovedSection Hook (BACKLOG-1793)
 *
 * Shared state machine for the collapsible "Show removed" section that lives at
 * the bottom of both the Emails tab and the Texts/Messages tab. Extracts the
 * removed-section machinery originally built for the email side (BACKLOG-1780)
 * so BOTH tabs consume ONE code path instead of maintaining parallel copies.
 *
 * Encapsulates, parameterised by item type via the callback props:
 *  - Controlled/uncontrolled open state (lifted by the parent so the section
 *    survives the loading-spinner unmount — restore never collapses it).
 *  - Mount-time rehydrate (re-fetches when re-mounted while already open, e.g.
 *    the post-loading-spinner cycle).
 *  - refreshKey silent re-fetch (updates the count in place after an unlink).
 *  - Restore with in-place list update + a SILENT parent refresh callback
 *    (onRestoreComplete) that never toggles a loading flag — no spinner, no
 *    unmount, the scroll container never shifts (BACKLOG-1780 round-6 fix).
 *
 * Thin adapters (RemovedEmailsSection / RemovedMessagesSection) provide the
 * data-shape-specific pieces (fetch, group, restore, in-place removal) and the
 * card rendering; this hook owns the behaviour that must be identical on both.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import logger from "../../../utils/logger";

/** Result shape returned by a restore call. `restoredCount` defaults to 1. */
export interface RemovedRestoreResult {
  success: boolean;
  restoredCount?: number;
  error?: string;
}

export interface UseRemovedSectionParams<TRow, TGroup> {
  transactionId: string;
  /**
   * Externally controlled open state. When provided the parent owns the value
   * (lifting it above the loading-spinner remount boundary keeps the section
   * expanded across refetches). Falls back to internal state when undefined.
   */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Increment after each successful unlink to trigger a SILENT re-fetch of the
   * removed list (updates the count label in place — no spinner).
   */
  refreshKey?: number;
  /**
   * Fetch the raw removed rows. Should REJECT (throw) when the data is
   * unavailable or the backend reports failure; a resolved value (even []) is
   * treated as authoritative and replaces the current list.
   */
  fetchRows: (transactionId: string) => Promise<TRow[]>;
  /** Group raw rows into display groups (thread grouping, ignored-id grouping…). */
  groupRows: (rows: TRow[]) => TGroup[];
  /** Derive the count-label number from the current rows/groups. */
  computeCount: (rows: TRow[], groups: TGroup[]) => number;
  /** Perform the restore for one group (re-link + drop suppression record). */
  restoreGroup: (group: TGroup) => Promise<RemovedRestoreResult>;
  /**
   * Given the prior rows and the just-restored group, return the rows to keep.
   * Runs in place — no refetch — for the common case.
   */
  removeRestoredRows: (rows: TRow[], group: TGroup, restoredCount: number) => TRow[];
  /** Stable key identifying which group is currently restoring (spinner state). */
  getRestoreKey: (group: TGroup) => string;
  /**
   * SILENT parent refresh after a successful restore. Must NOT set a loading
   * flag — that is what keeps the scroll position from jumping.
   */
  onRestoreComplete?: () => void | Promise<void>;
  /** Optional side-effect after a successful fetch (e.g. resolve contact names). */
  onRowsFetched?: (rows: TRow[]) => void | Promise<void>;
  onShowSuccess?: (message: string) => void;
  onShowError?: (message: string) => void;
  /** Build the success toast from the restored count. */
  successMessage: (restoredCount: number) => string;
  /**
   * BACKLOG-1719: build the toast for a BULK restore. `restoredTotal` is the sum
   * of restoredCount across groups; `groupCount` is how many groups were
   * restored. Defaults to `successMessage(restoredTotal)` when omitted.
   */
  bulkSuccessMessage?: (restoredTotal: number, groupCount: number) => string;
  /** Fallback error toast when the backend gives no message. */
  errorMessage: string;
  /** Label used in logger.error messages (e.g. "removed emails"). */
  logLabel: string;
}

export interface UseRemovedSectionResult<TGroup> {
  isOpen: boolean;
  loading: boolean;
  groups: TGroup[];
  totalCount: number | null;
  restoringId: string | null;
  handleToggle: () => Promise<void>;
  handleRestore: (group: TGroup) => Promise<void>;
  // BACKLOG-1719: multi-select bulk restore.
  /** Whether the removed list is in selection mode (checkboxes visible). */
  selectionMode: boolean;
  /** Enter selection mode. */
  enterSelectionMode: () => void;
  /** Exit selection mode and clear the current selection. */
  exitSelectionMode: () => void;
  /** Number of currently selected groups. */
  selectedCount: number;
  /** Whether the given group is selected. */
  isGroupSelected: (group: TGroup) => boolean;
  /** Toggle the given group's selection. */
  toggleGroupSelection: (group: TGroup) => void;
  /** Select every currently visible group. */
  selectAllGroups: () => void;
  /** Clear the selection (stays in selection mode). */
  deselectAllGroups: () => void;
  /** Restore every selected group sequentially, then ONE silent refresh + toast. */
  bulkRestore: () => Promise<void>;
  /** Whether a bulk restore is in progress. */
  isBulkRestoring: boolean;
}

export function useRemovedSection<TRow, TGroup>(
  params: UseRemovedSectionParams<TRow, TGroup>
): UseRemovedSectionResult<TGroup> {
  const {
    transactionId,
    isOpen: externalIsOpen,
    onOpenChange,
    refreshKey,
    fetchRows,
    groupRows,
    computeCount,
    restoreGroup,
    removeRestoredRows,
    getRestoreKey,
    onRestoreComplete,
    onRowsFetched,
    onShowSuccess,
    onShowError,
    successMessage,
    bulkSuccessMessage,
    errorMessage,
    logLabel,
  } = params;

  // Controlled/uncontrolled open state. Parent-controlled value survives the
  // loading-spinner remount so a restore never collapses the section.
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const setIsOpen = useCallback(
    (open: boolean) => {
      if (onOpenChange) onOpenChange(open);
      else setInternalIsOpen(open);
    },
    [onOpenChange]
  );

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<TRow[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // BACKLOG-1719: multi-select bulk-restore state.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [isBulkRestoring, setIsBulkRestoring] = useState(false);

  // Keep a ref to the latest rows so the restore handler can compute the
  // in-place removal without depending on setState updater timing.
  const rowsRef = useRef<TRow[]>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const groups = useMemo(() => groupRows(rows), [rows, groupRows]);

  // BACKLOG-1719: selection keys use the stable per-group restore key.
  const groupKeySet = useMemo(
    () => new Set(groups.map((g) => getRestoreKey(g))),
    [groups, getRestoreKey]
  );

  // Prune selected keys that no longer correspond to a visible group (e.g. after
  // a silent refetch removed a restored group). Keeps the count honest.
  useEffect(() => {
    setSelectedKeys((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (groupKeySet.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [groupKeySet]);

  const isGroupSelected = useCallback(
    (group: TGroup) => selectedKeys.has(getRestoreKey(group)),
    [selectedKeys, getRestoreKey]
  );

  const toggleGroupSelection = useCallback(
    (group: TGroup) => {
      const key = getRestoreKey(group);
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [getRestoreKey]
  );

  const selectAllGroups = useCallback(() => {
    setSelectedKeys(new Set(groups.map((g) => getRestoreKey(g))));
  }, [groups, getRestoreKey]);

  const deselectAllGroups = useCallback(() => {
    setSelectedKeys(new Set());
  }, []);

  const enterSelectionMode = useCallback(() => setSelectionMode(true), []);
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedKeys(new Set());
  }, []);

  const applyRows = useCallback(
    (fetched: TRow[]) => {
      const g = groupRows(fetched);
      setRows(fetched);
      setTotalCount(computeCount(fetched, g));
      void onRowsFetched?.(fetched);
    },
    [groupRows, computeCount, onRowsFetched]
  );

  /**
   * Fetch the removed list.
   * - `silent: false` (toggle / mount): shows the spinner and, on failure,
   *   clears the list to an empty state.
   * - `silent: true` (refreshKey): no spinner and, on failure, LEAVES the
   *   existing list untouched (matches the BACKLOG-1780 refreshKey semantics).
   */
  const runFetch = useCallback(
    async (opts: { silent: boolean }): Promise<void> => {
      if (!opts.silent) setLoading(true);
      try {
        const fetched = await fetchRows(transactionId);
        applyRows(fetched);
      } catch (err) {
        if (!opts.silent) {
          logger.error(`Failed to fetch ${logLabel}:`, err);
          setRows([]);
          setTotalCount(0);
        }
        // silent: intentionally leave the current list in place.
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [fetchRows, transactionId, applyRows, logLabel]
  );

  // Hold the latest runFetch in a ref so the mount / refreshKey effects can call
  // it without re-subscribing (the mount effect must fire exactly once).
  const runFetchRef = useRef(runFetch);
  useEffect(() => {
    runFetchRef.current = runFetch;
  }, [runFetch]);

  // Mount-time rehydrate: if the section is already open when it (re)mounts —
  // e.g. after a loading-spinner cycle where the parent's open state stayed
  // true — fetch immediately so the list is populated without user interaction.
  useEffect(() => {
    // Intentionally empty deps: captures the mount-time `isOpen` and fires once.
    // runFetchRef keeps the latest fetch closure, so no stale-closure risk.
    if (isOpen) void runFetchRef.current({ silent: false });
  }, []); // eslint-disable-line -- fire exactly once on mount (mount-rehydrate)

  // refreshKey silent re-fetch after an unlink. Initialised to the current
  // refreshKey so the first render (refreshKey=0) does not fire — only genuine
  // increments (0→1, 1→2, …) trigger a re-fetch.
  const lastRefreshKey = useRef(refreshKey ?? 0);
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    void runFetchRef.current({ silent: true });
  }, [refreshKey]);

  const handleToggle = useCallback(async () => {
    if (!isOpen) {
      await runFetch({ silent: false });
    }
    setIsOpen(!isOpen);
  }, [isOpen, setIsOpen, runFetch]);

  const handleRestore = useCallback(
    async (group: TGroup) => {
      // Blur focused element so the browser doesn't try to scroll it into view.
      (document.activeElement as HTMLElement | null)?.blur?.();

      setRestoringId(getRestoreKey(group));
      try {
        const result = await restoreGroup(group);
        if (result.success) {
          const count = result.restoredCount ?? 1;
          onShowSuccess?.(successMessage(count));
          // In-place list update — no refetch needed for the common case.
          const nextRows = removeRestoredRows(rowsRef.current, group, count);
          const nextGroups = groupRows(nextRows);
          setRows(nextRows);
          setTotalCount(computeCount(nextRows, nextGroups));
          // SILENT parent refresh — never sets loading=true, so the tab stays
          // mounted and the scroll container never shifts.
          await onRestoreComplete?.();
        } else {
          onShowError?.(result.error || errorMessage);
        }
      } catch (err) {
        logger.error(`Failed to restore ${logLabel}:`, err);
        onShowError?.(err instanceof Error ? err.message : errorMessage);
      } finally {
        setRestoringId(null);
      }
    },
    [
      getRestoreKey,
      restoreGroup,
      removeRestoredRows,
      groupRows,
      computeCount,
      onShowSuccess,
      onShowError,
      onRestoreComplete,
      successMessage,
      errorMessage,
      logLabel,
    ]
  );

  // BACKLOG-1719: bulk restore. Restores each selected group SEQUENTIALLY,
  // accumulating the in-place row removals, then performs exactly ONE silent
  // parent refresh and shows ONE toast. Mirrors handleRestore's invariants: no
  // loading flag, no spinner, the scroll container is never touched.
  const bulkRestore = useCallback(async () => {
    if (selectedKeys.size === 0) return;

    // Blur focused element so the browser doesn't try to scroll it into view.
    (document.activeElement as HTMLElement | null)?.blur?.();

    setIsBulkRestoring(true);
    try {
      // Snapshot the selected groups from the current display order.
      const currentGroups = groupRows(rowsRef.current);
      const targets = currentGroups.filter((g) => selectedKeys.has(getRestoreKey(g)));

      let workingRows = rowsRef.current;
      let restoredTotal = 0;
      let restoredGroups = 0;
      let firstError: string | null = null;

      for (const group of targets) {
        try {
          const result = await restoreGroup(group);
          if (result.success) {
            const count = result.restoredCount ?? 1;
            restoredTotal += count;
            restoredGroups += 1;
            workingRows = removeRestoredRows(workingRows, group, count);
          } else if (!firstError) {
            firstError = result.error || errorMessage;
          }
        } catch (err) {
          logger.error(`Failed to bulk-restore ${logLabel}:`, err);
          if (!firstError) firstError = err instanceof Error ? err.message : errorMessage;
        }
      }

      // One in-place list update for everything restored.
      const nextGroups = groupRows(workingRows);
      setRows(workingRows);
      setTotalCount(computeCount(workingRows, nextGroups));
      setSelectedKeys(new Set());

      if (restoredGroups > 0) {
        onShowSuccess?.(
          bulkSuccessMessage
            ? bulkSuccessMessage(restoredTotal, restoredGroups)
            : successMessage(restoredTotal)
        );
        // SINGLE silent parent refresh at the end — never sets loading=true.
        await onRestoreComplete?.();
      } else if (firstError) {
        onShowError?.(firstError);
      }
    } finally {
      setIsBulkRestoring(false);
    }
  }, [
    selectedKeys,
    groupRows,
    getRestoreKey,
    restoreGroup,
    removeRestoredRows,
    computeCount,
    onShowSuccess,
    onShowError,
    onRestoreComplete,
    bulkSuccessMessage,
    successMessage,
    errorMessage,
    logLabel,
  ]);

  return {
    isOpen,
    loading,
    groups,
    totalCount,
    restoringId,
    handleToggle,
    handleRestore,
    selectionMode,
    enterSelectionMode,
    exitSelectionMode,
    selectedCount: selectedKeys.size,
    isGroupSelected,
    toggleGroupSelection,
    selectAllGroups,
    deselectAllGroups,
    bulkRestore,
    isBulkRestoring,
  };
}
