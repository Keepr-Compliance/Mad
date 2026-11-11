/**
 * Learn pilot report copy — BACKLOG-4219 PR2.
 *
 * Every string the "Help improve Keepr" switch changes, in one place so
 * each is tested in both switch states. The consent text is SR's rewrite (SR
 * founder's final wording, 2026-11-10: standard diagnostics copy).
 */

export const PILOT_CONSENT_TEXT =
  "Share diagnostic numbers about how Learn mode performs. Turn it off any time to delete what was shared.";

export function pilotConsentText(): string {
  return PILOT_CONSENT_TEXT;
}

/** The line under the switch: an owed delete first, else the last send, else nothing. */
export function pilotStatusLine(pending: boolean, lastSentAt: string | null, machine: string): string | null {
  if (pending) return `Deleting… finishes when ${machine} is online.`;
  if (lastSentAt) {
    const d = new Date(lastSentAt);
    if (!Number.isNaN(d.getTime())) return `Last shared: ${d.toLocaleString()}`;
  }
  return null;
}

/** The score dialog's privacy line. null = the switch state could not be read: say only what is always true. */
export function scoreDialogPrivacyText(sharing: boolean | null): string {
  if (sharing === true) return "Your answers are kept on this computer. Diagnostic numbers are shared with Keepr.";
  if (sharing === false) return "Your answers are kept on this computer and are never sent anywhere.";
  return "Your answers are kept on this computer.";
}

export const PILOT_PRIVACY_SHARED = "Diagnostic numbers about Learn mode are shared with Keepr.";
export const PILOT_PRIVACY_DELETE_TOO = "What was shared with Keepr is deleted too.";
