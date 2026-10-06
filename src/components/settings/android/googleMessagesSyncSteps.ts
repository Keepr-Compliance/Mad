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
 * sign-up (the storyboards show no copy line any more).
 * The main process keeps the consent gate behind
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

/** Settings → Messages → Google Messages' months control (scroll target of "Change"). */
export const GM_LOOKBACK_TARGET = "settings-gm-lookback";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The done screen's lines (founder, 2026-10-01): what Keepr SAVED, not what
 * the page sent — a chat whose messages were all older than the months
 * setting is not "saved". null while Keepr is still saving.
 */
export function doneSummaryLines(job: RcsJobInfo): string[] | null {
  if (job.saved === undefined) return null;
  if (job.saved === null) return ["Keepr could not save this Sync. Nothing was imported: try again."];
  const s = job.saved;
  // Storyboard A11 / B05: ONE line — "20 chats · 412 messages (38 new) · 64 photos".
  return [
    `${plural(s.chats, "chat", "chats")} · ${plural(s.messages, "message", "messages")} (${s.newMessages} new)` +
      (typeof s.photos === "number" && s.photos > 0 ? ` · ${plural(s.photos, "photo", "photos")}` : ""),
  ];
}
