/**
 * Support access disclosure (BACKLOG-2393)
 *
 * The exact wording a user is shown before granting access, plus a stable id
 * and a hash of the text.
 *
 * Why the hash matters: this wording will change. When it does, a consent
 * record that only says "the user agreed" is worthless — we would have no way
 * to answer what they actually read. Storing the id, the hash and the verbatim
 * text means a grant made today remains interpretable after the text is
 * rewritten.
 *
 * Why the wording is blunt: the logs contain contact names and phone numbers
 * today (BACKLOG-2397 is deferred by an explicit founder decision, and this
 * feature does not attempt to strip them). "Diagnostic data" would be a true
 * sentence that leaves someone with a false impression. So the disclosure says
 * what is in the file.
 */

import { createHash } from "crypto";

/**
 * Bump the version suffix whenever SUPPORT_ACCESS_DISCLOSURE_TEXT changes.
 * The hash catches an unversioned edit, but the id is what a human reads.
 */
export const SUPPORT_ACCESS_DISCLOSURE_ID = "support-access-disclosure-v2";

export const SUPPORT_ACCESS_DISCLOSURE_TEXT = [
  "While support access is on, Keepr collects extra detail about what the app is doing on this Mac and sends it to Keepr support.",
  "",
  "What gets sent:",
  "• The names, phone numbers and email addresses of your contacts, as they appear in the app.",
  "• Recent activity from this Mac — which messages and emails were imported, which were skipped, and why.",
  "• Information about this Mac: app version, macOS version, disk space, and whether the permissions Keepr needs are granted.",
  "",
  "What does not get sent: the contents of your messages and emails, your documents, and your password or login details.",
  "",
  "This includes information about people who are not Keepr users — your clients and their phone numbers.",
  "",
  "Reports are encrypted while they wait on this Mac and while they travel to Keepr.",
  "",
  "Reports are deleted 30 days after they are captured — from Keepr's servers, and from this Mac — whether or not they were ever sent.",
  "",
  "Access ends by itself on the date shown. You can end it sooner at any time, and you can see and delete every report from Settings, including ones already sent.",
].join("\n");

/** Hex sha256 of a disclosure text. */
export function hashDisclosure(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of the wording currently shipped. */
export function currentDisclosureHash(): string {
  return hashDisclosure(SUPPORT_ACCESS_DISCLOSURE_TEXT);
}

export interface DisclosureDescriptor {
  id: string;
  text: string;
  hash: string;
}

export function currentDisclosure(): DisclosureDescriptor {
  return {
    id: SUPPORT_ACCESS_DISCLOSURE_ID,
    text: SUPPORT_ACCESS_DISCLOSURE_TEXT,
    hash: currentDisclosureHash(),
  };
}

/**
 * How long the server keeps an uploaded report before purging it.
 *
 * Stated on the grant screen and counted down per item in the list, because a
 * retention period that only exists in a policy document is not something a
 * user can act on.
 */
export const SUPPORT_REPORT_RETENTION_DAYS = 30;
