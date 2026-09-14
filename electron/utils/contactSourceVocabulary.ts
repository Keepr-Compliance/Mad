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
 * derived from text threads (`contactDbService.ts:273` and `:2594`).
 *
 * It is ABSENT FROM THE `contacts.source` CHECK, and that absence is correct
 * rather than an oversight — which is precisely why a vocabulary list built only
 * from the CHECK would miss it. `schema.sql:398` is a BARE CHECK carrying no
 * note; the statement lives here, beside the enumeration. (An earlier version of
 * this comment pointed the reader at a note in `schema.sql` that has never
 * existed — corrected by BACKLOG-2481.)
 *
 * A synthetic value arriving at a WRITE is not a value to store. See
 * `toStorableContactSource` below, which is the one place the two vocabularies
 * meet.
 */
export const SYNTHETIC_CONTACT_SOURCES = ["messages"] as const;

/** Exactly the values the `contacts.source` CHECK admits. */
export type PersistedContactSource = (typeof PERSISTED_CONTACT_SOURCES)[number];

/** Exactly the values produced at SELECT time and never stored. */
export type SyntheticContactSource = (typeof SYNTHETIC_CONTACT_SOURCES)[number];

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
 * VALUES THE `contacts.source` CHECK ADMITS BUT NO DOOR MAY STORE (BACKLOG-3193)
 *
 * The persisted values the source filter can place ONLY when the contact is
 * message-derived. A SAVED contact never is: the one projection behind
 * `contacts:get-all` hard-codes `0 as is_message_derived`
 * (`services/db/contactProjectionSql.ts`). So a saved contact carrying one of
 * these matches NO filter leaf — hidden under the default selection, hidden with
 * every box ticked, and not found by searching its own name — while
 * `contactSourceLabel` names it after a leaf that cannot find it.
 *
 * No door stores them today, but both doors used to accept all
 * three from a caller and store them verbatim. The first caller likely to send
 * one is an unsaved email-derived record spelled `email` or `inferred`: that
 * spelling lands on Inferred > From Email with no filter change, and pressing
 * Import on it would have saved a contact nobody could find.
 *
 * DERIVED, NOT LISTED. `contactFilterModel.vocabularyCoverage.test.ts` pins
 * `MESSAGE_DERIVED_ONLY_SOURCES` against what the filter predicate actually
 * does. If a leaf that finds a saved `sms` contact is ever added, that test
 * forces the list to change, and this constant — and therefore the write
 * boundary below — follows without a second list to keep in step.
 *
 * `messages` is absent because it is not persisted: it has its own destination
 * in `SYNTHETIC_SOURCE_DESTINATION`.
 */
export const UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES: readonly PersistedContactSource[] =
  PERSISTED_CONTACT_SOURCES.filter((value) => MESSAGE_DERIVED_ONLY_SOURCES.includes(value));

/**
 * WHERE A SYNTHETIC SOURCE IS STORED WHEN ITS ROW IS SAVED (BACKLOG-2481)
 *
 * ===========================================================================
 * WHY THIS IS AN EXPLICIT MAP AND NOT A FALLBACK
 * ===========================================================================
 * `messages` cannot be stored — the CHECK refuses it, and the whole write fails
 * with it. So pressing Import on a person from a text thread created NO CONTACT
 * AT ALL. The fix has to send that value somewhere, and WHERE is a decision with
 * a wrong answer that looks right.
 *
 * The obvious spelling — let the value fall through to whatever fallback the
 * calling door already uses — was measured and REJECTED. The live door
 * (`contacts:import`) falls back to `contacts_app`, so a text-derived person
 * would have been filed as a macOS address-book card they have never been in,
 * and `('macos','origin')` written into the crosswalk as if that were known.
 *
 * `sms` — the value the item was originally briefed to use — was measured and
 * REJECTED for a worse reason. Every SAVED contact reaches the source filter with
 * `is_message_derived = 0`, hard-coded in the projection
 * (`services/db/contactProjectionSql.ts:117`), and the Inferred>From Texts leaf
 * requires that flag. So a stored `sms` contact matches NO leaf: invisible under
 * the default filter, invisible with every box ticked, and not found by searching
 * its own name — while `contactSourceLabel('sms')` cheerfully labels it
 * "From Texts", a leaf that cannot find it. Today the import fails loudly; that
 * spelling would have made it fail silently, which is worse.
 *
 * `manual` is what is left, and it is a TRUE statement about the action: the user
 * pressed Import on one specific row. It round-trips — stored `manual` writes
 * `('manual','origin')` to `contact_source_links`, `toPersistedContactSource`
 * maps that back to `manual`, the Manual leaf matches it, and that leaf is in
 * `DEFAULT_SOURCE_SELECTION`, so the contact is on screen where the user expects
 * it. The provenance is un-indexed, not destroyed: the participant string is
 * still in the `messages` table, so a future item can add a leaf of its own and
 * backfill membership.
 *
 * KEYED BY THE SYNTHETIC UNION, so adding a second synthetic source without
 * deciding where it is stored does not compile. That is the whole reason this is
 * a typed record and not an `if`.
 */
export const SYNTHETIC_SOURCE_DESTINATION: Readonly<
  Record<SyntheticContactSource, PersistedContactSource>
> = Object.freeze({
  messages: "manual",
});

/**
 * THE ONE WRITE BOUNDARY FOR `contacts.source` (BACKLOG-2481)
 *
 * Returns the value to STORE, or `null` when the input is one this vocabulary
 * cannot place.
 *
 * `null` has TWO causes, and each door answers both the same way:
 *
 *   1. an unrecognised string (below);
 *   2. a value the CHECK admits but no filter leaf can find on a SAVED contact
 *      — `UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES`, i.e. `email`, `sms`,
 *      `inferred` (BACKLOG-3193). Storing one creates a contact that is
 *      invisible under every filter setting, so it is refused rather than
 *      stored. `contacts:import` refuses the whole batch; `contacts:create`
 *      folds it to `manual`, its rule for any value it cannot store.
 *
 * Refused rather than mapped to `manual` on purpose: a caller that spelled out a
 * provenance should learn at once that it cannot be stored, instead of having
 * its record silently re-labelled. A synthetic value that wants a destination
 * gets one in `SYNTHETIC_SOURCE_DESTINATION`, where the typed record will not
 * compile without it.
 *
 * ===========================================================================
 * WHY `null` RATHER THAN A FALLBACK FOR AN UNRECOGNISED STRING
 * ===========================================================================
 * The two doors do not agree today, and they should not be quietly made to.
 * Measured on the real driver at `25577b648`, one record per call:
 *
 *     contacts:create  source "not_a_source"  -> accepted, stored "manual"
 *     contacts:import  source "not_a_source"  -> REFUSED, zero rows
 *
 * A single `fallback` parameter covering the unrecognised case would have made
 * `contacts:import` ACCEPT any string and store `contacts_app` — the same false
 * provenance claim rejected above, generalised to every unknown value, arriving
 * as a side effect of a refactor. So the two cases are separated: `fallback` is
 * for an ABSENT source, `null` means NOT STORABLE, and each door keeps the answer
 * it already gives.
 *
 * ===========================================================================
 * THE COMPARISON IS EXACT. NO TRIMMING, NO CASE FOLDING — ON PURPOSE.
 * ===========================================================================
 * The first draft of this function normalised its input with
 * `.trim().toLowerCase()`. It looked like tidiness and it was a widening of the
 * import door, which is the one thing the paragraph above exists to prevent.
 * Caught in SR review; measured on the real driver, parent `25577b648` against
 * that draft, one record per call:
 *
 *     "SMS"          import   REFUSED, 0 rows   ->  accepted, stored "sms"
 *     "Contacts_App" import   REFUSED, 0 rows   ->  accepted, stored "contacts_app"
 *     " manual "     import   REFUSED, 0 rows   ->  accepted, stored "manual"
 *     "SMS"          create   stored "manual"   ->  stored "sms"
 *
 * Six of ten probe rows changed answer, and no test in the suite could see it —
 * deleting the normalisation left all 32 green. The `"SMS"` row is the one that
 * matters: a stored `sms` contact matches NO filter leaf (see
 * `SYNTHETIC_SOURCE_DESTINATION` above), so the normalisation turned a loud
 * refusal into exactly the silent failure the destination decision rejects.
 *
 * Latent rather than live — every contact-source producer in the tree emits
 * canonical lower-case, swept across `src/` and `electron/`. Removed anyway: a
 * promise the code does not keep is a defect waiting for its first caller, and
 * `contacts:import` is a door that should refuse what it does not recognise.
 * `contact-handlers.messagesSource-2481.test.ts` pins the six rows above so the
 * normalisation cannot come back unnoticed.
 *
 * Since BACKLOG-3193 the `"SMS"` rows no longer tell the two spellings apart —
 * `sms` is refused too, so both give the same answer on both doors. The
 * `"Contacts_App"` and `" manual "` rows still do, and they are what now holds
 * the exact comparison in place.
 *
 * @param inbound  the caller-supplied `source`, unvalidated and NOT normalised.
 *   Compared exactly, so `"SMS"` is not `sms` and `" manual "` is not `manual`;
 *   both are unrecognised, and each door answers that as it always has.
 * @param fallbackWhenAbsent  what to store when there is no source at all —
 *   `manual` for `contacts:create`, `contacts_app` for `contacts:import`. These
 *   deliberately differ; merging them would be a behaviour change.
 */
export function toStorableContactSource(
  inbound: string | null | undefined,
  fallbackWhenAbsent: PersistedContactSource,
): PersistedContactSource | null {
  const value = typeof inbound === "string" ? inbound : "";
  if (value.length === 0) return fallbackWhenAbsent;

  // BACKLOG-3193: admitted by the CHECK, invisible once saved. Before the
  // persisted check, or `includes` below would store it verbatim.
  const unfilterable = UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES as readonly string[];
  if (unfilterable.includes(value)) return null;

  const persisted = PERSISTED_CONTACT_SOURCES as readonly string[];
  if (persisted.includes(value)) return value as PersistedContactSource;

  const synthetic = SYNTHETIC_SOURCE_DESTINATION as Readonly<
    Record<string, PersistedContactSource | undefined>
  >;
  return synthetic[value] ?? null;
}

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
