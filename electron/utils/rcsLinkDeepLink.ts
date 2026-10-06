/**
 * C1 (UX redesign): keepr://link — the extension's "Open Keepr" while linking.
 * It ONLY opens Keepr's "Enter the code from your browser" screen: any local
 * app can fire keepr://, so nothing is read from the URL (parameters ignored).
 */
/**
 * Live (founder): keepr://open — the extension's "Open Keepr" when
 * /focus can't be used (Keepr not running, or this browser not linked). It
 * ONLY shows and focuses the main window; parameters are ignored.
 */
export function isRcsOpenDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "keepr:") return false;
    return parsed.pathname === "//open" || parsed.pathname === "/open" || parsed.host === "open";
  } catch {
    return false;
  }
}

export function isRcsLinkDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "keepr:") return false;
    return parsed.pathname === "//link" || parsed.pathname === "/link" || parsed.host === "link";
  } catch {
    return false;
  }
}
