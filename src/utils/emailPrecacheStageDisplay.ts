/**
 * How each email pre-cache fetch round is described to the user.
 *
 * ONE map, exhaustive over `EmailPrecacheStage`, so a round without copy is a
 * compile error rather than a round that silently falls through to the wrong
 * label. Same shape and same reasoning as `importPhaseDisplay.ts`, which does
 * this for the macOS Messages import.
 *
 * WHAT THIS REPLACES: a single "Downloading emails..." for the entire fetch
 * phase. On a mailbox with two connected providers that one sentence covered
 * four rounds and several minutes, so the panel said the same thing throughout
 * and gave the user nothing to distinguish progress from a hang.
 *
 * WHY `src/utils/` AND NOT THE SETTINGS COMPONENT: nothing else needs this copy
 * today, but the dashboard's sync indicator is the obvious second consumer and a
 * dashboard component importing from a settings component is the wrong
 * direction. This is the shared place both can reach.
 *
 * The `EmailPrecacheStage` import is TYPE-ONLY and erases at compile time — the
 * renderer never takes a runtime value from `electron/`. Same boundary ruling as
 * BACKLOG-2832 and `importPhaseDisplay.ts`.
 */

import type { EmailPrecacheStage } from "../../electron/types/ipc/emailPrecacheStage";

export interface EmailPrecacheStageDisplay {
  /**
   * The sentence stem, with NO trailing punctuation and no count.
   *
   * Surfaces splice a count into the middle ("Downloading your Outlook mailbox
   * (1,204 so far)...") so they must own the ending. A stem that carried its own
   * "..." would have to be stripped at the one place it is used, which is how a
   * regex ends up in a JSX expression.
   */
  label: string;
  /** Short form, for a pill or a status line. */
  pill: string;
}

/**
 * The wording answers "what is it doing", not "which API is it calling".
 *
 * "Other Outlook folders" for the folder walk. It reads the user's OWN folder
 * tree (`/me/mailFolders` and each folder's `childFolders`): Sent, Archive and
 * the folders they created. Not "shared folders", which in Outlook means folders
 * or mailboxes other people shared with you, and the walk reads none of those.
 * Not "all folders" either, which reads as a claim about completeness that a
 * cancelled or partial walk would not have kept.
 *
 * No trailing punctuation: the panel appends "(N so far)..." to whichever stem
 * it picked, the same way it already does for the generic "Downloading emails".
 */
export const EMAIL_PRECACHE_STAGE_DISPLAY: Record<
  EmailPrecacheStage,
  EmailPrecacheStageDisplay
> = {
  "outlook-inbox": {
    label: "Downloading your Outlook mailbox",
    pill: "Outlook mailbox",
  },
  "outlook-folders": {
    label: "Downloading your other Outlook folders",
    pill: "Outlook folders",
  },
  "gmail-messages": {
    label: "Downloading your Gmail messages",
    pill: "Gmail messages",
  },
  "gmail-labels": {
    label: "Downloading your Gmail labels",
    pill: "Gmail labels",
  },
};

/**
 * Look up a stage that arrived over IPC.
 *
 * Returns `undefined` rather than guessing, for two reasons that are both
 * ordinary rather than defensive: the field is genuinely absent on the boundary
 * events and on the backfill sweep, and an older main process can send a payload
 * this renderer has never heard of. Callers fall back to the generic
 * "Downloading emails" — an unknown round must never be given some other
 * round's label.
 */
export function emailPrecacheStageDisplayFor(
  stage: string | undefined,
): EmailPrecacheStageDisplay | undefined {
  if (!stage) return undefined;
  return Object.prototype.hasOwnProperty.call(EMAIL_PRECACHE_STAGE_DISPLAY, stage)
    ? EMAIL_PRECACHE_STAGE_DISPLAY[stage as EmailPrecacheStage]
    : undefined;
}
