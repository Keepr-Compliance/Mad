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
 * Channels already warned about, mapped to how many further drops were swallowed
 * since that warning. The presence of a key IS the "already warned" flag; the
 * number is what the recovery line reports.
 *
 * WHY A THROTTLE RATHER THAN ONE LINE PER DROP
 * --------------------------------------------
 * `sync:progress` is emitted once per parsed chunk of `idevicebackup2` stdout,
 * with no dedupe and no interval — `backupService.ts`'s own comment calls that
 * output "very spammy" and keeps it out of the log for exactly that reason. Every
 * one of those is forwarded 1:1 by `deviceSyncOrchestrator` and pushed 1:1 by
 * `syncHandlers`. Close the window during a sync — macOS does not quit, so that
 * is one Dock click away from this defect's own scenario — and each becomes a
 * `log.warn`, which clears the file level (`config/logFileConfig.ts`).
 *
 * That file's `maxSize` is 8 MB and it keeps exactly ONE archive, which it
 * OVERWRITES (BACKLOG-2898). At roughly 120 B a line, ~70,000 drops rotate
 * `main.log` and destroy `main.old.log` with it: ~47/sec across a 24-minute
 * backup, ~10/sec across a two-hour first sync. The warning that exists to make
 * this diagnosable would erase the diagnosis, and the rest of the session's log
 * with it. 2898's own conclusion was that no capacity survives an unthrottled
 * per-event log and the fix has to be at the emission point. So: the first drop
 * on a channel is logged in full, the rest are counted, and the count is
 * reported when a window comes back.
 */
const suppressedDropsByChannel = new Map<string, number>();

/**
 * Report what was swallowed while there was nowhere to push, and forget it.
 *
 * Called only from {@link setMainWindow} when a live window arrives, which is the
 * only way a dropped channel can become deliverable again: a drop happens solely
 * when {@link getMainWindow} returns `null`, it keeps returning `null` until a
 * window is registered, and `setMainWindow` is the sole writer. "This channel can
 * be reached again" and "a window was just set" are therefore the same event
 * here — a second flush inside {@link sendToMainWindow} would be unreachable.
 */
function flushSuppressedDrops(): void {
  suppressedDropsByChannel.forEach((suppressed, channel) => {
    if (suppressed > 0) {
      log.warn(
        `[WindowRegistry] A main window is live again; ${suppressed} further main->renderer push(es) had been dropped on channel ${channel}`,
      );
    }
  });
  suppressedDropsByChannel.clear();
}

/**
 * Record the window `createWindow()` just built. The sole writer.
 *
 * Passing `null` clears the registry, which is what tests do between cases; the
 * app itself never needs to, because {@link getMainWindow} already treats a
 * destroyed window as absent.
 *
 * A non-null window also flushes and clears the per-channel drop state. That is
 * the moment pushes can land again, so it is where the "n further drops" line
 * belongs — and it is what stops that state leaking from one test case into the
 * next, which a bare module-level "already warned" set would do.
 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
  if (win) flushSuppressedDrops();
}

/**
 * The window that can receive right now, or `null`.
 *
 * A destroyed window reads as absent: Electron throws "Object has been
 * destroyed" on its `webContents`, and after a Dock reopen the previous window
 * is exactly that. This is the single `isDestroyed()` guard that used to be
 * copy-pasted at each of the sixty-one push sites.
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
 * **A drop is logged, never silent — but once per channel.** The first drop on a
 * channel is warned in full; the rest are counted and reported when a window
 * returns (see {@link suppressedDropsByChannel} for why the volume is the whole
 * point). The channel name only, never the payload: payloads on these channels
 * carry device names, mailbox addresses and file paths, and this line goes to a
 * log file the founder attaches to reports. The silence is precisely what cost
 * BACKLOG-3454 a 70-minute QA session — main's log read as if every event had
 * been sent.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): boolean {
  const win = getMainWindow();
  if (!win) {
    const suppressed = suppressedDropsByChannel.get(channel);
    if (suppressed === undefined) {
      suppressedDropsByChannel.set(channel, 0);
      log.warn(
        `[WindowRegistry] Dropped main->renderer push: no live main window (channel: ${channel}); further drops on this channel are counted, not logged`,
      );
    } else {
      suppressedDropsByChannel.set(channel, suppressed + 1);
    }
    return false;
  }
  win.webContents.send(channel, ...args);
  return true;
}
