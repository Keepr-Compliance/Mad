/**
 * Live (0.3.76): how the browser link is shown — ONE rule for the Sync Android
 * modal and Settings › Google Messages.
 *
 * Keepr keeps a link's proof (a signed call) in memory, so right after it
 * starts a SAVED link is unproven until the extension's next signed call. A
 * saved pairing that no extension disowned ("no link here") is shown as
 * "checking" for a short window, then as linked. Not linked: nothing saved, or
 * an extension said "no link here".
 */

import { useEffect, useState } from "react";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

/** A saved link not yet proven since Keepr started — "checking" this long at most. */
export const LINK_CHECK_MS = 5000;
export const CHECKING_BROWSER = "Checking the browser…";

export type BrowserLinkView = "linked" | "checking" | "notLinked";

/** The link as shown, given the state and whether the check window is over. */
export function browserLinkView(state: Pick<RcsExtensionState, "extensionPaired" | "pairingSaved" | "linkNotHere"> | null, checkOver: boolean): BrowserLinkView {
  if (state?.extensionPaired === true) return "linked";
  const saved = state?.pairingSaved === true && state?.linkNotHere !== true;
  if (!saved) return "notLinked";
  return checkOver ? "linked" : "checking";
}

/** True once `ms` has passed since the component mounted (the check window). */
export function useLinkCheckOver(ms: number = LINK_CHECK_MS): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOver(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return over;
}
