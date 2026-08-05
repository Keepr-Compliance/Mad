/**
 * EVERY SOURCE MUST BE CALLED BY ITS OWN NAME (BACKLOG-2483)
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO CATCH
 * ===========================================================================
 * The import picker badged sources with a two-way ternary over a vocabulary of
 * nine:
 *
 *     {contact.source === "contacts_app" ? "Contacts App" : "Outlook"}
 *
 * Every source that was not `contacts_app` announced itself as **Outlook**. A
 * user with an Android phone opened the picker, scanned for Android, saw only
 * "Outlook" and "Contacts App", and reasonably concluded the Android import had
 * failed. The records were right there under a provider's name they had never
 * used.
 *
 * BACKLOG-1900 had already fixed the equivalent downgrade in the DATA path — its
 * own comment reads "Previously every non-outlook/google source (incl. iphone,
 * android_sync) was silently downgraded to contacts_app here". The renderer went
 * on doing the visual equivalent for another year.
 *
 * ===========================================================================
 * WHY A LABEL-BY-LABEL TEST IS NOT ENOUGH, AND WHAT IS ASSERTED INSTEAD
 * ===========================================================================
 * A test that renders an Outlook contact and asserts "Outlook" PASSES ON THE
 * BROKEN CODE — the old ternary returned "Outlook" for everything, so the one
 * value it got right is the one a per-value test is most likely to pick. The
 * same is true of iPhone-only or Android-only spot checks written as "does the
 * label appear at all".
 *
 * So the assertions here are INVERTED and EXHAUSTIVE:
 *
 *   1. The full source -> label map, asserted as one object equality, so a
 *      wrong label anywhere fails even if every label is individually present.
 *   2. The exact SET of sources that produce each label. "Outlook" must be
 *      produced by `outlook` AND BY NOTHING ELSE — this is the literal negation
 *      of the defect, and no per-value test states it.
 *   3. Coverage over `ALL_CONTACT_SOURCE_VALUES` (the shared vocabulary, not a
 *      list retyped here), so a source added to the CHECK without a label falls
 *      out as a failure instead of silently badging "Other".
 *
 * ===========================================================================
 * THE VOCABULARY IS IMPORTED, NEVER RETYPED
 * ===========================================================================
 * A hand-copied list of sources would go stale exactly the way the ternary did,
 * and the test would then pass for the same wrong reason it is meant to catch.
 * `electron/utils/contactSourceVocabulary.ts` enumerates the vocabulary beside
 * the function that emits it; this file asserts the LABELS cover THAT.
 *
 * ===========================================================================
 * NEGATIVE CONTROLS RUN (results recorded in the PR)
 * ===========================================================================
 *  (a) Restored the original two-way ternary logic in `contactSourceLabel`.
 *  (b) Pointed the `google_contacts` badge at the Outlook leaf.
 *  (c) Added a tenth value to PERSISTED_CONTACT_SOURCES with no leaf.
 * Each was confirmed to turn this file red. See the PR body for the output.
 */

import {
  ALL_CONTACT_SOURCE_VALUES,
  PERSISTED_CONTACT_SOURCES,
  SYNTHETIC_CONTACT_SOURCES,
} from "../../../electron/utils/contactSourceVocabulary";
import {
  AMBIGUOUSLY_LABELLED_CONTACT_SOURCES,
  UNKNOWN_CONTACT_SOURCE_LABEL,
  contactSourceLabel,
} from "../contactFilterModel";

describe("contactSourceLabel — every source is called by its own name", () => {
  /**
   * The whole map in one assertion.
   *
   * Written as a single `toEqual` rather than nine `expect(label).toBe(...)`
   * lines on purpose: an object equality fails on the FIRST wrong entry AND
   * reports every other difference alongside it, so a regression that shifts
   * several sources at once (which is exactly what a broken ternary does) is
   * reported as the one change it is.
   *
   * `google_contacts` is "Gmail" and not "Google" because "Gmail" is the label
   * `SOURCE_GROUPS` gives that leaf, and the Source filter dropdown on the same
   * screen renders that string. Two names for one source is the defect class
   * being fixed here, not a style preference.
   */
  it("maps every persisted and synthetic source to its own distinct label", () => {
    const actual = Object.fromEntries(
      ALL_CONTACT_SOURCE_VALUES.map((source) => [source, contactSourceLabel(source)]),
    );

    expect(actual).toEqual({
      manual: "Manual",
      email: "From Email",
      sms: "From Texts",
      contacts_app: "Contacts App",
      inferred: "From Email",
      android_sync: "Android",
      iphone: "iPhone",
      outlook: "Outlook",
      google_contacts: "Gmail",
      messages: "From Texts",
    });
  });

  /**
   * THE DIRECT NEGATION OF THE DEFECT.
   *
   * The old ternary made "Outlook" the label for eight of the nine sources. This
   * asserts the exact SET of sources that may produce it — identity, not a
   * count, and not "Outlook appears somewhere".
   *
   * Reversing the fix makes this fail with a set of eight against an expected
   * set of one, which names the bug in the failure message itself.
   */
  it("produces 'Outlook' for the outlook source and for nothing else", () => {
    const sourcesLabelledOutlook = ALL_CONTACT_SOURCE_VALUES.filter(
      (source) => contactSourceLabel(source) === "Outlook",
    );

    expect(sourcesLabelledOutlook).toEqual(["outlook"]);
  });

  /**
   * The same exact-set rule for every other label, so no single provider can
   * quietly absorb a source it does not own.
   *
   * `From Email` and `From Texts` legitimately claim more than one source —
   * `matchesSourceLeaf` folds `inferred` in with `email` and `messages` in with
   * `sms` — so the expectation names all of them rather than assuming one each.
   */
  it("attributes each label to exactly the sources that own it", () => {
    const byLabel: Record<string, string[]> = {};
    for (const source of ALL_CONTACT_SOURCE_VALUES) {
      const label = contactSourceLabel(source);
      (byLabel[label] ??= []).push(source);
    }

    expect(byLabel).toEqual({
      Manual: ["manual"],
      "Contacts App": ["contacts_app"],
      Outlook: ["outlook"],
      Gmail: ["google_contacts"],
      iPhone: ["iphone"],
      Android: ["android_sync"],
      "From Email": ["email", "inferred"],
      "From Texts": ["sms", "messages"],
    });
  });

  /**
   * COVERAGE — the assertion that survives someone adding a source next year.
   *
   * Driven off the shared vocabulary constant rather than the list above, so a
   * value added to `PERSISTED_CONTACT_SOURCES` with no filter leaf fails HERE,
   * at the point it becomes unnameable, instead of shipping as "Other".
   */
  it("has a real name for every value in the shared vocabulary", () => {
    const unnamed = ALL_CONTACT_SOURCE_VALUES.filter(
      (source) => contactSourceLabel(source) === UNKNOWN_CONTACT_SOURCE_LABEL,
    );

    expect(unnamed).toEqual([]);
  });

  /**
   * NO SOURCE MAY BE CLAIMED BY TWO LEAVES.
   *
   * Added because negative control (b) — putting `google_contacts` on the
   * Outlook leaf — did NOT turn this suite red on the first implementation. The
   * inversion overwrote rather than collected, `EMAIL_GMAIL` was iterated last,
   * and the wrong mapping was absorbed in silence.
   *
   * The property that actually matters is not "google_contacts says Gmail" but
   * "each source belongs to exactly one leaf", because `matchesSourceLeaf` uses
   * `.some()`: a doubly-claimed source lands under two headings in the filter
   * while the badge shows one of them. This states that property directly, so
   * the drift is caught at the mapping instead of at whichever label happened to
   * win.
   */
  it("gives every source exactly one owning leaf", () => {
    expect(AMBIGUOUSLY_LABELLED_CONTACT_SOURCES).toEqual([]);
  });

  /**
   * Guards the constant this file asserts over from shrinking. If someone
   * removes a source from the vocabulary, the maps above would still pass —
   * they would simply describe less. This states the size of the world.
   */
  it("covers the full vocabulary, persisted plus synthetic", () => {
    expect(ALL_CONTACT_SOURCE_VALUES).toEqual([
      ...PERSISTED_CONTACT_SOURCES,
      ...SYNTHETIC_CONTACT_SOURCES,
    ]);
  });

  /**
   * An unrecognised source must never be given a provider's name.
   *
   * This is the rule the old code broke in the most damaging way available: it
   * answered "which address book is this from?" with a confident, specific,
   * wrong answer. "Other" is the honest answer and the only safe default.
   *
   * NULL and empty string are included because `contacts.source` is nullable
   * with no CHECK on the shadow-table side, and the picker's STEP 1 reads the
   * column straight through (`dbContact.source || "contacts_app"`).
   */
  it.each([
    ["an unrecognised source", "yahoo_contacts"],
    ["a future source", "proton_contacts"],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("labels %s as 'Other' rather than naming a provider", (_case, value) => {
    expect(contactSourceLabel(value)).toBe("Other");
    expect(contactSourceLabel(value)).toBe(UNKNOWN_CONTACT_SOURCE_LABEL);
  });
});
