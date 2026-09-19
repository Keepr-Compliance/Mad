/**
 * =============================================================================
 * BACKLOG-2481 — where a saved text-derived person LANDS in the source filter
 * =============================================================================
 * THE CONTROL THIS ITEM WAS NEARLY SHIPPED WITHOUT, and the reason it is worth
 * saying so in a test file.
 *
 * The item was briefed to map `messages` -> `sms` at the write boundary. That is
 * the truthful-looking answer and it is wrong, for a reason no assertion on the
 * handler could ever have caught: the write succeeds, the row is there, and the
 * person cannot be found.
 *
 * Every SAVED contact reaches this predicate with `is_message_derived = 0` —
 * hard-coded as `0 as is_message_derived` in the one projection behind
 * `contacts:get-all` (`electron/services/db/contactProjectionSql.ts:117`). The
 * Inferred>From Texts leaf requires that flag, and `sms` appears in no other
 * leaf's value list. So a stored `sms` contact matches NOTHING: nothing under
 * the default selection, nothing with every box ticked, and — measured on the
 * rendered screen — not found by searching its own name, while
 * `contactSourceLabel('sms')` labels it "From Texts", a leaf that cannot find it.
 *
 * `contacts_app` fails differently and more quietly: it renders perfectly well,
 * so an assertion phrased as "the destination is visible" passes on it. It is
 * also a false claim that the person is in the macOS address book, and it writes
 * `('macos','origin')` into the crosswalk. That is why every assertion below
 * names `manual` BY VALUE rather than reading a shared constant — a control
 * whose expectation is imported from the thing under test cannot fail.
 *
 * -----------------------------------------------------------------------------
 * WHY THE FIXTURES CARRY `source_types`
 * -----------------------------------------------------------------------------
 * `getImportedContactsByUserId` does not stop at that SQL — `attachLiveSources`
 * stamps `source_types` from `contact_source_links`, and `liveSourcesOf` PREFERS
 * `source_types` and ignores the scalar whenever it is present. A fixture built
 * from the projection alone omits the field that decides the answer. The values
 * used here are the crosswalk rows the import actually writes, measured through
 * the registered handler in
 * `electron/__tests__/contact-handlers.messagesSource-2481.test.ts`.
 */

import {
  ALL_SOURCE_LEAF_IDS,
  DEFAULT_SOURCE_SELECTION,
  SOURCE_LEAF,
  contactSourceLabel,
  matchesSourceFilter,
} from "../contactFilterModel";
import {
  MESSAGE_DERIVED_ONLY_SOURCES,
  SYNTHETIC_CONTACT_SOURCES,
  SYNTHETIC_SOURCE_DESTINATION,
  toPersistedContactSource,
  toStorableContactSource,
} from "../../../electron/utils/contactSourceVocabulary";
import type { Contact } from "../../../electron/types/models";

type Filterable = Pick<Contact, "source" | "source_types" | "is_message_derived">;

/**
 * A SAVED contact, exactly as the read path hands it to the filter.
 *
 * `crosswalkSourceType` is the RAW `contact_source_links.source_type` the import
 * writes — measured through the registered handler, not guessed — and it is put
 * through `toPersistedContactSource` here because that is precisely what
 * `getLiveSourcesByContact` (`contactSourceSets.ts:96`) does before
 * `attachLiveSources` stamps `source_types`. Writing the mapped value by hand
 * instead is how the first draft of this file got a false red: `('macos',...)`
 * is stamped as `contacts_app`, not as `macos`.
 */
function saved(source: string, crosswalkSourceType: string): Filterable {
  return {
    source,
    source_types: [toPersistedContactSource(crosswalkSourceType)],
    // Not a choice: `contactProjectionSql.ts:117` hard-codes it for every saved row.
    is_message_derived: 0,
  } as unknown as Filterable;
}

/** An UNSAVED pseudo-contact, as `getMessageDerivedContacts` synthesises it. */
const pseudo = {
  source: "messages",
  source_types: undefined,
  is_message_derived: 1,
} as unknown as Filterable;

/* ==========================================================================
 * C4 — the destination is reachable, and reachable BY DEFAULT
 * ========================================================================== */
describe("the value a saved text-derived person is stored as (BACKLOG-2481)", () => {
  it("is 'manual' — named here, so a changed destination breaks a test and not a user", () => {
    expect(SYNTHETIC_SOURCE_DESTINATION.messages).toBe("manual");
    expect(toStorableContactSource("messages", "contacts_app")).toBe("manual");
  });

  it("matches the Manual leaf, and that leaf is on by default", () => {
    const contact = saved("manual", "manual");

    expect(matchesSourceFilter(contact, new Set([SOURCE_LEAF.MANUAL]))).toBe(true);
    expect(matchesSourceFilter(contact, new Set(DEFAULT_SOURCE_SELECTION))).toBe(true);
    expect(matchesSourceFilter(contact, new Set(ALL_SOURCE_LEAF_IDS))).toBe(true);
  });

  /**
   * THE NEGATIVE HALF, and the half that carries the finding. Without it the
   * assertions above pass on `contacts_app` too, and this whole file would be
   * proving the shape of the data rather than the property.
   */
  it("would be UNREACHABLE if it were stored as 'sms' — under every selection", () => {
    const asSms = saved("sms", "sms");

    expect(matchesSourceFilter(asSms, new Set(DEFAULT_SOURCE_SELECTION))).toBe(false);
    // Not a default-selection quibble: "Show all" ticks every leaf and it is
    // STILL false. There is no setting that reveals this contact.
    expect(matchesSourceFilter(asSms, new Set(ALL_SOURCE_LEAF_IDS))).toBe(false);
    expect(
      ALL_SOURCE_LEAF_IDS.filter((leaf) => matchesSourceFilter(asSms, new Set([leaf]))),
    ).toEqual([]);
    // And the app would label it with the name of a leaf that cannot find it.
    expect(contactSourceLabel("sms")).toBe("From Texts");
  });

  /**
   * `contacts_app` is the destination a fallback-shaped fix lands on, and it
   * passes every visibility assertion. The thing wrong with it is the CLAIM, so
   * that is what is pinned: it belongs to a different leaf, one that names an
   * address book the person has never been in.
   */
  it("is NOT 'contacts_app' — which renders fine and is a false claim", () => {
    expect(SYNTHETIC_SOURCE_DESTINATION.messages).not.toBe("contacts_app");

    const asContactsApp = saved("contacts_app", "macos");
    expect(matchesSourceFilter(asContactsApp, new Set(DEFAULT_SOURCE_SELECTION))).toBe(true);
    expect(
      matchesSourceFilter(asContactsApp, new Set([SOURCE_LEAF.CONTACTS_APP])),
    ).toBe(true);
    expect(matchesSourceFilter(asContactsApp, new Set([SOURCE_LEAF.MANUAL]))).toBe(false);
  });
});

/* ==========================================================================
 * C3 — the UNSAVED pseudo-contact's display is untouched by all of this
 * ========================================================================== */
describe("message-derived DISPLAY is unchanged (BACKLOG-2481)", () => {
  it("`messages` is still SELECT-time vocabulary, not removed from the read side", () => {
    expect([...SYNTHETIC_CONTACT_SOURCES]).toContain("messages");
    expect(MESSAGE_DERIVED_ONLY_SOURCES).toContain("messages");
  });

  it("a pseudo-contact still lands on Inferred > From Texts, and only there", () => {
    expect(
      ALL_SOURCE_LEAF_IDS.filter((leaf) => matchesSourceFilter(pseudo, new Set([leaf]))),
    ).toEqual([SOURCE_LEAF.INFERRED_TEXTS]);
  });

  /**
   * Pinned because it is the reason founder QA needs an instruction: the
   * unsaved rows are HIDDEN under the default filter, and "Show all" is what
   * reveals them. A tester who does not know that reports "there are none".
   */
  it("but is hidden under the default selection, and shown by Show all", () => {
    expect(matchesSourceFilter(pseudo, new Set(DEFAULT_SOURCE_SELECTION))).toBe(false);
    expect(matchesSourceFilter(pseudo, new Set(ALL_SOURCE_LEAF_IDS))).toBe(true);
  });

  /**
   * The write boundary must not touch the read side. Driving the function is
   * the assertion — reading the constant would only prove the constant.
   */
  it("the write boundary refuses `messages` without changing what SELECT emits", () => {
    expect(toStorableContactSource("messages", "contacts_app")).not.toBe("messages");
    expect(matchesSourceFilter(pseudo, new Set([SOURCE_LEAF.INFERRED_TEXTS]))).toBe(true);
  });
});
