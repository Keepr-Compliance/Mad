/**
 * `window.api.cloudTodos` — the Keepr Cloud todo screens (BACKLOG-4263 PR-6). Type-only, so the renderer can
 * import it. Every answer is decided in main (electron/services/cloudSync/todoScreens.ts).
 */
import type { JsonValue } from "../../services/cloudSync/jcs";

export interface CloudTodoResult {
  success: boolean;
  /** A fixed code: cloud_off, offline, locked, not_found, not_restorable, unavailable, invalid_input. */
  error?: string;
}

/** A notice shown on the Checklist tab. */
export interface CloudTodoNotice {
  id: number;
  /** conflict: another side changed the same part; the rest are one-line notices about a change. */
  kind: "conflict" | "dropped_not_online" | "local_write_failed" | "links_not_restored" | "not_accepted";
  /** The local item it is about (resolved through the online id when needed), or null when it is gone. */
  itemId: string | null;
  title: string | null;
  /** conflict only. */
  part: "done" | "title" | "note" | "due" | null;
  /** conflict only: the version this computer does not show now, as text. */
  otherText: string | null;
  /** conflict only: that version's value, for "Use this version". */
  otherValue: JsonValue | null;
  /** conflict only: who made the other change, in the user's words ("Claude", "another computer"). */
  who: string | null;
  /** links_not_restored: how many links could not come back. */
  count?: number | null;
}

/** The latest change of an item by an AI app. */
export interface CloudTodoMarker {
  kind: "ticked" | "unticked" | "changed" | "added";
  /** The app's name, or "an AI app". */
  who: string;
  /** ISO time of the change. */
  at: string;
}

export interface CloudTodosForDeal {
  /** Keepr Cloud is on for this user on this computer (local read). Off: nothing is shown. */
  on: boolean;
  online: boolean;
  notices: CloudTodoNotice[];
  /** item id -> marker */
  markers: Record<string, CloudTodoMarker>;
}

export interface CloudTodoHistoryRow {
  who: string;
  at: string | null;
  part: string | null;
  oldText: string | null;
  newText: string | null;
  /** False when this change was not kept (it lost to a later one). */
  kept: boolean;
}

export interface CloudTodoHistoryResult extends CloudTodoResult {
  rows: CloudTodoHistoryRow[];
}

export interface CloudTodoRemovedItem {
  entity: "item" | "checklist";
  cloudId: string;
  title: string;
  removedAt: string | null;
}

export interface CloudTodoRemovedResult extends CloudTodoResult {
  items: CloudTodoRemovedItem[];
}

/** Settings › Keepr Cloud › Removed: a deal removed online that this computer has no archive of. */
export interface CloudSyncRemovedOnlineDeal {
  cloudId: string;
  propertyAddress: string | null;
  removedAt: string | null;
  restorableUntil: string | null;
  /** online: not on this computer, Restore makes the online copy live; rejected: still here, marked Rejected. */
  kind: "online" | "rejected";
}

export interface WindowApiCloudTodos {
  getForDeal: (args: { transactionId: string }) => Promise<CloudTodosForDeal>;
  dismissNotice: (args: { noticeId: number }) => Promise<CloudTodoResult>;
  history: (args: { itemId: string }) => Promise<CloudTodoHistoryResult>;
  listRemoved: (args: { transactionId: string }) => Promise<CloudTodoRemovedResult>;
  restore: (args: { transactionId: string; entity: "item" | "checklist"; cloudId: string }) => Promise<CloudTodoResult>;
  /** main -> renderer `cloud-todos:changed` (a pull changed todos on this computer). Returns the unsubscribe. */
  onChanged: (callback: () => void) => () => void;
}
