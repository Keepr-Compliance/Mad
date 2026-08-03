/**
 * Where did THIS email address or phone number come from? (BACKLOG-2427)
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `contacts.source` says where the CONTACT came from, in a display-facing
 * vocabulary of ten values. `contact_emails.source` / `contact_phones.source`
 * say where a single VALUE came from, in a vocabulary of three. Nothing
 * translated between them, so every value-level insert in the codebase simply
 * hard-coded `'import'` — including the two on the manual Add Contact path.
 *
 * That made the column a liar precisely where it mattered. BACKLOG-2427 gives
 * the unlink permission to DELETE a value whose source says `'import'`, on the
 * grounds that the user did not type it. A hand-typed address stamped
 * `'import'` therefore got deleted the moment the user rejected an address-book
 * record that happened to share the contact's phone number — someone else's
 * card listing the same office line was enough.
 *
 * One translation, stated once, used by every value-level insert.
 *
 * ===========================================================================
 * THE MAPPING, AND WHY THE DEFAULT IS `'import'`
 * ===========================================================================
 *   'manual'   -> 'manual'    a human typed it into the form
 *   'inferred' -> 'inferred'  derived from message traffic, not asserted
 *   everything else           -> 'import'
 *
 * The eight remaining `ContactSource` values ('contacts_app', 'outlook',
 * 'google_contacts', 'iphone', 'android_sync', 'email', 'sms', 'messages') all
 * name an EXTERNAL system the value was read out of. That is what `'import'`
 * means, and such values must stay removable — otherwise the BACKLOG-2427
 * removal degenerates into "never remove anything" and the rejected person's
 * address stays in the audit, which is the bug it exists to fix.
 *
 * The asymmetry to keep in mind when editing this: misclassifying an imported
 * value as typed costs a stale row the user can delete. The reverse deletes a
 * client's phone number.
 */

import type { ContactInfoSource, ContactSource } from "../types/models";

export function contactInfoSourceFor(
  contactSource: ContactSource | string | null | undefined,
): ContactInfoSource {
  if (contactSource === "manual") return "manual";
  if (contactSource === "inferred") return "inferred";
  return "import";
}
