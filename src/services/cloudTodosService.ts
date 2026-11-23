/**
 * Keepr Cloud todo screens (renderer) — BACKLOG-4263 PR-6.
 *
 * The renderer's abstraction over `window.api.cloudTodos`. Components never touch `window.api`. A thrown invoke
 * becomes a fixed answer that shows nothing (the screens stay as they were for a user without Keepr Cloud).
 */
import type {
  CloudTodoHistoryResult,
  CloudTodoRemovedResult,
  CloudTodoResult,
  CloudTodosForDeal,
} from "../../electron/types/ipc/window-api-cloud-todos";

const UNREACHABLE = "unreachable";
const OFF: CloudTodosForDeal = { on: false, online: false, notices: [], markers: {} };

export const cloudTodosService = {
  async getForDeal(transactionId: string): Promise<CloudTodosForDeal> {
    try {
      return await window.api.cloudTodos.getForDeal({ transactionId });
    } catch {
      return OFF;
    }
  },
  async dismissNotice(noticeId: number): Promise<CloudTodoResult> {
    try {
      return await window.api.cloudTodos.dismissNotice({ noticeId });
    } catch {
      return { success: false, error: UNREACHABLE };
    }
  },
  async history(itemId: string): Promise<CloudTodoHistoryResult> {
    try {
      return await window.api.cloudTodos.history({ itemId });
    } catch {
      return { success: false, error: UNREACHABLE, rows: [] };
    }
  },
  async listRemoved(transactionId: string): Promise<CloudTodoRemovedResult> {
    try {
      return await window.api.cloudTodos.listRemoved({ transactionId });
    } catch {
      return { success: false, error: UNREACHABLE, items: [] };
    }
  },
  async restore(transactionId: string, entity: "item" | "checklist", cloudId: string): Promise<CloudTodoResult> {
    try {
      return await window.api.cloudTodos.restore({ transactionId, entity, cloudId });
    } catch {
      return { success: false, error: UNREACHABLE };
    }
  },
  /**
   * Subscribes to `cloud-todos:changed` (a pass changed todos here, or the server answered this computer's todo
   * changes); returns the unsubscribe (a no-op when the bridge is absent).
   */
  onChanged(callback: () => void): () => void {
    try {
      return window.api.cloudTodos.onChanged(callback);
    } catch {
      return () => undefined;
    }
  },
};

export default cloudTodosService;
