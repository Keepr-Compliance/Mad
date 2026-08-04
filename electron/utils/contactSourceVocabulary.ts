/**
 * The ONE translation between the two contact-source vocabularies
 * (BACKLOG-1900, extracted here by BACKLOG-2472).
 *
 * ---------------------------------------------------------------------------
 * TWO VOCABULARIES, AND WHY
 * ---------------------------------------------------------------------------
 * `contact_source_links.source_type` is an `ExternalContactSource` — the origin
 * SYSTEM: `macos | iphone | outlook | google_contacts | android_sync`.
 * `contacts.source` is a `ContactSource` — the DISPLAY vocabulary the filter and
 * the card speak, in which the desktop address book is `contacts_app` and which
 * additionally carries origins that are not address books at all (`manual`,
 * `email`, `sms`, `messages`, `inferred`).
 *
 * They overlap on four values and disagree on exactly one — macOS — which is
 * precisely why conflating them is the mistake the v57 CHECK constraint exists
 * to catch, and why this function is not a cast.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MOVED OUT OF `contactHandlers.ts`
 * ---------------------------------------------------------------------------
 * BACKLOG-2472 needs the same translation on a SECOND path: the contacts list
 * now derives each contact's live source set from the crosswalk, and the
 * renderer's source filter speaks the display vocabulary. Copying the switch
 * would create the drift channel this repo has been bitten by before — a new
 * source added to one copy and not the other silently files every contact from
 * it under "Contacts App".
 *
 * There is a third statement of this rule in `databaseService.ts` migration v48
 * (a one-shot reclassification of already-persisted rows). It is deliberately
 * NOT this function: a migration must keep behaving the way it did the day it
 * ran, so it is frozen by design and carries a comment saying so.
 */

import type { ContactSource } from "../types/models";
import type { ExternalContactSource } from "../services/db/externalContactDbService";

/**
 * Map a shadow-table `ExternalContactSource` to the persisted `contacts.source`
 * (`ContactSource`) value, so distinct origins are preserved instead of being
 * flattened to `contacts_app`.
 *
 * - `iphone`, `android_sync`, `outlook`, `google_contacts` pass through as their
 *   own distinct persisted source (the v48 CHECK + the `validSources`
 *   allow-list accept all four).
 * - `macos` (desktop Contacts App) and any unrecognised value fall back to
 *   `contacts_app` — `macos` is not a persisted `ContactSource`, and the desktop
 *   address book intentionally stays `contacts_app`.
 */
export function toPersistedContactSource(
  externalSource: string | null | undefined,
): ContactSource {
  switch (externalSource) {
    case "iphone":
      return "iphone";
    case "android_sync":
      return "android_sync";
    case "outlook":
      return "outlook";
    case "google_contacts":
      return "google_contacts";
    // "macos" (desktop address book) and anything unknown => contacts_app
    default:
      return "contacts_app";
  }
}

/**
 * The same translation, typed for callers that already hold a validated
 * `ExternalContactSource`. Exists so those call sites do not widen to `string`
 * and lose the compiler's help when a new source is added to the union.
 */
export function externalSourceToContactSource(
  externalSource: ExternalContactSource,
): ContactSource {
  return toPersistedContactSource(externalSource);
}
