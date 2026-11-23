/**
 * Keepr Cloud service (renderer) — BACKLOG-4243.
 *
 * The renderer's abstraction over `window.api.cloudSync`. Components never
 * touch `window.api`. A thrown invoke becomes a fixed failure; nothing here
 * logs a reply.
 */
import type {
  CloudSyncDeleteForGoodResult,
  CloudSyncRemovedDeal,
  CloudSyncRestoreResult,
  CloudSyncResult,
  CloudSyncView,
} from "../../electron/types/ipc/window-api-cloud-sync";
import type { CloudSyncRemovedOnlineDeal } from "../../electron/types/ipc/window-api-cloud-todos";

export const CLOUD_SYNC_UNREACHABLE = "unreachable";

/** BACKLOG-4243: main shows the Keepr Cloud section (and its tab and panel row). Null (unreachable) reads hidden. */
export function keeprCloudSectionVisible(view: CloudSyncView | null): boolean {
  return !!view && view.status !== "hidden";
}

async function call(fn: () => Promise<CloudSyncResult>): Promise<CloudSyncResult> {
  try {
    return await fn();
  } catch {
    return { success: false, error: CLOUD_SYNC_UNREACHABLE };
  }
}

export const cloudSyncService = {
  /** Null when main could not be reached (the section stays hidden). */
  async getView(): Promise<CloudSyncView | null> {
    try {
      return await window.api.cloudSync.getView();
    } catch {
      return null;
    }
  },
  turnOn: (noticeVersion: number) => call(() => window.api.cloudSync.turnOn({ noticeVersion })),
  confirmComputer: () => call(() => window.api.cloudSync.confirmComputer()),
  turnOff: () => call(() => window.api.cloudSync.turnOff()),
  forgetOtherProject: () => call(() => window.api.cloudSync.forgetOtherProject()),
  retry: () => call(() => window.api.cloudSync.retry()),
  openAiApps: () => call(() => window.api.cloudSync.openAiApps()),
  deleteOnlineNotHere: () => call(() => window.api.cloudSync.deleteOnlineNotHere()),
  deleteOldInstalls: () => call(() => window.api.cloudSync.deleteOldInstalls()),
  /** BACKLOG-4263 PR-6: "Save this computer's deals again". */
  reclaimInstall: () => call(() => window.api.cloudSync.reclaimInstall()),
  /** BACKLOG-4263 P2: "Use this computer instead". */
  useThisComputer: () => call(() => window.api.cloudSync.useThisComputer()),
  /** BACKLOG-4263 PR-6: Keepr Cloud on for this user here (local read, no network); false when main is unreachable. */
  async localState(): Promise<{ on: boolean; online: boolean }> {
    try {
      return await window.api.cloudSync.localState();
    } catch {
      return { on: false, online: false };
    }
  },
  /** BACKLOG-4263 PR-6: deals this user deleted here and can restore here. Empty when main is unreachable. */
  async listRemovedDeals(): Promise<CloudSyncRemovedDeal[]> {
    try {
      return await window.api.cloudSync.listRemovedDeals();
    } catch {
      return [];
    }
  },
  restoreDeal: (transactionId: string) =>
    call(() => window.api.cloudSync.restoreDeal({ transactionId })) as Promise<CloudSyncRestoreResult>,
  deleteDealForGood: (transactionId: string) =>
    call(() => window.api.cloudSync.deleteDealForGood({ transactionId })) as Promise<CloudSyncDeleteForGoodResult>,
  /** BACKLOG-4263 PR-6: deals removed online with no archive here. */
  async listRemovedOnline(): Promise<{ success: boolean; error?: string; deals: CloudSyncRemovedOnlineDeal[] }> {
    try {
      return await window.api.cloudSync.listRemovedOnline();
    } catch {
      return { success: false, error: CLOUD_SYNC_UNREACHABLE, deals: [] };
    }
  },
  restoreOnlineDeal: (cloudId: string) => call(() => window.api.cloudSync.restoreOnlineDeal({ cloudId })),
};

export default cloudSyncService;
