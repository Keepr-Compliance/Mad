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

/**
 * Founder (2026-10-06): "Copy code and open Keepr" copies the code, then
 * fires keepr://link — Keepr fills the box with it. The clipboard is read
 * ONCE, here only, and only:
 *  - on Windows (macOS may show a "paste from other apps" prompt for a
 *    programmatic read — Mac and Linux keep the user's paste);
 *  - while Keepr's own link session is waiting (the code's 2-minute life: a
 *    stale clipboard never burns one of the tries);
 *  - when it is exactly the code: 6 digits, or 3 + 3 with one space (as the
 *    extension shows it). Anything else is ignored.
 * The value is never logged or stored; the caller passes it to the renderer
 * once. Returns the 6 digits or null.
 */
/** The ONE platform rule for the link code from the clipboard (fill and clear; the link screen's copy). */
export function linkCodeAutoFillOn(platform: string): boolean {
  return platform === "win32";
}

export function linkCodeFromClipboard(deps: {
  platform: string;
  linkState: () => { state: string };
  readClipboard: () => string;
}): string | null {
  if (!linkCodeAutoFillOn(deps.platform)) return null;
  let waiting = false;
  try {
    waiting = deps.linkState().state === "waiting";
  } catch {
    waiting = false;
  }
  if (!waiting) return null;
  let text = "";
  try {
    text = String(deps.readClipboard() ?? "");
  } catch {
    return null;
  }
  return clipboardLinkCode(text);
}

/** The 6 digits when the text is exactly the code (6 digits, or 3 + 3 with one space); else null. */
function clipboardLinkCode(text: string): string | null {
  const m = /^\s*(\d{3}) ?(\d{3})\s*$/.exec(text);
  return m ? m[1] + m[2] : null;
}

/**
 * Founder (2026-10-06): once the code is accepted, Keepr clears the
 * clipboard — Windows only, and ONLY if it still holds that same code (the
 * user may have copied something else since: then it is left as it is).
 * One fresh read; the value is never logged. Returns whether it cleared.
 */
export function clearLinkCodeFromClipboard(deps: {
  platform: string;
  code: string;
  readClipboard: () => string;
  clearClipboard: () => void;
}): boolean {
  if (!linkCodeAutoFillOn(deps.platform)) return false;
  const accepted = /^\d{6}$/.test(deps.code) ? deps.code : clipboardLinkCode(deps.code);
  if (!accepted) return false;
  try {
    if (clipboardLinkCode(String(deps.readClipboard() ?? "")) !== accepted) return false;
    deps.clearClipboard();
    return true;
  } catch {
    return false;
  }
}

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
