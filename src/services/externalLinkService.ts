/**
 * External links — renderer service (BACKLOG-4181).
 *
 * The repo rule: components never call `window.api` directly. Settings panes
 * open web pages in the user's default browser through here (main validates
 * the URL in the `shell:open-external` handler).
 */

/** Keepr's published privacy policy. */
export const PRIVACY_POLICY_URL = "https://keeprcompliance.com/privacy";

/** Open `url` in the default browser. Resolves once main has handled it. */
export async function openExternalUrl(url: string): Promise<void> {
  await window.api.shell?.openExternal?.(url);
}
