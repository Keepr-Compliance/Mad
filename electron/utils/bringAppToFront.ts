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
      if (!win.isVisible()) win.show();
      win.focus();
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
