/**
 * Keepr Cloud service (renderer) — BACKLOG-4243.
 *
 * The renderer's abstraction over `window.api.cloudSync`. Components never
 * touch `window.api`. A thrown invoke becomes a fixed failure; nothing here
 * logs a reply.
 */
import type {
  CloudSyncResult,
  CloudSyncView,
} from "../../electron/types/ipc/window-api-cloud-sync";

export const CLOUD_SYNC_UNREACHABLE = "unreachable";

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
};

export default cloudSyncService;
