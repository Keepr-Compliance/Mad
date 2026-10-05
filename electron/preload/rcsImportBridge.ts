/**
 * RCS import bridge — BACKLOG-3619 (proof of concept).
 *
 * `window.api.rcsImport`. Each method is one `ipcRenderer.invoke` of one
 * channel; the `on…` ones subscribe to a main-process push and return an
 * unsubscribe.
 */

import { ipcRenderer } from "electron";

import type {
  RcsImportJobResult,
  RcsExtensionStateResult,
  RcsImportStatusResult,
  RcsJobInfo,
  RcsPrepareExtensionResult,
  RcsClearTextsResult,
} from "../types/ipc/window-api-rcs-import";

export const rcsImportBridge = {
  getStatus: (): Promise<RcsImportStatusResult> => ipcRenderer.invoke("rcs-import:get-status"),

  // BACKLOG-3620: sync jobs
  startJob: (args: { transactionId: string }): Promise<RcsImportJobResult> =>
    ipcRenderer.invoke("rcs-import:start-job", args),

  cancelJob: (args: { jobId: string }): Promise<RcsImportJobResult> =>
    ipcRenderer.invoke("rcs-import:cancel-job", args),

  getJob: (): Promise<RcsImportJobResult> => ipcRenderer.invoke("rcs-import:get-job"),

  onJobProgress: (callback: (job: RcsJobInfo) => void) => {
    const handler = (_event: unknown, data: RcsJobInfo) => callback(data);
    ipcRenderer.on("rcs-import:job-progress", handler);
    return () => {
      ipcRenderer.removeListener("rcs-import:job-progress", handler);
    };
  },

  /** BACKLOG-3658: the cache job and the extension state. */
  retryCacheJob: (): Promise<RcsImportJobResult> => ipcRenderer.invoke("rcs-import:retry-cache-job"),
  startCacheJob: (args?: { sinceDays?: number }): Promise<RcsImportJobResult> =>
    ipcRenderer.invoke("rcs-import:start-cache-job", args),
  getExtensionState: (): Promise<RcsExtensionStateResult> => ipcRenderer.invoke("rcs-import:get-extension-state"),
  /** P3b: consent and cache options. */
  setCacheConsent: (args: { version: number | null }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("rcs-import:set-cache-consent", args),
  setCacheOptions: (args: { autoDelete?: boolean; contactsOnly?: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("rcs-import:set-cache-options", args),
  /** SR M: "Download photos / videos from all chats". */
  setMediaOptions: (args: { photosAllChats?: boolean; videosAllChats?: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("rcs-import:set-media-options", args),

  /** BACKLOG-3658 P3c: the chats switched off ("Don't sync"). */
  listExclusions: () => ipcRenderer.invoke("rcs-import:list-exclusions"),

  /** BACKLOG-3659 P3d: Google Messages' own Force re-import. */
  clearTexts: (): Promise<RcsClearTextsResult> => ipcRenderer.invoke("rcs-import:clear-texts"),

  /** BACKLOG-3659: the extension, delivered to Downloads (Release 1: unpacked). */
  prepareExtension: (): Promise<RcsPrepareExtensionResult> => ipcRenderer.invoke("rcs-import:prepare-extension"),
  showExtensionFolder: (): Promise<{ success: boolean }> => ipcRenderer.invoke("rcs-import:show-extension-folder"),
  openChromeForExtension: (): Promise<{ success: true; copied: boolean; opened: boolean }> =>
    ipcRenderer.invoke("rcs-import:open-chrome-for-extension"),

  /** BACKLOG-3658 (SR S1): a cache Sync was saved and auto-linked. */
  /** C1: Keepr's "Enter the code from your browser" screen. */
  linkState: () => ipcRenderer.invoke("rcs-import:link-state"),
  linkEnterCode: (args: { code: string }) => ipcRenderer.invoke("rcs-import:link-enter-code", args),
  linkDismissWarning: () => ipcRenderer.invoke("rcs-import:link-dismiss-warning"),
  linkForget: () => ipcRenderer.invoke("rcs-import:link-forget"),
  openGoogleMessages: () => ipcRenderer.invoke("rcs-import:open-google-messages"),
  openExtensionStore: () => ipcRenderer.invoke("rcs-import:open-extension-store"),
  onOpenLinkScreen: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("rcs-import:open-link-screen", handler);
    return () => {
      ipcRenderer.removeListener("rcs-import:open-link-screen", handler);
    };
  },
  onDataChanged: (callback: (event: { reason: string }) => void) => {
    const handler = (_event: unknown, data: { reason: string }) => callback(data);
    ipcRenderer.on("rcs-import:data-changed", handler);
    return () => {
      ipcRenderer.removeListener("rcs-import:data-changed", handler);
    };
  },

  /** BACKLOG-3657: Google Messages for Web texts were cleared (Force re-import). */
  onDataCleared: (callback: (event: { messagesDeleted: number }) => void) => {
    const handler = (_event: unknown, data: { messagesDeleted: number }) => callback(data);
    ipcRenderer.on("rcs-import:data-cleared", handler);
    return () => {
      ipcRenderer.removeListener("rcs-import:data-cleared", handler);
    };
  },
};
