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
  const [stored, setStored] = useState<StoredState>({ forId: transactionId, value: LOADING });
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(new Set());

  // The transaction the screen shows NOW. Every async answer is checked
  // against it before it is allowed to render.
  const currentIdRef = useRef(transactionId);
  currentIdRef.current = transactionId;
  // Every `get` takes a number; only the newest may store its answer. Switching
  // transactions starts a new `get`, so this also drops A's late answer on B.
  const requestSeqRef = useRef(0);
  const pendingRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (forId: string): Promise<void> => {
    const seq = ++requestSeqRef.current;
    const result = await checklistService.get(forId);
    if (seq !== requestSeqRef.current) return;
    setStored({
      forId,
      value:
        result.success && result.data
        ? { status: "ready", data: result.data }
        : { status: "error", error: result.error ?? "The checklists could not be loaded." },
    });
  }, []);

  useEffect(() => {
    setStored({ forId: transactionId, value: LOADING });
    pendingRef.current = new Set();
    setPendingItemIds(new Set());
    void load(transactionId);
  }, [transactionId, load]);

  const reload = useCallback(() => load(currentIdRef.current), [load]);

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
          const result = await checklistService.addLink(itemId, request.kind, request.targetIds);
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
