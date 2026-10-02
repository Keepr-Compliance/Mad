/**
 * The guided "Sync Android" flow for Google Messages (BACKLOG-3659): which
 * step to show, from what Keepr knows. Pure, so the decisions are tested
 * apart from the screen.
 *
 *   install  → the extension has never said hello
 *   connect  → installed (or the user pressed Continue); ready to Sync (Google
 *              Messages pairing is shown as a checklist item, not a gate: the
 *              page itself says when it is not signed in)
 *   syncing  → a cache Sync of this flow is running
 *   done     → it finished
 *   failed   → it failed or was cancelled (Try again → connect)
 *
 * No consent step (founder, 2026-10-01): users accept Keepr's terms at
 * sign-up; the connect step says in one line what a Sync copies
 * (syncCopyLine). The main process keeps the consent gate behind
 * RCS_CONSENT_REQUIRED and records the consent on the first Sync.
 */

import type { RcsExtensionState, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";

export type GoogleMessagesStep = "install" | "connect" | "syncing" | "done" | "failed";

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
  return "connect";
}

/** The extension is installed (it said hello at least once). */
export function extensionInstalled(state: RcsExtensionState | null): boolean {
  return !!state?.extensionVersion;
}

/**
 * The one line under the Sync button: what a Sync copies. `lookbackMonths`
 * is the configured window (null = All time; undefined = not known yet).
 */
export function syncCopyLine(lookbackMonths: number | null | undefined): string {
  const what =
    lookbackMonths === null
      ? "all your texts"
      : typeof lookbackMonths === "number"
        ? `your texts from the last ${lookbackMonths} month${lookbackMonths === 1 ? "" : "s"}`
        : "your texts";
  return `Keepr copies ${what} to this computer, encrypted. Change this in Settings → Messages.`;
}
