/**
 * Keepr Cloud bridge — BACKLOG-4243. `window.api.cloudSync`.
 * Every method is one `ipcRenderer.invoke` of one channel; main decides everything.
 */
import { ipcRenderer } from "electron";

import type { WindowApiCloudSync } from "../types/ipc/window-api-cloud-sync";

export const cloudSyncBridge: WindowApiCloudSync = {
  getView: () => ipcRenderer.invoke("cloud-sync:get-view"),
  turnOn: (args: { noticeVersion: number }) => ipcRenderer.invoke("cloud-sync:turn-on", args),
  confirmComputer: () => ipcRenderer.invoke("cloud-sync:confirm-computer"),
  turnOff: () => ipcRenderer.invoke("cloud-sync:turn-off"),
  forgetOtherProject: () => ipcRenderer.invoke("cloud-sync:forget-other-project"),
  retry: () => ipcRenderer.invoke("cloud-sync:retry"),
  openAiApps: () => ipcRenderer.invoke("cloud-sync:open-ai-apps"),
};
