/**
 * At-rest migration status IPC (BACKLOG-3816 S3).
 *
 * One read-only channel: the renderer's banner asks for the current migration
 * status when it mounts; later changes are pushed on AT_REST_STATUS_CHANNEL by the
 * migration itself. Counts only — nothing here carries a path.
 */
import { ipcMain } from "electron";

import { getAtRestMigration } from "../services/atRest/migration";
import { AT_REST_GET_STATUS_CHANNEL } from "../types/ipc/window-api-at-rest";

export function registerAtRestHandlers(): void {
  ipcMain.handle(AT_REST_GET_STATUS_CHANNEL, () => getAtRestMigration().getStatus());
}
