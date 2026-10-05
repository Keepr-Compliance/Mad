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
  RcsLinkState,
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

  /** Founder: "Try again" after a failed Google Messages Sync (skips the chats it saved). */
  async retryCacheJob(): Promise<ApiResult<RcsJobInfo | null>> {
    const bridge = api();
    if (!bridge || !bridge.retryCacheJob) return { success: false, error: NOT_AVAILABLE };
    const retry = bridge.retryCacheJob;
    return callJob(() => retry());
  },

  /**
   * SR C7: the consent the user agreed to (the version of the line shown), or
   * withdrawn (null) — Keepr's rcs_consent record.
   */
  async setCacheConsent(version: number | null): Promise<ApiResult<void>> {
    const bridge = api();
    if (!bridge || !bridge.setCacheConsent) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.setCacheConsent({ version });
      return r.success ? { success: true } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
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

  /** BACKLOG-3658 P3c: the chats switched off ("Don't sync"). */
  async listExclusions(): Promise<ApiResult<Array<{ id: string; title: string | null; createdAt: string }>>> {
    const bridge = api();
    if (!bridge || !bridge.listExclusions) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.listExclusions();
      return r.success ? { success: true, data: r.chats } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** BACKLOG-3659 P3d: Settings → Google Messages → Force re-import. */
  /** Android's shared Force re-import: Google Messages + the companion's texts and contacts. */
  async clearTexts(): Promise<ApiResult<{ messagesDeleted: number; androidMessagesDeleted: number; contactsDeleted: number }>> {
    const bridge = api();
    if (!bridge || !bridge.clearTexts) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.clearTexts();
      return r.success
        ? {
            success: true,
            data: {
              messagesDeleted: r.messagesDeleted,
              androidMessagesDeleted: r.androidMessagesDeleted ?? 0,
              contactsDeleted: r.contactsDeleted ?? 0,
            },
          }
        : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },


  /** SR M: "Download photos / videos from all chats" (switching one ON reads existing chats' media next Sync). */
  async setMediaOptions(args: { photosAllChats?: boolean; videosAllChats?: boolean }): Promise<ApiResult<void>> {
    const bridge = api();
    if (!bridge || !bridge.setMediaOptions) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.setMediaOptions(args);
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
  /** C1: Keepr's link screen state (the popup's pending code), and whether this user is linked. */
  async linkState(): Promise<ApiResult<{ link: RcsLinkState; linked: boolean }>> {
    const bridge = api();
    if (!bridge || !bridge.linkState) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.linkState();
      return { success: true, data: { link: r.link, linked: r.linked } };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** C1: the 6-digit code the user typed (shown by the extension's popup). */
  async linkEnterCode(code: string): Promise<ApiResult<void>> {
    const bridge = api();
    if (!bridge || !bridge.linkEnterCode) return { success: false, error: NOT_AVAILABLE };
    try {
      const r = await bridge.linkEnterCode({ code });
      return r.success ? { success: true } : { success: false, error: r.error };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },

  /** The link screen's "Open Google Messages" (works without a link). */
  /** A02 "Add to Chrome": the store listing. */
  async openExtensionStore(): Promise<void> {
    try {
      await api()?.openExtensionStore?.();
    } catch {
      /* nothing opened */
    }
  },

  async openGoogleMessages(): Promise<void> {
    try {
      await api()?.openGoogleMessages?.();
    } catch {
      /* nothing opened */
    }
  },

  /** SR (B1): Keepr's "Forget link". */
  async linkForget(): Promise<void> {
    await api()?.linkForget?.();
  },

  async linkDismissWarning(): Promise<void> {
    try {
      await api()?.linkDismissWarning?.();
    } catch {
      /* nothing to dismiss */
    }
  },

  /** C1: keepr://link asked for the link screen. Returns an unsubscribe. */
  onOpenLinkScreen(callback: () => void): () => void {
    const bridge = api();
    if (!bridge || !bridge.onOpenLinkScreen) return () => {};
    return bridge.onOpenLinkScreen(callback);
  },

  onDataChanged(callback: (event: { reason: string }) => void): () => void {
    const bridge = api();
    if (!bridge || !bridge.onDataChanged) return () => {};
    return bridge.onDataChanged(callback);
  },
};
