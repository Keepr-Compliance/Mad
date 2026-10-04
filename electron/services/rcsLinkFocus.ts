/**
 * Founder "Option 1" (2026-10-04): linking in 4 actions. When the extension
 * shows a link code it calls /focus (unsigned, rate-limited — unchanged);
 * Keepr comes to the front and, ONLY while a link session is waiting, opens
 * (or keeps) the Sync Android modal at its link step — the same screen
 * keepr://link opens, where the code field takes focus.
 *
 * Security: this can only focus Keepr and open that screen. It never reads,
 * accepts or answers a code; the code is typed by the user in Keepr.
 */

/** The renderer channel keepr://link uses (useOpenLinkScreen). */
export const RCS_OPEN_LINK_SCREEN_CHANNEL = "rcs-import:open-link-screen";

export interface RcsFocusDeps {
  /** Brings Keepr's window to the front (or flashes it). */
  focus: () => void;
  /**
   * For linking: raises Keepr WITHOUT maximizing it (a minimized window
   * comes back at normal bounds), so the code window beside it stays visible.
   */
  focusForLink: () => void;
  /** Keepr's link session state right now. */
  linkState: () => { state: string };
  /** Tells the renderer to open the Sync Android modal at the link step. */
  openLinkScreen: () => void;
}

/** POST /focus: focus Keepr; while a link code is waiting, the link screen too. */
export function focusForBrowser(deps: RcsFocusDeps): void {
  let waiting = false;
  try {
    waiting = deps.linkState().state === "waiting";
  } catch {
    waiting = false;
  }
  if (!waiting) {
    deps.focus();
    return;
  }
  deps.focusForLink();
  deps.openLinkScreen();
}
