/**
 * BACKLOG-3833 — register an IPC handler that counts as a long user-started
 * operation: while it runs the session is not idle, and the idle clock restarts
 * when it ends (see SessionSecurityService busy registry).
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import sessionSecurityService from "../services/sessionSecurityService";

export function handleBusy<A extends unknown[], R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    sessionSecurityService.runBusy(channel, async () => handler(event, ...(args as A))),
  );
}
