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
  /** ISO time of the last pass that finished with work done, or null. */
  lastSavedAt: string | null;
  /** True when "Manage AI apps" can open the portal page. */
  aiAppsAvailable: boolean;
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
}
