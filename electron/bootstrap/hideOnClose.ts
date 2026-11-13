/**
 * BACKLOG-3283 (founder ruling 2026-11-12, "Hide it"): on macOS, closing the main
 * window hides it instead of destroying it, so a Dock click shows the same
 * renderer again — no boot sequence, no re-sync. A quit (`isQuitting()`) lets the
 * close through. Other platforms: nothing is attached; closing the window quits.
 */
import { isQuitting } from "./quitState";

export interface HideOnCloseWindow {
  on(event: "close", listener: (e: { preventDefault(): void }) => void): unknown;
  once(event: "leave-full-screen", listener: () => void): unknown;
  hide(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
}

export function attachHideOnClose(win: HideOnCloseWindow, platform: NodeJS.Platform): void {
  if (platform !== "darwin") return;
  win.on("close", (e) => {
    if (isQuitting()) return;
    e.preventDefault();
    // Hiding a fullscreen window leaves an empty black Space: leave fullscreen first.
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });
}
