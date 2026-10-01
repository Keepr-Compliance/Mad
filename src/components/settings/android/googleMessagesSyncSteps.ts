/**
 * The guided "Sync Android" flow for Google Messages (BACKLOG-3659): which
 * step to show, from what Keepr knows. Pure, so the decisions are tested
 * apart from the screen.
 *
 *   install  → the extension has never said hello
 *   consent  → (P3b) the user has not accepted the current consent text:
 *              Keepr's record is the only gate for a cache Sync
 *   connect  → installed and consented; ready to Sync (Google Messages pairing is shown
 *              as a checklist item, not a gate: the page itself says when it
 *              is not signed in)
 *   syncing  → a cache Sync of this flow is running
 *   done     → it finished
 *   failed   → it failed or was cancelled (Try again → connect)
 */

import type { RcsExtensionState, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";

export type GoogleMessagesStep = "install" | "consent" | "connect" | "syncing" | "done" | "failed";

/** P3b: the user accepted the consent text Keepr requires now. */
export function consentCurrent(state: RcsExtensionState | null): boolean {
  if (!state) return false;
  const required = state.consentRequired ?? 1;
  return typeof state.consentVersion === "number" && state.consentVersion >= required;
}

export function googleMessagesStep(input: {
  state: RcsExtensionState | null;
  /** The cache job this flow started, as last reported. */
  job: RcsJobInfo | null;
  /** The user pressed Continue on the install step. */
  continued: boolean;
}): GoogleMessagesStep {
  if (input.job) {
    if (input.job.state === "finished") return "done";
    if (input.job.state === "failed" || input.job.state === "cancelled") return "failed";
    return "syncing";
  }
  const installed = !!input.state?.extensionVersion;
  if (!installed && !input.continued) return "install";
  if (!consentCurrent(input.state)) return "consent";
  return "connect";
}

/** The extension is installed (it said hello at least once). */
export function extensionInstalled(state: RcsExtensionState | null): boolean {
  return !!state?.extensionVersion;
}
