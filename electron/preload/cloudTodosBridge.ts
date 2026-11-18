/**
 * Keepr Cloud todo screens bridge — BACKLOG-4263 PR-6. `window.api.cloudTodos`.
 * Every method is one `ipcRenderer.invoke` of one channel; main decides everything.
 */
import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { WindowApiCloudTodos } from "../types/ipc/window-api-cloud-todos";

export const CLOUD_TODOS_CHANGED_CHANNEL = "cloud-todos:changed";

export const cloudTodosBridge: WindowApiCloudTodos = {
  getForDeal: (args) => ipcRenderer.invoke("cloud-todos:get-for-deal", args),
  dismissNotice: (args) => ipcRenderer.invoke("cloud-todos:dismiss-notice", args),
  history: (args) => ipcRenderer.invoke("cloud-todos:history", args),
  listRemoved: (args) => ipcRenderer.invoke("cloud-todos:list-removed", args),
  restore: (args) => ipcRenderer.invoke("cloud-todos:restore", args),
  onChanged: (callback) => {
    const listener = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(CLOUD_TODOS_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CLOUD_TODOS_CHANGED_CHANNEL, listener);
    };
  },
};
