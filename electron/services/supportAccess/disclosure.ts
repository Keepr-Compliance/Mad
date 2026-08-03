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
 * Why the wording is blunt: "diagnostic data" would be a true phrase that
 * leaves someone with a false impression, which is worse than a false one. So
 * the disclosure says what is actually in the file.
 *
 * ## v3 — what changed, and why it had to (BACKLOG-2428)
 *
 * v2 said the report carries "the names, phone numbers and email addresses of
 * your contacts", and warned that this "includes information about people who
 * are not Keepr users — your clients and their phone numbers". Exactly one
 * thing made that true: a "contact-trace" scope whose producer dumped up to
 * 200 raw unresolved handles. That scope was removed, so both sentences would
 * now over-state what is collected — and an over-stated disclosure is not the
 * safe direction. It trains people to discount the parts that are accurate.
 *
 * Every surviving producer writes counts, outcomes, internal row ids and
 * dates. Verified by reading each `supportTrace(...)` call site, and asserted
 * by execution in `disclosure.test.ts` rather than left to a comment.
 *
 * The under-stated direction is a failure too, so v3 keeps the one PII route
 * that genuinely remains: `collectDiagnostics()` carries the last ten
 * `failure_log` rows with their `error_message` verbatim, and nothing
 * sanitises them. An error string can mention a name if that is what the error
 * was about. That bullet is deliberate, not boilerplate.
 *
 * ## One sentence below is known NOT to hold yet — do not re-verify it as true
 *
 * "Reports are deleted 30 days after they are captured — from Keepr's servers,
 * and from this Mac — whether or not they were ever sent."
 *
 * True on the app's own retention pass and on a user-initiated Delete. **False
 * on the `pg_cron` SQL backstop**, which unlinks the attachment row and leaves
 * the storage object orphaned (BACKLOG-2417).
 *
 * It ships unchanged on purpose. The fix for 2417 is **code** — an Edge
 * Function purge that makes this sentence true without editing a character of
 * it — so no v4 is needed. Softening the wording now would ship a *weaker*
 * promise and then require reverting to this one: two extra hash bumps to
 * arrive where we already are.
 *
 * Until 2417 lands, the strongest sentence on the consent screen is the one
 * least true, which is why 2417 is launch-blocking for support access reaching
 * any non-internal user. The audit above is complete for every *other*
 * sentence; this is the exception, and it is deliberate rather than missed.
 */

import { createHash } from "crypto";

/**
 * Bump the version suffix whenever SUPPORT_ACCESS_DISCLOSURE_TEXT changes.
 * The hash catches an unversioned edit, but the id is what a human reads.
 */
export const SUPPORT_ACCESS_DISCLOSURE_ID = "support-access-disclosure-v3";

export const SUPPORT_ACCESS_DISCLOSURE_TEXT = [
  "While support access is on, Keepr collects extra detail about what the app is doing on this Mac and sends it to Keepr support.",
  "",
  "What gets sent:",
  "• Counts and outcomes from the areas you choose — how many chats and messages were found, how many were skipped and why, how many emails were fetched and linked, and how many phone numbers were matched to a name. Numbers and reasons, not names.",
  "• Information about this Mac: app version, macOS version, disk space, and whether the permissions Keepr needs are granted.",
  "• The last few error messages Keepr recorded. Those are written by the app for its own log, so one of them can mention a name or an address if that is what the error was about.",
  "",
  "What does not get sent: the contents of your messages and emails, your documents, your contact list, and your password or login details.",
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
