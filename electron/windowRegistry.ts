/**
 * The live main window, as one accessor (BACKLOG-3454).
 *
 * WHY THIS EXISTS
 * ---------------
 * On macOS `window-all-closed` deliberately does not quit (`main.ts`), so
 * closing the window with the red button leaves the process running. Clicking
 * the Dock icon fires `app.on("activate")`, which calls `createWindow()` again
 * and **reassigns** `main.ts`'s `mainWindow`. Every `register*Handlers(mainWindow!)`
 * call, however, runs once inside `app.whenReady()` and captured the FIRST
 * window. From that moment each of those handlers evaluated
 * `if (win && !win.isDestroyed())` against a destroyed object and returned —
 * silently, and below a `log.info` line that had already claimed it sent.
 *
 * Every `ipcMain.handle` kept working, because a handle is sender-agnostic. So
 * the app looked entirely alive while no push from the main process could reach
 * the renderer again for the life of the process: the phone never showed as
 * connected, sync and email progress never arrived, mailbox-connected never
 * landed. Traced in `pm_comments` `330a28f1`, confirmed from the user side in
 * `8530cb96` (restarting the app fixed it instantly on the same build, same
 * phone, same cable).
 *
 * ONE WRITER, ON PURPOSE
 * ----------------------
 * `setMainWindow` is called from exactly one place — `createWindow()` in
 * `main.ts`, immediately after the `new BrowserWindow(...)` assignment — and an
 * AST control in `windowRecreation-3454.test.ts` fails if that line leaves.
 * The alternative considered was having each `register*Handlers` re-point its
 * own ref; that is thirteen writers of one value and reproduces the original
 * trap the moment one of them is missed.
 *
 * WHY NOT `BrowserWindow.getAllWindows()`
 * ---------------------------------------
 * `electron/capabilities/windows.ts` already broadcasts to every window, and
 * that is right for its two callers. It is wrong here: this process also opens
 * auth, export and popup windows, and "the main window" is a specific one of
 * them, not the first in an arbitrary list.
 *
 * @module electron/windowRegistry
 */

import log from "electron-log";

import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

/**
 * Record the window `createWindow()` just built. The sole writer.
 *
 * Passing `null` clears the registry, which is what tests do between cases; the
 * app itself never needs to, because {@link getMainWindow} already treats a
 * destroyed window as absent.
 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * The window that can receive right now, or `null`.
 *
 * A destroyed window reads as absent: Electron throws "Object has been
 * destroyed" on its `webContents`, and after a Dock reopen the previous window
 * is exactly that. This is the single `isDestroyed()` guard that used to be
 * copy-pasted at forty-four call sites.
 */
export function getMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

/**
 * Push `args` on `channel` to the live main window. Returns whether it left.
 *
 * `args` is a rest parameter so arity is preserved exactly: `device:tools-missing`
 * is sent with no payload and must stay that way — `send(channel, undefined)`
 * delivers an argument, which is not the same thing.
 *
 * **A drop is logged, never silent.** The channel name only: payloads on these
 * channels carry device names, mailbox addresses and file paths, and this line
 * goes to a log file the founder attaches to reports. The silence is precisely
 * what cost BACKLOG-3454 a 70-minute QA session — main's log read as if every
 * event had been sent.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): boolean {
  const win = getMainWindow();
  if (!win) {
    log.warn(
      `[WindowRegistry] Dropped main->renderer push: no live main window (channel: ${channel})`,
    );
    return false;
  }
  win.webContents.send(channel, ...args);
  return true;
}
