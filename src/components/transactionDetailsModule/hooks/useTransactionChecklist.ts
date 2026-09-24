/**
 * useTransactionChecklist — BACKLOG-3476.
 *
 * One transaction's checklist, and every write the Checklist tab makes to it.
 * The tab and the Overview line read the SAME instance (TransactionDetails owns
 * it), so the two can never show different progress.
 *
 * ## What this hook refuses to do
 *
 * - **Compute anything.** Progress, labels and membership come from main in
 *   `ChecklistDetail`. After a write it asks main again (`reload`) instead of
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
 * - **Pass `replaceExisting` on a plain pick.** Only an explicit replace — the
 *   change-template confirmation — passes it. A plain pick onto a transaction
 *   that already has a checklist is then refused by main (`exists`) instead of
 *   silently wiping ticks, notes and links.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { checklistService } from "../../../services/checklistService";
import type { ApiResult } from "../../../services";
import type {
  AddChecklistLinkResult,
  ChecklistDetail,
  ChecklistLinkKind,
  SelectChecklistTemplateResult,
} from "../../../../electron/types/checklist";

export type ChecklistLoadState =
  | { status: "loading" }
  | { status: "ready"; detail: ChecklistDetail | null }
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
  /** `state.detail` when ready, otherwise null. */
  detail: ChecklistDetail | null;
  /** Ask main again. One `get`. */
  reload: () => Promise<void>;
  /** Items whose tick is being written right now. */
  pendingItemIds: ReadonlySet<string>;
  /** `null` when refused because the item already has a write in flight. */
  setItemChecked: (itemId: string, checked: boolean) => Promise<ApiResult<boolean> | null>;
  setItemNote: (itemId: string, note: string | null) => Promise<ApiResult<boolean>>;
  /** A plain pick. Never replaces an existing checklist. */
  pickTemplate: (templateId: string) => Promise<ApiResult<SelectChecklistTemplateResult>>;
  /** The change-template confirmation. Clears every tick, note and link. */
  replaceTemplate: (templateId: string) => Promise<ApiResult<SelectChecklistTemplateResult>>;
  /** Link each request as its own group, in order, then reload once. */
  addLinks: (itemId: string, requests: ChecklistLinkRequest[]) => Promise<ChecklistLinkOutcome[]>;
  removeLink: (linkId: string) => Promise<ApiResult<boolean>>;
  /** Take the checklist off the transaction. Never gated in main. */
  remove: () => Promise<ApiResult<boolean>>;
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
  // A newer `get` for the same transaction supersedes an older one.
  const requestSeqRef = useRef(0);
  const pendingRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (forId: string): Promise<void> => {
    const seq = ++requestSeqRef.current;
    const result = await checklistService.get(forId);
    if (seq !== requestSeqRef.current || currentIdRef.current !== forId) return;
    setStored({
      forId,
      value: result.success
        ? { status: "ready", detail: result.data ?? null }
        : { status: "error", error: result.error ?? "The checklist could not be loaded." },
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

  const pickTemplate = useCallback(
    (templateId: string) => {
      const forId = currentIdRef.current;
      // Two arguments, on purpose: see the file header.
      return afterWrite(forId, () => checklistService.selectTemplate(forId, templateId));
    },
    [afterWrite],
  );

  const replaceTemplate = useCallback(
    (templateId: string) => {
      const forId = currentIdRef.current;
      return afterWrite(forId, () => checklistService.selectTemplate(forId, templateId, true));
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

  const remove = useCallback(() => {
    const forId = currentIdRef.current;
    return afterWrite(forId, () => checklistService.remove(forId));
  }, [afterWrite]);

  // An answer stored for a different transaction is not an answer for this one.
  const state = stored.forId === transactionId ? stored.value : LOADING;

  return {
    state,
    detail: state.status === "ready" ? state.detail : null,
    reload,
    pendingItemIds,
    setItemChecked,
    setItemNote,
    pickTemplate,
    replaceTemplate,
    addLinks,
    removeLink,
    remove,
  };
}

export default useTransactionChecklist;
