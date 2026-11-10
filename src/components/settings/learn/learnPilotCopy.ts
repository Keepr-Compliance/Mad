/**
 * Learn pilot report copy — BACKLOG-4219 PR2.
 *
 * Every string the "Share my score with Keepr" switch changes, in one place so
 * each is tested in both switch states. The consent text is SR's rewrite (SR
 * plan review, sentence 3 per the SR delta review D5) and is FOR FOUNDER
 * APPROVAL before release.
 */

export const PILOT_CONSENT_TEXT =
  "Keepr receives your Learn mode score and counts of the mail its filters would hide, plus your app version " +
  "and whether each mailbox is Gmail or Outlook. Nothing from your mail is sent: no addresses, names, subjects, " +
  "content or sender domains. The Keepr team sees these numbers for each of your last 5 filter versions, with " +
  "your account and your organization. Turning this off deletes them from Keepr.";

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
  if (sharing === true) return "Your answers are kept on this computer. Only the numbers are shared with Keepr.";
  if (sharing === false) return "Your answers are kept on this computer and are never sent anywhere.";
  return "Your answers are kept on this computer.";
}

export const PILOT_PRIVACY_SHARED = "Your score is also shared with Keepr.";
export const PILOT_PRIVACY_DELETE_TOO = "The numbers shared with Keepr are deleted too.";
