/**
 * BACKLOG-3785: patch `ipcMain.handle` so replies of ~1 MB or more are logged
 * while a sync is running (see electron/services/ipcReplySize.ts). Side-effect
 * module: imported from main.ts ABOVE every handler import, because a handler
 * registered before the patch is not measured.
 */
import { ipcMain } from "electron";
import log from "electron-log";
import { performance } from "perf_hooks";
import { currentIpcReplySizePhase, wrapHandleForReplySize } from "../services/ipcReplySize";

wrapHandleForReplySize(ipcMain as unknown as Parameters<typeof wrapHandleForReplySize>[0], {
  phase: () => currentIpcReplySizePhase(),
  // Monotonic, and the same clock as installMainLagMonitor (it compares the
  // IPC start time recorded here with its own ticks).
  now: () => performance.now(),
  log: (line) => log.info(line),
});
