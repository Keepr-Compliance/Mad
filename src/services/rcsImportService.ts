/**
 * RCS import service — BACKLOG-3619 (proof of concept).
 *
 * The renderer's abstraction over `window.api.rcsImport`. Components never
 * touch `window.api` directly.
 */

import { type ApiResult, getErrorMessage } from "./index";

import type {
  RcsChatReceivedEvent,
  RcsImportJobResult,
  RcsImportStatus,
  RcsImportStatusResult,
  RcsJobInfo,
} from "../../electron/types/ipc/window-api-rcs-import";

export type { RcsChatReceivedEvent, RcsImportStatus, RcsJobInfo };

const NOT_AVAILABLE = "Import is not available in this build.";

function api() {
  return typeof window !== "undefined" ? window.api?.rcsImport : undefined;
}

async function call(
  fn: () => Promise<RcsImportStatusResult>,
): Promise<ApiResult<RcsImportStatus>> {
  try {
    const result = await fn();
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: result.status };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

async function callJob(
  fn: () => Promise<RcsImportJobResult>,
): Promise<ApiResult<RcsJobInfo | null>> {
  try {
    const result = await fn();
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: result.job };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

export const rcsImportService = {
  async getStatus(): Promise<ApiResult<RcsImportStatus>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return call(() => bridge.getStatus());
  },

  async startSession(transactionId: string): Promise<ApiResult<RcsImportStatus>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return call(() => bridge.startSession({ transactionId }));
  },

  async endSession(sessionId: string): Promise<ApiResult<RcsImportStatus>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return call(() => bridge.endSession({ sessionId }));
  },

  // BACKLOG-3620: sync jobs

  /** Start a sync job: Keepr opens Messages for Web in the browser. */
  async startJob(transactionId: string): Promise<ApiResult<RcsJobInfo | null>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return callJob(() => bridge.startJob({ transactionId }));
  },

  async cancelJob(jobId: string): Promise<ApiResult<RcsJobInfo | null>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return callJob(() => bridge.cancelJob({ jobId }));
  },

  async getJob(): Promise<ApiResult<RcsJobInfo | null>> {
    const bridge = api();
    if (!bridge) return { success: false, error: NOT_AVAILABLE };
    return callJob(() => bridge.getJob());
  },

  /** Subscribe to job changes. Returns an unsubscribe (a no-op when unavailable). */
  onJobProgress(callback: (job: RcsJobInfo) => void): () => void {
    const bridge = api();
    if (!bridge) return () => {};
    return bridge.onJobProgress(callback);
  },

  /** Subscribe to chats as they land. Returns an unsubscribe (a no-op when unavailable). */
  onChatReceived(callback: (event: RcsChatReceivedEvent) => void): () => void {
    const bridge = api();
    if (!bridge) return () => {};
    return bridge.onChatReceived(callback);
  },
};
