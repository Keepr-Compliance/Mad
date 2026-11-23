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
  | "error"
  /** BACKLOG-4263 P2: another computer is the account's active one; nothing from this computer is saved online. */
  | "other_computer";

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
   * the user chooses to save this computer's deals again (`reclaimInstall`). Settings › Keepr Cloud shows it (PR-6).
   */
  installRemoved?: boolean;
  /** BACKLOG-4263 PR-6: changes from other devices or AI apps not applied here yet (locked deal / anything else). */
  parked?: { locked: number; other: number };
  /** BACKLOG-4263 PR-6: online deals of this install the owner restored online ("Online only"), from the last check. */
  restoredOnlineOnly?: number;
  /**
   * BACKLOG-4263 P2: with status `off` (the notice changed), another computer is the account's active one. Turning on
   * re-accepts the notice; then "Use this computer instead" is offered.
   */
  otherComputerActive?: boolean;
  /** BACKLOG-4263 P2: a turn-off made here offline was dropped because another computer became active first. */
  turnOffDropped?: boolean;
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

/**
 * BACKLOG-4263 PR-4c: the answer to a restore. `error` codes: not_found, not_owner, purge_owed, deal_exists, cloud_off,
 * restore_failed, archive_not_understood (written by another Keepr version; kept, Delete for good still erases it),
 * signed_out, invalid_input (cloudSyncDealArchive RestoreRefusal).
 */
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

import type { CloudSyncRemovedOnlineDeal, CloudTodoResult } from "./window-api-cloud-todos";

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
  /** BACKLOG-4263 P2: "Use this computer instead" (Settings › Keepr Cloud, status other_computer). */
  useThisComputer: () => Promise<CloudSyncResult>;
  /** BACKLOG-4263 PR-4c: this user's deals deleted on this computer in the last 30 days (Settings › Keepr Cloud › Removed). */
  listRemovedDeals: () => Promise<CloudSyncRemovedDeal[]>;
  /** BACKLOG-4263 PR-4c: restore one of them on this computer. Settings › Keepr Cloud › Removed. */
  restoreDeal: (args: { transactionId: string }) => Promise<CloudSyncRestoreResult>;
  /** BACKLOG-4263 PR-4c (Q8): erase one of them now, online and here. Settings › Keepr Cloud › Removed. */
  deleteDealForGood: (args: { transactionId: string }) => Promise<CloudSyncDeleteForGoodResult>;
  /** BACKLOG-4263 PR-6: local only: Keepr Cloud is on for this user here; this computer is online. */
  localState: () => Promise<{ on: boolean; online: boolean }>;
  /** BACKLOG-4263 PR-6: deals removed online in the last 30 days with no archive here (Settings › Removed). */
  listRemovedOnline: () => Promise<{ success: boolean; error?: string; deals: CloudSyncRemovedOnlineDeal[] }>;
  /** BACKLOG-4263 PR-6: make one of them live online again ("Online only"). */
  restoreOnlineDeal: (args: { cloudId: string }) => Promise<CloudTodoResult>;
}
