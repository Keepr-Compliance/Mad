/**
 * THE FILTER MUST HAVE A LEAF FOR EVERY SOURCE VALUE THAT EXISTS (BACKLOG-2473)
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO CATCH
 * ===========================================================================
 * SR review of PR #2197 named this the single most valuable missing test in the
 * contacts work:
 *
 *   > No test asserts that EVERY value `toPersistedContactSource` can emit is
 *   > covered by a filter leaf. A newly added source with no matching leaf would
 *   > hide those contacts from EVERY filter, with all tests green.
 *
 * Read that failure carefully, because it is worse than it sounds. It is not
 * that the contacts appear under the wrong heading. `matchesSourceFilter`
 * returns true only if SOME selected leaf matches, so a source with no leaf
 * matches nothing — the contacts are invisible with every box ticked, with
 * "select all" active, with no way for the user to reach them at all. And every
 * existing test stays green, because each one asserts about a source that DOES
 * have a leaf.
 *
 * The whole existing filter suite is written per-value. That shape can only ever
 * test the values someone remembered to write a case for, which is precisely the
 * set that cannot contain the bug.
 *
 * ===========================================================================
 * WHY THE ASSERTION IS OVER A CONSTANT AND NOT A HAND-WRITTEN LIST
 * ===========================================================================
 * A list of sources copied into this file would go stale the same way the filter
 * does, and then the test would pass for the same wrong reason. The vocabulary
 * is enumerated once in `electron/utils/contactSourceVocabulary.ts`, beside the
 * function that emits it, and this file asserts the FILTER covers THAT — so
 * adding a source means either adding a leaf or watching this go red.
 *
 * ===========================================================================
 * NEGATIVE CONTROLS RUN (results recorded in the PR)
 * ===========================================================================
 *  (a) Deleted the `SOURCE_LEAF.PHONE_ANDROID` leaf from SOURCE_GROUPS.
 *  (b) Changed `matchesSourceLeaf`'s CONTACTS_APP case to `source === "macos"`.
 *  (c) Added a tenth value to PERSISTED_CONTACT_SOURCES with no leaf.
 * Each was confirmed to turn this file red. A coverage test that survives all
 * three is testing the shape of the data, not the property.
 */

import {
  ALL_CONTACT_SOURCE_VALUES,
  MESSAGE_DERIVED_ONLY_SOURCES,
  PERSISTED_CONTACT_SOURCES,
  SYNTHETIC_CONTACT_SOURCES,
  TO_PERSISTED_CONTACT_SOURCE_RANGE,
  toPersistedContactSource,
} from "../../../electron/utils/contactSourceVocabulary";
import {
  ALL_SOURCE_LEAF_IDS,
  SOURCE_GROUPS,
  SOURCE_LEAF,
  matchesSourceFilter,
} from "../contactFilterModel";

/** Every leaf id the UI can offer, taken from the config the UI actually renders. */
const everyLeaf = (): Set<string> => new Set<string>(ALL_SOURCE_LEAF_IDS as readonly string[]);

/**
 * The leaf ids that match a contact with this source, under a given
 * message-derived flag. Derived by EXECUTING the predicate one leaf at a time —
 * not by reading the switch — so it measures the shipped behaviour.
 */
function matchingLeaves(source: string, isMessageDerived: boolean): string[] {
  const contact = { source, is_message_derived: isMessageDerived } as Parameters<
    typeof matchesSourceFilter
  >[0];
  return (ALL_SOURCE_LEAF_IDS as readonly string[]).filter((leaf) =>
    matchesSourceFilter(contact, new Set([leaf])),
  );
}

/** True when SOME assignment of `is_message_derived` makes this source visible. */
function isReachable(source: string): boolean {
  return matchingLeaves(source, false).length > 0 || matchingLeaves(source, true).length > 0;
}

describe("source-filter vocabulary coverage (BACKLOG-2473, SR ask on #2197)", () => {
  // =========================================================================
  // THE ASSERTION SR ASKED FOR, LITERALLY
  // =========================================================================
  describe("every value toPersistedContactSource can emit", () => {
    /**
     * The emitted set is derived by DRIVING THE FUNCTION, not by trusting the
     * constant. Inputs: every `ExternalContactSource`, plus the values that fall
     * through to the default branch. If someone adds a `case` returning a new
     * value, the range constant stops matching and this fails — before the new
     * value can reach a filter that has no leaf for it.
     */
    it("is exactly the documented range — the enumeration cannot silently go stale", () => {
      const emitted = new Set<string>(
        [
          "macos",
          "iphone",
          "outlook",
          "google_contacts",
          "android_sync",
          // The default branch, reached by anything unrecognised.
          "something_new",
          "",
          null,
          undefined,
        ].map((input) => toPersistedContactSource(input as string | null | undefined)),
      );

      expect([...emitted].sort()).toEqual([...TO_PERSISTED_CONTACT_SOURCE_RANGE].sort());
    });

    it("is covered by at least one filter leaf — none of them is invisible", () => {
      const uncovered = TO_PERSISTED_CONTACT_SOURCE_RANGE.filter((s) => !isReachable(s));
      expect(uncovered).toEqual([]);
    });

    /**
     * Stronger than "at least one leaf exists": names the EXACT leaf each value
     * lands on. A source silently re-pointed at another leaf (Outlook contacts
     * folded under Gmail, say) still satisfies the coverage check above while
     * being plainly wrong on screen.
     */
    it("lands on the EXACT leaf it should, one leaf each", () => {
      const landing = Object.fromEntries(
        TO_PERSISTED_CONTACT_SOURCE_RANGE.map((s) => [s, matchingLeaves(s, false)]),
      );

      expect(landing).toEqual({
        contacts_app: [SOURCE_LEAF.CONTACTS_APP],
        iphone: [SOURCE_LEAF.PHONE_IPHONE],
        outlook: [SOURCE_LEAF.EMAIL_OUTLOOK],
        google_contacts: [SOURCE_LEAF.EMAIL_GMAIL],
        android_sync: [SOURCE_LEAF.PHONE_ANDROID],
      });
    });
  });

  // =========================================================================
  // THE WIDER SET — everything that can actually reach the filter
  // =========================================================================
  describe("every source value that can reach the filter at all", () => {
    /**
     * `toPersistedContactSource` is only one of the ways a source value is
     * produced. The manual Add Contact form writes `manual`; the message-derived
     * read path synthesises `messages`. Covering only the import mapper would
     * leave the two populations BACKLOG-2473 is about untested.
     */
    it("is covered by at least one leaf, under some is_message_derived value", () => {
      const uncovered = ALL_CONTACT_SOURCE_VALUES.filter((s) => !isReachable(s));
      expect(uncovered).toEqual([]);
    });

    /**
     * Pins WHICH values need the message-derived flag to be visible, because
     * that asymmetry is a real hole in the filter and this test is the only
     * place it is written down.
     *
     * A contact whose source is `email`/`sms`/`inferred` but whose
     * `is_message_derived` is falsy matches NO leaf and is invisible. Today
     * nothing writes that combination — those sources are set by the
     * message-derived paths, which always set the flag. This assertion is what
     * makes it break loudly if that ever stops being true, instead of quietly
     * hiding contacts.
     */
    it("splits into flag-independent and message-derived-only exactly as documented", () => {
      const needsFlag = ALL_CONTACT_SOURCE_VALUES.filter(
        (s) => matchingLeaves(s, false).length === 0 && matchingLeaves(s, true).length > 0,
      );
      expect(needsFlag.sort()).toEqual([...MESSAGE_DERIVED_ONLY_SOURCES].sort());
    });

    it("the two vocabularies together are the whole set — no third category is being missed", () => {
      expect(ALL_CONTACT_SOURCE_VALUES.slice().sort()).toEqual(
        [...PERSISTED_CONTACT_SOURCES, ...SYNTHETIC_CONTACT_SOURCES].sort(),
      );
      // A coverage test over an empty list would pass forever. Name the size.
      expect(ALL_CONTACT_SOURCE_VALUES.length).toBe(10);
    });
  });

  // =========================================================================
  // THE OTHER DIRECTION — no leaf that matches nothing
  // =========================================================================
  describe("every leaf the UI offers", () => {
    /**
     * The inverse defect: a leaf the user can tick that can never match a
     * contact. Less severe than an invisible source (nothing disappears), but it
     * is a control that silently does nothing, and it is how a renamed source
     * value shows up — the old leaf keeps matching the old spelling, which no
     * longer exists.
     */
    it("can be matched by at least one real source value", () => {
      const deadLeaves = (ALL_SOURCE_LEAF_IDS as readonly string[]).filter(
        (leaf) =>
          !ALL_CONTACT_SOURCE_VALUES.some(
            (s) =>
              matchingLeaves(s, false).includes(leaf) || matchingLeaves(s, true).includes(leaf),
          ),
      );
      expect(deadLeaves).toEqual([]);
    });

    it("is reachable from the rendered group config — no orphan leaf ids", () => {
      const fromGroups = new Set(SOURCE_GROUPS.flatMap((g) => g.children.map((c) => c.id)));
      expect([...everyLeaf()].sort()).toEqual([...fromGroups].sort());
    });
  });

  // =========================================================================
  // THE `contacts.source` CHECK AND THIS LIST MUST AGREE
  // =========================================================================
  /**
   * The persisted vocabulary is a mirror of a CHECK constraint in another file
   * and another language. A mirror nothing compares is a copy that drifts, which
   * is the failure `contactIdentitySchemaSql.ts` exists to prevent for DDL — the
   * same argument applies here.
   *
   * Read out of `schema.sql` rather than restated, so this compares two things
   * that are genuinely independent.
   */
  it("matches the contacts.source CHECK in schema.sql, value for value", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");

    const schema = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "electron", "database", "schema.sql"),
      "utf8",
    );

    const match = schema.match(
      /source TEXT DEFAULT 'manual' CHECK \(source IN \(([^)]*)\)\)/,
    );
    expect(match).not.toBeNull();

    const fromCheck = match![1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    expect(fromCheck.sort()).toEqual([...PERSISTED_CONTACT_SOURCES].sort());
  });
});
