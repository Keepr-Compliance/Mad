/**
 * `window.api.cloudSync` — Keepr Cloud (BACKLOG-4243). Type-only, so the
 * renderer can import it.
 */

export type CloudSyncStatus =
  | "hidden"
  | "off"
  | "needs_confirmation"
  | "on"
  | "paused"
  | "not_active"
  | "update_needed"
  | "turning_off"
  | "error";

export type CloudSyncPausedReason =
  | "signed_out"
  | "offline"
  | "identity"
  | "other_project"
  | "not_active"
  | "unknown"
  | "dev_blocked";

export interface CloudSyncView {
  /** The upload engine is installed in this build (the switch renders only then). */
  engineInstalled: boolean;
  status: CloudSyncStatus;
  pausedReason: CloudSyncPausedReason | null;
  /** The notice version to show when turning on (null when none). */
  noticeVersion: number | null;
  /** Deals waiting to be saved on this computer. */
  pendingDeals: number;
  /** Deals that could not be saved and will not be retried until they change. */
  notSavedDeals: number;
  /** Online deals saved from this install that this computer has no record of (never deleted automatically). */
  onlineNotHereDeals: number;
  /** Other installs of this account idle for 30+ days, summed; null when none or unknown. */
  otherInstalls: { deals: number; lastSavedAt: string } | null;
  /** ISO time of the last pass that finished with work done, or null. */
  lastSavedAt: string | null;
  /** True when "Manage AI apps" can open the portal page. */
  aiAppsAvailable: boolean;
  /**
   * BACKLOG-4263 PR-4b: this computer's online copy was removed from another computer; nothing is saved until
   * the user chooses to save this computer's deals again (`reclaimInstall`). No screen shows it yet (PR-6).
   */
  installRemoved?: boolean;
}

export interface CloudSyncResult {
  success: boolean;
  /** A fixed code, never a message from the server. */
  error?: string;
  /** Turn-off: the online copy is deleted later, when Keepr can reach the internet. */
  pendingOnline?: boolean;
}

/** BACKLOG-4263 PR-4c: one deal this user deleted on this computer, restorable here (Settings › Keepr Cloud › Removed). */
export interface CloudSyncRemovedDeal {
  transactionId: string;
  propertyAddress: string | null;
  /** ISO time of the delete. */
  removedAt: string;
  /** ISO time after which it can no longer be restored (30 days after the delete). */
  restorableUntil: string;
  /** "Delete for good" was asked and is not finished yet (shown as "Deleting…"; Restore is refused). */
  deleting: boolean;
}

/** BACKLOG-4263 PR-4c: the answer to a restore. `error` codes: see cloudSyncDealArchive RestoreRefusal, signed_out, invalid_input. */
export interface CloudSyncRestoreResult extends CloudSyncResult {
  /** Rows that could not come back (a link whose email, text, attachment or contact no longer exists). */
  skippedLinks?: number;
  /** Another deal on this computer has the same address (restored anyway). */
  otherDealAtAddress?: boolean;
}

/** BACKLOG-4263 PR-4c (Q8): the answer to "Delete for good". */
export interface CloudSyncDeleteForGoodResult extends CloudSyncResult {
  /** done: erased online and here; pending: will finish when Keepr is online; restored_elsewhere: nothing erased. */
  status?: "done" | "pending" | "restored_elsewhere";
}

export interface WindowApiCloudSync {
  getView: () => Promise<CloudSyncView>;
  turnOn: (args: { noticeVersion: number }) => Promise<CloudSyncResult>;
  confirmComputer: () => Promise<CloudSyncResult>;
  turnOff: () => Promise<CloudSyncResult>;
  forgetOtherProject: () => Promise<CloudSyncResult>;
  retry: () => Promise<CloudSyncResult>;
  openAiApps: () => Promise<CloudSyncResult>;
  deleteOnlineNotHere: () => Promise<CloudSyncResult>;
  deleteOldInstalls: () => Promise<CloudSyncResult>;
  /** BACKLOG-4263 PR-4b: "Save this computer's deals again" after its online copy was removed elsewhere. */
  reclaimInstall: () => Promise<CloudSyncResult>;
  /** BACKLOG-4263 PR-4c: this user's deals deleted on this computer in the last 30 days. No screen yet (PR-6). */
  listRemovedDeals: () => Promise<CloudSyncRemovedDeal[]>;
  /** BACKLOG-4263 PR-4c: restore one of them on this computer. No screen yet (PR-6). */
  restoreDeal: (args: { transactionId: string }) => Promise<CloudSyncRestoreResult>;
  /** BACKLOG-4263 PR-4c (Q8): erase one of them now, online and here. No screen yet (PR-6). */
  deleteDealForGood: (args: { transactionId: string }) => Promise<CloudSyncDeleteForGoodResult>;
}
