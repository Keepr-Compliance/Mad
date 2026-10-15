/**
 * At-rest bridge (BACKLOG-3816 S3).
 *
 * Exposes the background migration's progress to the renderer: a status read and
 * a subscription to status pushes. Counts only.
 */
import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  AT_REST_GET_STATUS_CHANNEL,
  AT_REST_STATUS_CHANNEL,
  type AtRestMigrationStatus,
  type WindowApiAtRest,
} from "../types/ipc/window-api-at-rest";

export const atRestBridge: WindowApiAtRest = {
  getMigrationStatus: (): Promise<AtRestMigrationStatus> =>
    ipcRenderer.invoke(AT_REST_GET_STATUS_CHANNEL),

  onMigrationStatus: (callback: (status: AtRestMigrationStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: AtRestMigrationStatus) => callback(status);
    ipcRenderer.on(AT_REST_STATUS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(AT_REST_STATUS_CHANNEL, listener);
    };
  },
};
