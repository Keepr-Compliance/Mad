/**
 * The Dashboard's two panel reads — BACKLOG-3965 PR-4b.
 *
 * Recent  = `transactions:get-recently-opened` (PR-2) through
 *           transactionOpenService.getRecentlyOpened.
 * Todo    = `checklists:list-open-required` (PR-3) through
 *           checklistService.listOpenRequired.
 * Both services never throw; a failure comes back as `success: false`.
 *
 * Both are read again when the Transactions view closes (the Dashboard stays
 * mounted under it) and after a Todo tick. Todo is read only when the plan
 * gate answered "allowed".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { transactionOpenService } from "../../../services/transactionOpenService";
import { checklistService } from "../../../services/checklistService";
import { subscribeTransactionsViewClosed } from "../../../appCore/openTransactionRequest";
import type { RecentlyOpenedTransaction } from "../../../../electron/types/transactionOpen";
import type { OpenRequiredChecklistItems } from "../../../../electron/types/checklistTodo";

/** How many recently opened deals the panel shows (UI rule: lists of 3-5). */
export const RECENT_LIMIT = 5;
/** How many Todo rows are read; "Show more" expands within these. */
export const TODO_READ_LIMIT = 50;

/**
 * Main's refusal when the plan does not carry checklists
 * (CHECKLISTS_NOT_ALLOWED_ERROR, electron/handlers/checklistHandlers.ts).
 * Copied, not imported: the renderer may not value-import main-process code.
 * A parity test reads the handler source and pins the two together.
 */
export const CHECKLISTS_NOT_ALLOWED_MESSAGE = "Transaction checklists are not available.";

export type RecentState =
  | { status: "loading" }
  | { status: "ready"; rows: RecentlyOpenedTransaction[] }
  | { status: "error" };

export type TodoState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; data: OpenRequiredChecklistItems }
  /** Main said the plan does not include checklists. */
  | { status: "not-on-plan" }
  /** The read failed for any other reason. */
  | { status: "error" };

export interface TickError {
  itemId: string;
  message: string;
}

export interface DashboardPanels {
  recent: RecentState;
  todo: TodoState;
  reload: () => void;
  /** Tick one Todo item. Main refuses it on a locked deal or a plan without checklists. */
  tickItem: (itemId: string) => Promise<void>;
  tickingItemId: string | null;
  tickError: TickError | null;
}

export function useDashboardPanels(
  userId: string | undefined,
  todoEnabled: boolean,
): DashboardPanels {
  const [recent, setRecent] = useState<RecentState>({ status: "loading" });
  const [todo, setTodo] = useState<TodoState>({ status: todoEnabled ? "loading" : "off" });
  const [reloadKey, setReloadKey] = useState(0);
  const [tickingItemId, setTickingItemId] = useState<string | null>(null);
  const [tickError, setTickError] = useState<TickError | null>(null);
  const todoReadId = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => subscribeTransactionsViewClosed(reload), [reload]);

  // Recent does not wait for the plan gate: it is read once per mount and
  // per reload, whatever the gate answers.
  const recentReadId = useRef(0);
  useEffect(() => {
    if (!userId) return;
    const id = ++recentReadId.current;
    void transactionOpenService.getRecentlyOpened(userId, RECENT_LIMIT).then((result) => {
      if (recentReadId.current !== id) return;
      setRecent(result.success && result.data ? { status: "ready", rows: result.data } : { status: "error" });
    });
  }, [userId, reloadKey]);

  useEffect(() => {
    const id = ++todoReadId.current;
    if (!userId || !todoEnabled) {
      setTodo({ status: "off" });
      return;
    }
    // Keep the last answer on screen during a re-read; only a first read shows "loading".
    setTodo((prev) => (prev.status === "off" ? { status: "loading" } : prev));
    void checklistService.listOpenRequired(userId, TODO_READ_LIMIT).then((result) => {
      if (todoReadId.current !== id) return;
      if (result.success && result.data) {
        setTodo({ status: "ready", data: result.data });
      } else if (result.error === CHECKLISTS_NOT_ALLOWED_MESSAGE) {
        setTodo({ status: "not-on-plan" });
      } else {
        setTodo({ status: "error" });
      }
    });
  }, [userId, todoEnabled, reloadKey]);

  const tickItem = useCallback(
    async (itemId: string) => {
      setTickingItemId(itemId);
      setTickError(null);
      const result = await checklistService.setItemChecked(itemId, true);
      setTickingItemId(null);
      if (result.success) {
        reload();
      } else {
        setTickError({ itemId, message: result.error || "That item couldn't be updated." });
      }
    },
    [reload],
  );

  return { recent, todo, reload, tickItem, tickingItemId, tickError };
}
