/**
 * @jest-environment node
 *
 * BACKLOG-2624 — a missing name must mean ASK, never ACT.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS DEFENDING
 * ---------------------------------------------------------------------------
 * `namesAreCompatible("", x)` returns TRUE, by design: an empty name cannot
 * contradict. Every guard built on it is therefore DISABLED for records with no
 * name — which, on the founder's own store, is 18 of 1,124 macOS contacts plus
 * every email-only record. Those are the records with the LEAST evidence behind
 * them, so a guard that skips them is inverted.
 *
 * `nameSupportForAutoLink` is the strict rule for the one place that ACTS on the
 * answer. It is a separate function precisely because `namesAreCompatible` must
 * NOT change: its only production caller at `f573c21b` is
 * `src/utils/contactListAnchor.ts:121`, a scroll-anchor rule that removes
 * nothing, and permissiveness is right there. This file pins both — the shared
 * rule unchanged, the act-site rule strict.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE TRANSCRIBED FROM THE PRODUCER, NOT INVENTED
 * ---------------------------------------------------------------------------
 * The "nameless" strings below are not `""`. They are what the app actually
 * writes for a nameless record:
 *
 *   - the literal "Unknown" — five live paths still write it, because
 *     `schema.sql:141` declares `display_name TEXT NOT NULL` so "write nothing"
 *     was never available (`contactDbService.ts:187,327`,
 *     `contactHandlers.ts:1280,1519`, `localSyncService.ts:1534`);
 *   - a BAKED IDENTIFIER LABEL — `contactsService.buildContactLabel:932-944`
 *     returns `emails[0]`, else `formatPhoneNumber(phones[0])`, when a record
 *     has no name. The phone form is produced HERE by calling the very function
 *     that producer calls, rather than by pasting a guessed string.
 *
 * A test that only fed `""` would be describing a state the import path does not
 * emit, and would have passed over the defect that matters: two nameless records
 * sharing one email carry the SAME baked label, and identical strings read as a
 * name match.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS RUN — recorded in the PR with observed failure counts.
 * ---------------------------------------------------------------------------
 */

import { nameSupportForAutoLink } from "../autoLinkNameGuard";
import { namesAreCompatible } from "../contactNameCompat";
import { formatPhoneNumber } from "../phoneNormalization";

const EMAIL = "luis@example.com";
const PHONE = "+14155550120";

/** Exactly what `buildContactLabel` produces for a nameless record. */
const BAKED_EMAIL_LABEL = EMAIL;
const BAKED_PHONE_LABEL = formatPhoneNumber(PHONE);

const IDS = { emails: [EMAIL], phones: [PHONE] };

function verdict(
  recordName: string | null | undefined,
  contactName: string | null | undefined,
  identifiers: { emails?: string[] | null; phones?: string[] | null } = IDS,
) {
  return nameSupportForAutoLink({ recordName, contactName, identifiers });
}

// ===========================================================================
describe("BACKLOG-2624 — the shared rule is UNCHANGED (per-site decision)", () => {
  /**
   * The truth table, asserted value by value. If a later change "fixes"
   * `namesAreCompatible` itself instead of the act site, these go red and the
   * scroll-anchor caller has silently changed behaviour with it.
   */
  it("namesAreCompatible still returns exactly what it returned before", () => {
    expect(namesAreCompatible("Luis Ferreira", "Luis M Ferreira")).toBe(false);
    expect(namesAreCompatible("Marcus Ord", "Priya Raman")).toBe(false);
    expect(namesAreCompatible("Dana Reyes", "Dana Reyes")).toBe(true);
    expect(namesAreCompatible("Jane Smith", "Jane S.")).toBe(true);
    expect(namesAreCompatible("Robert Chen", "Bob Chen")).toBe(false);
  });

  it("and it is still permissive about an empty name — that is the defect this does NOT fix here", () => {
    expect(namesAreCompatible("", "Jane Doe")).toBe(true);
    expect(namesAreCompatible("", "")).toBe(true);
  });
});

// ===========================================================================
describe("BACKLOG-2624 — the truth table THROUGH the act-site guard", () => {
  const TABLE: Array<[string, string, boolean]> = [
    ["Luis Ferreira", "Luis M Ferreira", false],
    ["Marcus Ord", "Priya Raman", false],
    ["Dana Reyes", "Dana Reyes", true],
    ["Jane Smith", "Jane S.", true],
    ["Robert Chen", "Bob Chen", false],
  ];

  it.each(TABLE)("%s ~ %s -> supportsLink %s", (a, b, expected) => {
    expect(verdict(a, b)).toEqual(
      expected ? { supportsLink: true } : { supportsLink: false, reason: "name_mismatch" },
    );
  });

  it("is symmetric — swapping the sides never changes the verdict", () => {
    for (const [a, b] of TABLE) {
      expect(verdict(b, a)).toEqual(verdict(a, b));
    }
  });

  /**
   * BACKLOG-2399's rule, reached through the guard: a lone token is never enough
   * unless it is exactly equal. Both directions, because the predicate compares
   * up to the SHORTER name and the asymmetry is where the original bug lived.
   */
  it("a lone token claims nobody, but an exact single-token name still links", () => {
    expect(verdict("Margaret", "Margaret Chen")).toEqual({
      supportsLink: false,
      reason: "name_mismatch",
    });
    expect(verdict("Margaret Chen", "Margaret")).toEqual({
      supportsLink: false,
      reason: "name_mismatch",
    });
    expect(verdict("Cher", "Cher")).toEqual({ supportsLink: true });
  });
});

// ===========================================================================
describe("BACKLOG-2624 — a missing name is ASK, and it has three shapes", () => {
  /**
   * SHAPE 1 — genuinely blank. Swept, not sampled: every falsy spelling the
   * column and the JSON payload can hold.
   */
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a tab", "\t"],
    ["null", null],
    ["undefined", undefined],
  ])("%s on the RECORD side asks instead of acting", (_label, value) => {
    expect(verdict(value, "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("%s on the CONTACT side asks too — the rule is not one-sided", (_label, value) => {
    expect(verdict("Priya Raman", value)).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  /**
   * SHAPE 2 — the machine sentinel. Case-insensitive, trimmed, EXACT: a real
   * business called "Unknown Records LLC" keeps its name, which is the boundary
   * `realContactName`'s sentinel set is built to respect.
   */
  it.each(["Unknown", "unknown", "UNKNOWN", "  Unknown  ", "Unknown Contact", "unknown contact"])(
    "the machine literal %p is not a name",
    (sentinel) => {
      expect(verdict(sentinel, "Priya Raman")).toEqual({
        supportsLink: false,
        reason: "name_unknown",
      });
    },
  );

  it("two records both carrying the sentinel do NOT match on it", () => {
    // Before this guard: "Unknown" === "Unknown", so `namesAreCompatible` said
    // TRUE and two unrelated nameless people were linked on a shared line.
    expect(namesAreCompatible("Unknown", "Unknown")).toBe(true);
    expect(verdict("Unknown", "Unknown")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  it.each(["Unknown Records LLC", "Unknowns", "Unknown Chen", "Unbekannt Reyes"])(
    "%p IS a real name and is compared as one",
    (realName) => {
      expect(verdict(realName, realName)).toEqual({ supportsLink: true });
      expect(verdict(realName, "Priya Raman")).toEqual({
        supportsLink: false,
        reason: "name_mismatch",
      });
    },
  );

  /**
   * SHAPE 3 — the baked identifier label. THE CASE THAT WOULD HAVE DEFEATED THE
   * WHOLE GUARD: `buildContactLabel` writes the record's own email (or its
   * formatted phone) into the name field, and `validateContactData` forces the
   * same string into `contacts.display_name` on import. Two nameless records
   * that share one email therefore carry two IDENTICAL strings.
   */
  it("two nameless records sharing an email carry the SAME baked label — and still do not link", () => {
    expect(BAKED_EMAIL_LABEL).toBe(EMAIL);
    // The naive reading: identical strings, so "the names agree".
    expect(namesAreCompatible(BAKED_EMAIL_LABEL, BAKED_EMAIL_LABEL)).toBe(true);
    // The guard's reading: that is not a name, it is the thing they matched on.
    expect(verdict(BAKED_EMAIL_LABEL, BAKED_EMAIL_LABEL)).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  it("the baked PHONE label is recognised in every spelling the record may hold", () => {
    // `formatPhoneNumber` is what `buildContactLabel` calls, so this IS the
    // producer's output rather than a transcription of it.
    expect(BAKED_PHONE_LABEL).not.toBe("");
    expect(verdict(BAKED_PHONE_LABEL, "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
    // The same number written as the source stored it, unformatted.
    expect(verdict(PHONE, "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
    // And with different punctuation again — the comparison is on the lookup
    // key, so formatting cannot smuggle a label past it.
    expect(verdict("(415) 555-0120", "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  it("the email echo is case-insensitive and trimmed, like every other email comparison here", () => {
    expect(verdict("  LUIS@EXAMPLE.COM ", "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  /**
   * The other side of shape 3 — the echo test must not eat real names. An
   * identifier the record does NOT carry is somebody's name as far as this guard
   * is concerned, and a name containing digits is still a name.
   */
  it("an identifier the record does not hold is not an echo", () => {
    // Same shape as a baked label, but it is not in this record's identifier set.
    expect(verdict("someone.else@example.com", "someone.else@example.com")).toEqual({
      supportsLink: true,
    });
    expect(verdict(BAKED_PHONE_LABEL, "Priya Raman", { emails: [], phones: [] })).toEqual({
      supportsLink: false,
      // Still refused — but as a MISMATCH, because with no identifier set to
      // compare against the label is taken at face value as a name.
      reason: "name_mismatch",
    });
  });

  it.each(["Studio 54", "Chen 3rd Street Realty", "M2 Holdings"])(
    "%p keeps its name — a digit is not a phone number",
    (name) => {
      expect(verdict(name, name)).toEqual({ supportsLink: true });
    },
  );

  it("a nine-digit-ish string is not treated as a phone key", () => {
    // `toLookupKey` returns the last TEN digits; anything shorter cannot equal a
    // stored key, and the guard requires exactly ten before it will compare.
    expect(verdict("415555012", "415555012")).toEqual({ supportsLink: true });
  });
});

// ===========================================================================
describe("BACKLOG-2624 — the two refusals are told apart", () => {
  it("mismatch and unknown are distinct verdicts, not one 'refused'", () => {
    expect(verdict("Marcus Ord", "Priya Raman").supportsLink).toBe(false);
    expect(verdict("", "Priya Raman").supportsLink).toBe(false);
    expect(verdict("Marcus Ord", "Priya Raman")).not.toEqual(verdict("", "Priya Raman"));
  });

  it("an absent name wins over a mismatch — there is nothing to mismatch against", () => {
    expect(verdict("Unknown", "Priya Raman")).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
  });

  it("no identifiers supplied at all still applies the empty-name rule", () => {
    expect(nameSupportForAutoLink({ recordName: "", contactName: "Priya Raman" })).toEqual({
      supportsLink: false,
      reason: "name_unknown",
    });
    expect(nameSupportForAutoLink({ recordName: "Dana Reyes", contactName: "Dana Reyes" })).toEqual({
      supportsLink: true,
    });
  });
});
