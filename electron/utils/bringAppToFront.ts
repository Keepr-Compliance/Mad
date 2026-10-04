/**
 * Bring the desktop app to the foreground (BACKLOG-3394)
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * A mailbox connect leaves the user looking at a browser tab. Before
 * BACKLOG-3394 the page served on `http://localhost:<port>/callback` offered a
 * "Return to Application" button that navigated to `keepr://focus`, which made
 * the browser ask the user for permission to open an external application.
 *
 * That permission is the browser's own, and it is keyed to (origin, scheme).
 * The local callback server binds with `listen(0)` (googleAuthService.ts,
 * microsoftAuthService.ts), so the port — and therefore the origin — is
 * different on every single connect. Chrome's "Always allow …" checkbox
 * therefore never applies to the next connect, and the prompt returns forever.
 *
 * The app does not need the browser's help. It IS the server that received the
 * OAuth code, so it knows the connect succeeded before the page does. It can
 * pull itself in front directly, and the served page can simply say the tab is
 * finished.
 *
 * ============================================================================
 * WHY `app.focus`, AND WHY `steal`
 * ============================================================================
 *
 * On macOS `BrowserWindow.focus()` raises the window WITHIN the application but
 * does not make Keepr the active application — the browser stays in front and
 * the user sees nothing happen. Activating the application is `app.focus()`,
 * and pulling it in front of an application the user is actively using needs
 * `{ steal: true }`.
 *
 * `steal` is documented as macOS-only; it is ignored on other platforms, so the
 * call is made unconditionally rather than behind a `process.platform` branch
 * that nothing could exercise on the other side.
 *
 * On Windows the foreground lock turns a background `focus()` into a taskbar
 * flash; see {@link raiseOnWindows} (BACKLOG-3636). Callers: mailbox connect
 * (BACKLOG-3394) and the end of an RCS Sync job (BACKLOG-3636).
 *
 * ============================================================================
 * WHY IT NEVER THROWS
 * ============================================================================
 *
 * Every caller sits inside the `try` of a background OAuth completion, AFTER
 * the token has already been saved. A throw from a cosmetic focus call would be
 * caught by that handler and reported to the renderer as a FAILED connect, for
 * a mailbox that is in fact connected. The failure mode of a swallowed error
 * here is "the window did not come forward"; the failure mode of a propagated
 * one is a false failure on a successful connect.
 */

import { app, BrowserWindow } from "electron";
import logService from "../services/logService";

/**
 * Windows (BACKLOG-3636): the foreground lock lets `focus()` from a background
 * app only flash the taskbar button. Briefly making the window always-on-top
 * puts it in front; the flag is ALWAYS cleared again (finally), so a throw
 * from show/focus can never leave Keepr pinned above every other window.
 */
function raiseOnWindows(win: BrowserWindow): void {
  win.setAlwaysOnTop(true);
  try {
    win.show();
    win.focus();
  } finally {
    win.setAlwaysOnTop(false);
  }
}

/**
 * Activate the application and raise its main window.
 *
 * @param win The main window, or null when the app has no window (the focus
 *            still fires: activating the application is useful on its own).
 */
export function bringAppToFront(win: BrowserWindow | null): void {
  try {
    app.focus({ steal: true });

    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      if (process.platform === "win32") {
        raiseOnWindows(win);
      } else {
        if (!win.isVisible()) win.show();
        win.focus();
      }
    }
  } catch (error) {
    // Cosmetic only — see the header. Never rethrow.
    void logService.warn(
      "Failed to bring the app to the front",
      "BringAppToFront",
      { error: error instanceof Error ? error.message : "Unknown error" },
    );
  }
}

/**
 * SR (Option 1): Keepr raised for linking — the code window sits at the
 * screen's right edge, so Keepr must not come back MAXIMIZED over it. A
 * minimized window returns at its normal bounds (never maximized); a
 * visible window keeps the size the user gave it. Never throws.
 */
export function bringAppToFrontForLink(win: BrowserWindow | null): void {
  try {
    if (win && !win.isDestroyed() && win.isMinimized()) {
      win.restore();
      if (win.isMaximized()) win.unmaximize();
    }
  } catch (error) {
    void logService.warn("Failed to restore the app's window", "BringAppToFront", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
  bringAppToFrontOrFlash(win);
}

/** Windows whose taskbar button is flashing until they get focus. */
const flashing = new WeakSet<BrowserWindow>();

/**
 * BACKLOG-3641: the user asked from the browser ("Open Keepr"). Bring Keepr
 * forward; if Windows still refuses the foreground change (the window is not
 * focused afterwards), flash its taskbar button until it gets focus. Never
 * throws (cosmetic, as above).
 */
export function bringAppToFrontOrFlash(win: BrowserWindow | null): void {
  bringAppToFront(win);
  try {
    // One flash per window at a time: repeated clicks never pile up
    // once("focus") listeners.
    if (win && !win.isDestroyed() && !win.isFocused() && !flashing.has(win)) {
      flashing.add(win);
      win.flashFrame(true);
      win.once("focus", () => {
        flashing.delete(win);
        if (!win.isDestroyed()) win.flashFrame(false);
      });
    }
  } catch (error) {
    void logService.warn("Failed to flash the app's window", "BringAppToFront", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
