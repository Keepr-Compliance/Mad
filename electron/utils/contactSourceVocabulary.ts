/**
 * THE COMPLETE SET OF VALUES `contact.source` CAN EVER HOLD (BACKLOG-2473)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * SR review of PR #2197 named this the single most valuable missing test in the
 * contacts filter:
 *
 *   > No test asserts that EVERY value `toPersistedContactSource` can emit is
 *   > covered by a filter leaf. A newly added source with no matching leaf would
 *   > hide those contacts from EVERY filter, with all tests green.
 *
 * That failure is silent and total. The contacts do not appear misfiled; they
 * do not appear at all, under any filter setting, and no assertion anywhere
 * fails. The only defence is to enumerate the vocabulary in ONE place and assert
 * the filter covers it — which is what
 * `src/utils/__tests__/contactFilterModel.vocabularyCoverage.test.ts` does with
 * the constants below.
 *
 * An enumeration that is hand-copied is not a defence, because the copy is what
 * goes stale. So `toPersistedContactSource` MOVED here from `contactHandlers.ts`
 * and is re-exported there: the function that emits the values and the list of
 * values it can emit now live side by side, where a change to one that skips the
 * other is visible in a single screenful.
 *
 * ===========================================================================
 * TWO KINDS OF SOURCE VALUE, AND BOTH REACH THE FILTER
 * ===========================================================================
 * PERSISTED — actually stored in the `contacts.source` column. Constrained by a
 *   CHECK (migration v48 / `electron/database/schema.sql`).
 *
 * SYNTHETIC — never stored anywhere. `contactDbService` reads message-derived
 *   pseudo-contacts straight out of the `messages` table with `'messages' as
 *   source` and `1 as is_message_derived`; there is no `contacts` row behind
 *   them at all.
 *
 * The filter cannot tell the two apart — both arrive as `contact.source` on an
 * object it must classify — so both belong in the coverage assertion. Omitting
 * the synthetic one is exactly how a whole population becomes unfilterable while
 * the CHECK-derived list looks complete.
 */

import type { ContactSource } from "../types/models";
import type { ExternalContactSource } from "../services/db/externalContactDbService";

/**
 * Every value the `contacts.source` CHECK admits, in the order the CHECK lists
 * them (migration v48, `databaseService.ts`; mirrored in `schema.sql`).
 *
 * KEEP IN STEP WITH THE CHECK. If they disagree, the disagreement is a bug in
 * one of them: a value in the CHECK but not here is unfilterable, and a value
 * here but not in the CHECK is a write that throws.
 */
export const PERSISTED_CONTACT_SOURCES = [
  "manual",
  "email",
  "sms",
  "contacts_app",
  "inferred",
  "android_sync",
  "iphone",
  "outlook",
  "google_contacts",
] as const;

/**
 * Source values produced at SELECT time that are never written to any column.
 *
 * `messages` is the only one: `contactDbService` synthesises it for contacts
 * derived from text threads. Deliberately absent from the `contacts.source`
 * CHECK — see the note beside that CHECK in `schema.sql` — which is precisely
 * why a vocabulary list built only from the CHECK would miss it.
 */
export const SYNTHETIC_CONTACT_SOURCES = ["messages"] as const;

/**
 * Everything the filter can be handed. The union the coverage test asserts over.
 */
export const ALL_CONTACT_SOURCE_VALUES: readonly string[] = [
  ...PERSISTED_CONTACT_SOURCES,
  ...SYNTHETIC_CONTACT_SOURCES,
];

/**
 * Source values that only ever appear on a MESSAGE-DERIVED contact — i.e. one
 * whose `is_message_derived` is truthy.
 *
 * The Inferred filter leaves require that flag, so these values are reachable
 * ONLY in combination with it. Stated explicitly rather than left implicit
 * because it is the one asymmetry in the coverage rule, and a reader who does
 * not know about it will read the coverage test as proving something stronger
 * than it does.
 */
export const MESSAGE_DERIVED_ONLY_SOURCES: readonly string[] = [
  "email",
  "sms",
  "messages",
  "inferred",
];

/**
 * BACKLOG-1900 (P0.2): Map a shadow-table `ExternalContactSource` to the
 * persisted `contacts.source` (`ContactSource`) value so distinct origins are
 * preserved at import time instead of being flattened to `contacts_app`.
 *
 * - `iphone`, `android_sync`, `outlook`, `google_contacts` pass through as
 *   their own distinct persisted source (the v48 CHECK + `validSources`
 *   allow-list accept all four).
 * - `macos` (desktop Contacts App) and any unrecognised value fall back to
 *   `contacts_app` — `macos` is not a persisted `ContactSource`, and the
 *   desktop address book intentionally stays `contacts_app`.
 *
 * The result flows unchanged through the renderer import call into
 * `contacts:create` / `contacts:import`, which persist it verbatim.
 *
 * MOVED HERE FROM `contactHandlers.ts` (BACKLOG-2473) so that the emitter and
 * the enumeration of what it can emit cannot drift. `contactHandlers` re-exports
 * it.
 *
 * ===========================================================================
 * THE FOUR ORIGIN-ONLY CASES, AND THE BUG THEY PREVENT (SR review of #2198)
 * ===========================================================================
 * This function is no longer fed only `ExternalContactSource` values. PR #2197
 * (BACKLOG-2472) makes the source filter read the crosswalk, and its
 * `getLiveSourcesByContact` maps RAW `contact_source_links.source_type` through
 * here. v61 widened that column with `manual`/`email`/`sms`/`inferred`, so
 * without explicit cases all four fall into `default:` and come back out as
 * `contacts_app`.
 *
 * Executed by SR with both branches merged:
 *
 *     {"beforeMatchesManualLeaf": true,
 *      "afterSourceTypes": ["contacts_app"], "afterMatchesManualLeaf": false}
 *
 * In plain terms: Daniel types "Madison Reeves" into Add Contact. Today she sits
 * under the Manual filter leaf. With both PRs and no identity cases she is filed
 * under Contacts App — an address book she has never been in — and deselecting
 * Contacts App to see only the contacts he typed himself shows nothing.
 *
 * The four cases are BEHAVIOUR-PRESERVING on the import path that existed
 * before: none of them is an `ExternalContactSource`, so no caller mapping a
 * shadow-table source can reach them.
 *
 * `macos` still folds to `contacts_app` deliberately — that IS the desktop
 * address book's persisted spelling, and it is the one value where the crosswalk
 * vocabulary and `contacts.source` legitimately differ.
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
    // The four ORIGIN-ONLY crosswalk source types (BACKLOG-2473). Identity
    // cases: an origin row already carries a persisted `contacts.source` value,
    // so mapping is the identity rather than a fold to the default.
    case "manual":
      return "manual";
    case "email":
      return "email";
    case "sms":
      return "sms";
    case "inferred":
      return "inferred";
    // "macos" (desktop address book) and anything unknown => contacts_app
    default:
      return "contacts_app";
  }
}

/**
 * Every value `contact_source_links.source_type` can hold after v61.
 *
 * The five record-backed spellings plus the four origin-only ones. This is the
 * input domain PR #2197's `getLiveSourcesByContact` feeds through
 * `toPersistedContactSource`, and `contactFilterModel.vocabularyCoverage.test.ts`
 * drives every value in it end to end onto a named leaf — the assertion that
 * would have caught the Manual-filter regression above.
 */
export const ALL_CROSSWALK_SOURCE_TYPES: readonly string[] = [
  "macos",
  "iphone",
  "outlook",
  "google_contacts",
  "android_sync",
  "manual",
  "email",
  "sms",
  "inferred",
];

/**
 * Exactly the values `toPersistedContactSource` can return.
 *
 * Not derived by calling the function over a guessed input set — that would
 * prove only that the guesses map somewhere. The coverage test walks the real
 * switch by feeding it every external source AND unknown input, and asserts the
 * result set equals this constant, so a new `case` that returns a new value
 * fails here before it can silently become unfilterable.
 */
export const TO_PERSISTED_CONTACT_SOURCE_RANGE: readonly string[] = [
  // BACKLOG-2473 added the four identity cases below; the range grew with them.
  "manual",
  "email",
  "sms",
  "inferred",
  "contacts_app",
  "iphone",
  "outlook",
  "google_contacts",
  "android_sync",
];

/**
 * The same translation as `toPersistedContactSource`, typed for callers that
 * already hold a validated `ExternalContactSource` (BACKLOG-2472).
 *
 * Exists so those call sites do not widen to `string` and lose the compiler's
 * help when a new source is added to the union — the widened signature above is
 * required because `getLiveSourcesByContact` maps RAW `source_type` text off a
 * database row, which TypeScript cannot narrow.
 *
 * The `import type` is erased at compile time, so naming a `services/db` type
 * here adds no runtime edge from this module — which matters, because the
 * renderer-side coverage test imports this file.
 */
export function externalSourceToContactSource(
  externalSource: ExternalContactSource,
): ContactSource {
  return toPersistedContactSource(externalSource);
}
