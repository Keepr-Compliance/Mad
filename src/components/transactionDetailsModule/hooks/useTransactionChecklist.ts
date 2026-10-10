/**
 * useTransactionChecklist — BACKLOG-3476.
 *
 * Every checklist on one transaction (BACKLOG-3476: there may be several), and
 * every write the Checklist tab makes to them.
 * The tab and the Overview line read the SAME instance (TransactionDetails owns
 * it), so the two can never show different progress.
 *
 * ## What this hook refuses to do
 *
 * - **Compute anything.** Progress (per checklist and summed), labels and
 *   membership come from main in `ChecklistsForTransaction`. After a write it asks main again (`reload`) instead of
 *   patching counts locally.
 * - **Ask twice.** A write is followed by exactly ONE `get`, called from the
 *   write itself rather than from an effect on a counter — an effect would run
 *   twice under StrictMode.
 * - **Show one transaction's answer on another.** Every `get` remembers which
 *   transaction it was for; an answer that arrives after the user moved on is
 *   dropped. A late answer for A rendered on B would also make B's next tick
 *   write one of A's item ids.
 * - **Send two ticks for one click.** A checkbox whose write is still in flight
 *   is in `pendingItemIds`; a second click is ignored, so two writes computed
 *   from the same stale `isChecked` cannot race.
 * - **Delete anything but the checklist the user named.** `addChecklist` never
 *   sends a checklist id and never deletes (BACKLOG-3476 round 2: Change is
 *   gone). `removeChecklist(checklistId)` is the only write that deletes a
 *   checklist, and main deletes only the one named. Nothing else can wipe a
 *   checklist's ticks, notes or links.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { checklistService } from "../../../services/checklistService";
import type { ApiResult } from "../../../services";
import logger from "../../../utils/logger";
import { logOpenPath, nowMs } from "../../../utils/openPathTiming";
import type {
  AddChecklistLinkResult,
  ChecklistLinkKind,
  ChecklistsForTransaction,
  SelectChecklistTemplateResult,
} from "../../../../electron/types/checklist";

export type ChecklistLoadState =
  | { status: "loading" }
  | { status: "ready"; data: ChecklistsForTransaction }
  | { status: "error"; error: string };

/** One group of evidence the picker asks main to link. */
export interface ChecklistLinkRequest {
  kind: ChecklistLinkKind;
  targetIds: string[];
  /** BACKLOG-3764: the agent answered "Include it" to the outside-the-dates question. */
  includeOutsideDates?: boolean;
}

export interface ChecklistLinkOutcome {
  request: ChecklistLinkRequest;
  result: ApiResult<AddChecklistLinkResult>;
}

export interface UseTransactionChecklistResult {
  state: ChecklistLoadState;
  /** `state.data` when ready, otherwise null. */
  data: ChecklistsForTransaction | null;
  /** Ask main again. One `get`. */
  reload: () => Promise<void>;
  /**
   * BACKLOG-3595: ask main again because something OUTSIDE this screen changed
   * the checklists (a broker review, an owed pull landing). Never shows
   * `loading`, and a failed read keeps the checklist already shown.
   * BACKLOG-3599: an older answer never overwrites a newer one, and a kept
   * failure changes nothing — so a refresh that overtakes a post-save re-read
   * and then fails leaves the re-read's checklist on screen.
   */
  refresh: () => Promise<void>;
  /** Items whose tick is being written right now. */
  pendingItemIds: ReadonlySet<string>;
  /** `null` when refused because the item already has a write in flight. */
  setItemChecked: (itemId: string, checked: boolean) => Promise<ApiResult<boolean> | null>;
  setItemNote: (itemId: string, note: string | null) => Promise<ApiResult<boolean>>;
  /** Add a checklist. Never replaces or removes one already there. */
  addChecklist: (templateId: string) => Promise<ApiResult<SelectChecklistTemplateResult>>;
  /** Link each request as its own group, in order, then reload once. */
  addLinks: (itemId: string, requests: ChecklistLinkRequest[]) => Promise<ChecklistLinkOutcome[]>;
  removeLink: (linkId: string) => Promise<ApiResult<boolean>>;
  /** Take one checklist off the transaction. Never gated in main. */
  removeChecklist: (checklistId: string) => Promise<ApiResult<boolean>>;
}

interface StoredState {
  forId: string;
  value: ChecklistLoadState;
}

const LOADING: ChecklistLoadState = { status: "loading" };

export function useTransactionChecklist(transactionId: string): UseTransactionChecklistResult {
  const [stored, setStored] = useState<StoredState>(() => ({ forId: transactionId, value: LOADING }));
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(new Set());

  // BACKLOG-3599: the last value handed to `setStored`, written in the SAME
  // statement as every `setStored` — never mirrored from render. Two IPC
  // answers can land before React renders (createRoot batches them); a mirror
  // would then show keep-last-good the pre-batch state.
  const storedRef = useRef<StoredState>(stored);
  const store = useCallback((next: StoredState) => {
    storedRef.current = next;
    setStored(next);
  }, []);

  // The transaction the screen shows NOW. Every async answer is checked
  // against it before it is allowed to render.
  const currentIdRef = useRef(transactionId);
  currentIdRef.current = transactionId;
  // Every `get` takes a number, in the order it was asked.
  const requestSeqRef = useRef(0);
  // BACKLOG-3599: the number of the answer on screen. An answer asked before
  // it is older than what is shown and is dropped.
  const appliedSeqRef = useRef(0);
  const pendingRef = useRef<Set<string>>(new Set());

  /**
   * BACKLOG-3599 — the rule: an older answer never overwrites a newer one, and
   * a kept failure changes nothing.
   *   - An answer for a transaction the screen no longer shows is dropped (the
   *     ONE place that stops A's answer rendering on B).
   *   - A success is stored even while a newer `get` is still in flight — a
   *     post-save re-read overtaken by a background refresh still lands.
   *   - A failure is stored only by the newest `get`.
   */
  const openTimedForRef = useRef<string | null>(null);
  const load = useCallback(
    async (forId: string, options?: { keepOnError?: boolean }): Promise<void> => {
      const seq = ++requestSeqRef.current;
      const startedAt = nowMs();
      const result = await checklistService.get(forId);
      // BACKLOG-3884: the first read per transaction is part of opening it.
      if (openTimedForRef.current !== forId) {
        openTimedForRef.current = forId;
        logOpenPath(
          `checklist read ms=${Math.round(nowMs() - startedAt)}` +
            ` ok=${result.success ? 1 : 0} checklists=${result.data?.checklists?.length ?? 0}`,
        );
      }
      if (forId !== currentIdRef.current || seq <= appliedSeqRef.current) return;
      if (result.success && result.data) {
        appliedSeqRef.current = seq;
        store({ forId, value: { status: "ready", data: result.data } });
        return;
      }
      if (seq !== requestSeqRef.current) return;
      const error = result.error ?? "The checklists could not be loaded.";
      if (options?.keepOnError && storedRef.current.value.status === "ready") {
        // BACKLOG-3595: a background re-read that fails keeps the checklist
        // already on screen. Replacing it with the error would hide the tab
        // (or empty it) and remount the rows, losing an unsaved note. Only
        // when nothing good is shown does the error show — otherwise a
        // refresh that overtook the first load would leave the tab on
        // "loading" for good. A kept failure does not advance `appliedSeqRef`.
        logger.debug("[useTransactionChecklist] background re-read failed; kept the last checklist", error);
        return;
      }
      appliedSeqRef.current = seq;
      store({ forId, value: { status: "error", error } });
    },
    [store],
  );

  useEffect(() => {
    store({ forId: transactionId, value: LOADING });
    pendingRef.current = new Set();
    setPendingItemIds(new Set());
    void load(transactionId);
  }, [transactionId, load, store]);

  const reload = useCallback(() => load(currentIdRef.current), [load]);
  const refresh = useCallback(
    () => load(currentIdRef.current, { keepOnError: true }),
    [load],
  );

  /** Run one write for `forId`, then one `get` if the screen still shows it. */
  const afterWrite = useCallback(
    async <T,>(forId: string, write: () => Promise<T>): Promise<T> => {
      const result = await write();
      if (currentIdRef.current === forId) await load(forId);
      return result;
    },
    [load],
  );

  const setItemChecked = useCallback(
    async (itemId: string, checked: boolean): Promise<ApiResult<boolean> | null> => {
      if (pendingRef.current.has(itemId)) return null;
      pendingRef.current.add(itemId);
      setPendingItemIds(new Set(pendingRef.current));
      try {
        return await afterWrite(currentIdRef.current, () =>
          checklistService.setItemChecked(itemId, checked),
        );
      } finally {
        pendingRef.current.delete(itemId);
        setPendingItemIds(new Set(pendingRef.current));
      }
    },
    [afterWrite],
  );

  const setItemNote = useCallback(
    (itemId: string, note: string | null) =>
      afterWrite(currentIdRef.current, () => checklistService.setItemNote(itemId, note)),
    [afterWrite],
  );

  const addChecklist = useCallback(
    (templateId: string) => {
      const forId = currentIdRef.current;
      // Never a checklist id here: see the file header.
      return afterWrite(forId, () => checklistService.selectTemplate(forId, templateId));
    },
    [afterWrite],
  );

  const addLinks = useCallback(
    (itemId: string, requests: ChecklistLinkRequest[]) =>
      afterWrite(currentIdRef.current, async () => {
        const outcomes: ChecklistLinkOutcome[] = [];
        // Sequential: each group is all-or-nothing in main, and a partial
        // failure has to be attributable to the row that caused it.
        for (const request of requests) {
          const result = await checklistService.addLink(
            itemId,
            request.kind,
            request.targetIds,
            request.includeOutsideDates,
          );
          outcomes.push({ request, result });
        }
        return outcomes;
      }),
    [afterWrite],
  );

  const removeLink = useCallback(
    (linkId: string) => afterWrite(currentIdRef.current, () => checklistService.removeLink(linkId)),
    [afterWrite],
  );

  const removeChecklist = useCallback(
    (checklistId: string) => {
      const forId = currentIdRef.current;
      return afterWrite(forId, () => checklistService.remove(forId, checklistId));
    },
    [afterWrite],
  );

  // An answer stored for a different transaction is not an answer for this one.
  // Covers the render between the new id arriving and the effect resetting the
  // store — without it that frame paints A's checklist under B's header.
  const state = stored.forId === transactionId ? stored.value : LOADING;

  return {
    state,
    data: state.status === "ready" ? state.data : null,
    reload,
    refresh,
    pendingItemIds,
    setItemChecked,
    setItemNote,
    addChecklist,
    addLinks,
    removeLink,
    removeChecklist,
  };
}

export default useTransactionChecklist;
