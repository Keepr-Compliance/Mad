/**
 * The Electron shell's {@link Windows}: `BrowserWindow.getAllWindows()`
 * (BACKLOG-2962, seam 4).
 *
 * THE LOOP IS TRANSCRIBED, NOT REWRITTEN
 * --------------------------------------
 * The body below is the five lines that stood at
 * `initializationBroadcaster.ts:167-172` and `reviewStateService.ts:577-581`,
 * character for character in structure: enumerate every window, skip one that
 * `isDestroyed()` or has no `webContents`, then `send(channel, payload)`. Both
 * sites ran exactly this, which is why one method replaces both.
 *
 * The two guards are not decoration and both are kept:
 *   - `isDestroyed()` — Electron throws "Object has been destroyed" on a closed
 *     window's `webContents`.
 *   - `webContents` truthiness — a window torn down between the enumeration and
 *     the send has none, and reading `.send` off `undefined` is a TypeError.
 *
 * NO `try`/`catch` HERE, DELIBERATELY. Both callers already have one and they
 * differ (one logs at debug, one swallows); catching here would make both
 * unreachable and silently change the logging one. A throwing `send` therefore
 * aborts the remaining windows and reaches the caller's own handler, exactly as
 * it did before this seam existed.
 *
 * `getAllWindows` is called per broadcast, never cached: the set of open windows
 * is the thing that changes, and a cached list would send to a window that has
 * since closed while missing one that has since opened.
 *
 * @module electron/capabilities/electron/electronWindows
 */

import { BrowserWindow } from "electron";

import type { Windows } from "../windows";

/** {@link Windows} backed by Electron's `BrowserWindow.getAllWindows()`. */
export class ElectronWindows implements Windows {
  broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, payload);
      }
    }
  }
}
