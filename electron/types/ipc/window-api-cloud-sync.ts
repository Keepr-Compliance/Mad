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
}
