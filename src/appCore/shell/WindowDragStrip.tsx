/**
 * WindowDragStrip Component (BACKLOG-1790)
 *
 * The ONE global window-drag surface for the Electron app.
 *
 * The app runs with `titleBarStyle: "hiddenInset"` (electron/main.ts), so there
 * is no native title bar to grab — window dragging depends entirely on CSS
 * `-webkit-app-region: drag`. Previously each screen declared its own drag
 * region and a `@media (max-width: 639px)` rule in index.html converted them
 * ALL to no-drag, leaving zero draggable pixels at narrow widths on every
 * screen.
 *
 * This component replaces all of that with a single fixed strip that:
 * - Is rendered once at the app root (App.tsx), so it exists on EVERY screen
 *   (login, onboarding, DB-init, license-blocked, dashboard, full-screen
 *   modals) and at EVERY breakpoint.
 * - Reserves the top 36px of the window as permanently draggable — matching
 *   the macOS hiddenInset traffic-light band (~28-38px).
 * - Uses `pointer-events: none` so it never intercepts DOM clicks. Electron
 *   computes drag regions geometrically from `-webkit-app-region` styles, so
 *   dragging still works; interactive elements that must live inside the top
 *   strip (e.g. the title-bar profile button) opt out with `.no-drag-region`,
 *   which carves their rect out of the drag region.
 * - Full-screen mobile surfaces reserve this strip via a spacer in
 *   ResponsiveModal, so back buttons never sit under the drag rect or the
 *   macOS traffic lights.
 *
 * Rendered only inside Electron; browsers/mobile web have no window chrome.
 */
import React from "react";
import { isElectron } from "../../utils/platform";

/** Height of the reserved drag strip in px (Tailwind h-9 = 2.25rem = 36px). */
export const DRAG_STRIP_HEIGHT_PX = 36;

export function WindowDragStrip(): React.ReactElement | null {
  if (!isElectron()) {
    return null;
  }

  return (
    <div
      className="drag-region fixed top-0 left-0 right-0 h-9 z-[9999] pointer-events-none select-none"
      aria-hidden="true"
      data-testid="window-drag-strip"
    />
  );
}
