/**
 * BACKLOG-4245: every string the "Get beta versions" switch shows.
 */

export const BETA_UPDATES_TITLE = "Get beta versions";

export const BETA_UPDATES_HELP =
  "Try new Keepr features early. Beta versions can be less stable. This applies to every computer you sign in on. Turning it off does not go back to an older version.";

export const BETA_UPDATES_ARIA_LABEL = "Get beta versions";

export const BETA_UPDATES_NOT_AVAILABLE = "Beta versions are not available for this account.";

export const BETA_UPDATES_UNREACHABLE = "Beta versions resume when Keepr can reach its server.";

export const BETA_UPDATES_SAVE_FAILED = "Could not change this setting. Try again.";

/** The line under the switch when betas are not active, or null. */
export function betaUpdatesNoteText(note: "not_available" | "unreachable" | null): string | null {
  if (note === "not_available") return BETA_UPDATES_NOT_AVAILABLE;
  if (note === "unreachable") return BETA_UPDATES_UNREACHABLE;
  return null;
}
