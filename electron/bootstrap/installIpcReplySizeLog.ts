/**
 * BACKLOG-3785: patch `ipcMain.handle` so replies of ~1 MB or more are logged
 * while a sync is running (see electron/services/ipcReplySize.ts). Side-effect
 * module: imported from main.ts ABOVE every handler import, because a handler
 * registered before the patch is not measured.
 */
import { ipcMain } from "electron";
import log from "electron-log";
import { currentIpcReplySizePhase, wrapHandleForReplySize } from "../services/ipcReplySize";

wrapHandleForReplySize(ipcMain as unknown as Parameters<typeof wrapHandleForReplySize>[0], {
  phase: () => currentIpcReplySizePhase(),
  now: () => Date.now(),
  log: (line) => log.info(line),
});
