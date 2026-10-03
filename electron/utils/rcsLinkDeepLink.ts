/**
 * C1 (UX redesign): keepr://link — the extension's "Open Keepr" while linking.
 * It ONLY opens Keepr's "Enter the code from your browser" screen: any local
 * app can fire keepr://, so nothing is read from the URL (parameters ignored).
 */
export function isRcsLinkDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "keepr:") return false;
    return parsed.pathname === "//link" || parsed.pathname === "/link" || parsed.host === "link";
  } catch {
    return false;
  }
}
