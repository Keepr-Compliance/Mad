/**
 * How the Keepr Chrome extension is installed (founder, storyboards A02 / J01,
 * 2026-10-04).
 *
 *   - Chrome Web Store (A02): "Install the Keepr extension" → Add to Chrome.
 *   - Beta (J01): the unpacked copy in Downloads, loaded in Developer mode.
 *
 * A per-account preference, "Beta extension install"
 * (`messageImport.googleMessages.betaExtensionInstall`, default OFF), picks
 * the beta path. Until the extension is in the Chrome Web Store,
 * EXTENSION_PUBLISHED is false and EVERY account gets the beta path.
 */

/** Shared with the main process (electron/constants/extensionDistribution.ts): flip it there. */
import { EXTENSION_PUBLISHED } from "../../../../electron/constants/extensionDistribution";
export { EXTENSION_PUBLISHED };

/** Where the preference lives in the account's preferences. */
export const BETA_INSTALL_PREF_PATH = ["messageImport", "googleMessages", "betaExtensionInstall"] as const;

/** The stored preference (absent → false). */
export function readBetaInstallPreference(preferences: unknown): boolean {
  let node: unknown = preferences;
  for (const key of BETA_INSTALL_PREF_PATH) {
    if (!node || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node === true;
}

/** The partial preferences object that stores `on`. */
export function betaInstallPreferencePatch(on: boolean): Record<string, unknown> {
  return { messageImport: { googleMessages: { betaExtensionInstall: on } } };
}

/**
 * Live (founder): after a Keepr update the folder in Downloads is refreshed
 * (app start), but Chrome runs the old copy until it is reloaded. One line,
 * only for the unpacked install (a store install updates itself).
 */
export const EXTENSION_UPDATE_READY_LINE = "Extension update ready. In chrome://extensions, click ↻ on Keepr.";

export function showExtensionUpdateReady(updateReady: boolean | undefined, published: boolean = EXTENSION_PUBLISHED): boolean {
  return !published && updateReady === true;
}

/** The install path this account sees: beta when chosen, or while the store listing is not live. */
export function wantsBetaInstall(preferenceOn: boolean, published: boolean = EXTENSION_PUBLISHED): boolean {
  return !published || preferenceOn;
}
