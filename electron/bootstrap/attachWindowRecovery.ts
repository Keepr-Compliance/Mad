/**
 * Renderer crash / unresponsive recovery, attached to ONE window (BACKLOG-3456).
 *
 * Called from `createWindow()` in `main.ts`, so every window gets it — including
 * the one macOS `app.on("activate")` builds after the user closed the last
 * window. Before this, the same wiring sat in `app.whenReady()` and bound to the
 * first window only; a Dock-reopened window had no crash dialog and no freeze
 * tracking.
 *
 * Everything acts on `win`, the window the event came from — never a module
 * variable that a later `createWindow()` reassigns.
 *
 * @module electron/bootstrap/attachWindowRecovery
 */

import type {
  ResponsivenessActions,
  ResponsivenessWindow,
  WindowResponsivenessTracker,
} from "../services/windowResponsivenessTracker";

export interface RenderProcessGoneDetails {
  reason: string;
  exitCode: number;
}

export interface RecoverableWindow extends ResponsivenessWindow {
  isDestroyed(): boolean;
  webContents: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, details: RenderProcessGoneDetails) => void,
    ): unknown;
    reload(): void;
  };
}

export interface WindowRecoveryDeps {
  isPackaged: () => boolean;
  /** Native dialog; resolves the clicked button index. */
  showCrashDialog: (reason: string) => Promise<number>;
  /** Native dialog; 0 Wait, 1 Reload, 2 Quit. */
  promptUnresponsive: ResponsivenessActions["promptUser"];
  reportCrash: (details: RenderProcessGoneDetails) => void;
  logError: (line: string, details: RenderProcessGoneDetails) => void;
  warn: (line: string) => void;
  /** A fresh tracker per window: a freeze belongs to the window that froze. */
  createTracker: () => WindowResponsivenessTracker;
  attachTracking: (
    win: ResponsivenessWindow,
    tracker: WindowResponsivenessTracker,
    actions: ResponsivenessActions,
  ) => void;
  noteUserReload: () => void;
  quit: () => void;
}

export function attachWindowRecovery(win: RecoverableWindow, deps: WindowRecoveryDeps): void {
  win.webContents.on("render-process-gone", (_event, details) => {
    void (async () => {
      deps.logError("[Main] Renderer process gone:", details);
      // DevTools reload in dev raises 'killed'; no dialog for that.
      if (!deps.isPackaged() && details.reason === "killed") return;
      deps.reportCrash(details);
      const response = await deps.showCrashDialog(details.reason);
      if (response === 0) {
        if (!win.isDestroyed()) win.webContents.reload();
      } else {
        deps.quit();
      }
    })();
  });

  deps.attachTracking(win, deps.createTracker(), {
    warn: deps.warn,
    promptUser: deps.promptUnresponsive,
    reload: () => {
      deps.noteUserReload();
      if (!win.isDestroyed()) win.webContents.reload();
    },
    quit: deps.quit,
  });
}
