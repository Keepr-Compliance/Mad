/**
 * RCS import service — BACKLOG-3619 (proof of concept).
 *
 * The renderer's abstraction over `window.api.rcsImport`. Components never
 * touch `window.api` directly.
 */

import { type ApiResult, getErrorMessage } from "./index";

import type {
  RcsImportJobResult,
  RcsImportStatus,
  RcsImportStatusResult,
  RcsJobInfo,
  RcsExtensionState,
} from "../../electron/types/ipc/window-api-rcs-import";

export type { RcsImportStatus, RcsJobInfo };

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

  /** BACKLOG-3658: start the cache job (all recent chats) for the signed-in user. */
  async startCacheJob(args?: { sinceDays?: number }): Promise<ApiResult<RcsJobInfo | null>> {
    const bridge = api();
    if (!bridge || !bridge.startCacheJob) return { success: false, error: NOT_AVAILABLE };
    return callJob(() => bridge.startCacheJob(args));
  },

  /** BACKLOG-3658/3659: is the extension installed / paired, and the cache state. */
  async getExtensionState(): Promise<ApiResult<RcsExtensionState>> {
    const bridge = api();
    if (!bridge || !bridge.getExtensionState) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.getExtensionState();
      return r.success ? { success: true, data: r.state } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** BACKLOG-3659 P3d: Settings → Google Messages → Force re-import. */
  async clearTexts(): Promise<ApiResult<{ messagesDeleted: number }>> {
    const bridge = api();
    if (!bridge || !bridge.clearTexts) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.clearTexts();
      return r.success ? { success: true, data: { messagesDeleted: r.messagesDeleted } } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** P3b: accept the consent text of `version`, or withdraw (null). */
  async setCacheConsent(version: number | null): Promise<ApiResult<void>> {
    const bridge = api();
    if (!bridge || !bridge.setCacheConsent) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.setCacheConsent({ version });
      return r.success ? { success: true } : { success: false, error: r.error ?? "Keepr could not save that." };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** P3b: the auto-delete setting (off by default; 90 days when on). */
  async setCacheAutoDelete(on: boolean): Promise<ApiResult<void>> {
    const bridge = api();
    if (!bridge || !bridge.setCacheOptions) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.setCacheOptions({ autoDelete: on });
      return r.success ? { success: true } : { success: false, error: r.error ?? "Keepr could not save that." };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** BACKLOG-3659: copy the extension to Downloads/"Keepr Extension". */
  async prepareExtension(): Promise<ApiResult<{ folder: string; version: string }>> {
    const bridge = api();
    if (!bridge || !bridge.prepareExtension) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.prepareExtension();
      return r.success ? { success: true, data: { folder: r.folder, version: r.version } } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  async showExtensionFolder(): Promise<void> {
    await api()?.showExtensionFolder?.();
  },

  /** Copies "chrome://extensions" and starts Chrome; says whether Chrome was started. */
  async openChromeForExtension(): Promise<{ copied: boolean; opened: boolean }> {
    const bridge = api();
    if (!bridge || !bridge.openChromeForExtension) return { copied: false, opened: false };
    try {
      const r = await bridge.openChromeForExtension();
      return { copied: r.copied, opened: r.opened };
    } catch {
      return { copied: false, opened: false };
    }
  },

  /** Subscribe to job changes. Returns an unsubscribe (a no-op when unavailable). */
  onJobProgress(callback: (job: RcsJobInfo) => void): () => void {
    const bridge = api();
    if (!bridge) return () => {};
    return bridge.onJobProgress(callback);
  },

  /**
   * BACKLOG-3657: the texts imported from Google Messages for Web were cleared
   * (Settings > Android Messages > Force re-import). Returns an unsubscribe.
   */
  onDataCleared(callback: (event: { messagesDeleted: number }) => void): () => void {
    const bridge = api();
    if (!bridge || !bridge.onDataCleared) return () => {};
    return bridge.onDataCleared(callback);
  },

  /**
   * BACKLOG-3658: a cache Sync's texts were saved and auto-linked (after the
   * Sync's /finish, so a refetch on finish alone is too early). Returns an
   * unsubscribe.
   */
  onDataChanged(callback: (event: { reason: string }) => void): () => void {
    const bridge = api();
    if (!bridge || !bridge.onDataChanged) return () => {};
    return bridge.onDataChanged(callback);
  },
};
