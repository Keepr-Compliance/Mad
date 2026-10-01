/**
 * RCS import bridge — BACKLOG-3619 (proof of concept).
 *
 * `window.api.rcsImport`. Each method is one `ipcRenderer.invoke` of one
 * channel; `onChatReceived` subscribes to the main process's push and returns
 * an unsubscribe.
 */

import { ipcRenderer } from "electron";

import type {
  RcsChatReceivedEvent,
  RcsImportJobResult,
  RcsExtensionStateResult,
  RcsImportStatusResult,
  RcsJobInfo,
} from "../types/ipc/window-api-rcs-import";

export const rcsImportBridge = {
  getStatus: (): Promise<RcsImportStatusResult> => ipcRenderer.invoke("rcs-import:get-status"),

  startSession: (args: { transactionId: string }): Promise<RcsImportStatusResult> =>
    ipcRenderer.invoke("rcs-import:start-session", args),

  endSession: (args: { sessionId: string }): Promise<RcsImportStatusResult> =>
    ipcRenderer.invoke("rcs-import:end-session", args),

  onChatReceived: (callback: (event: RcsChatReceivedEvent) => void) => {
    const handler = (_event: unknown, data: RcsChatReceivedEvent) => callback(data);
    ipcRenderer.on("rcs-import:chat-received", handler);
    return () => {
      ipcRenderer.removeListener("rcs-import:chat-received", handler);
    };
  },

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

  /** BACKLOG-3658: the cache job, the local opt-in and the extension state. */
  startCacheJob: (args?: { sinceDays?: number }): Promise<RcsImportJobResult> =>
    ipcRenderer.invoke("rcs-import:start-cache-job", args),
  setCacheOptIn: (args: { optedIn: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("rcs-import:set-cache-opt-in", args),
  getExtensionState: (): Promise<RcsExtensionStateResult> => ipcRenderer.invoke("rcs-import:get-extension-state"),

  /** BACKLOG-3658 (SR S1): a cache Sync was saved and auto-linked. */
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
