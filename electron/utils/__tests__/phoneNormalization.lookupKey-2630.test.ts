/**
 * @jest-environment node
 *
 * BACKLOG-2630 slice 1 — the phone-key foundation.
 *
 * `toLookupKey` moved off `digits.slice(-10)` and onto libphonenumber-js with a
 * US default region; `toMatchingKey` adds the founder's digit floor over match
 * candidates ONLY. This suite is the record of what that is supposed to mean.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE — read before adding a case
 * ===========================================================================
 * Every expected key here was produced by RUNNING libphonenumber-js 1.13.11,
 * not reasoned about and not ported from the dropped BACKLOG-2635 branch (whose
 * expectations encode a hand-rolled Israeli rule this one deliberately does not
 * implement). Validity is metadata-dependent — `+44 7700 900123`, the Ofcom
 * drama range, is `isValid() === false` in this version — which is why
 * `package.json` pins the library EXACTLY rather than with a caret.
 *
 * The repository is public. Every number below is from a reserved fictional
 * range (NANP 555-01xx, Ofcom 020 7946 0xxx) or is synthetic. No real number
 * appears in this file.
 */

import {
  DEFAULT_PHONE_REGION,
  MATCHING_DIGIT_FLOOR,
  formatPhoneNumber,
  legacyDigitKey,
  toLookupKey,
  toMatchingKey,
} from "../phoneNormalization";

/**
 * The PRE-2630 rule, transcribed INDEPENDENTLY of the shipped `legacyDigitKey`.
 *
 * This duplication is the point. `toLookupKey`'s fallback claims to be
 * "byte-identical to what shipped before the library"; comparing it to the
 * helper it actually calls would prove only that a function equals itself.
 * Comparing it to a separate transcription of the rule as it stood at
 * `develop@50fea8cae` makes the claim falsifiable — mutate the shipped fallback
 * and this goes red.
 */
function preLibraryRule(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

describe("BACKLOG-2630 · toLookupKey — one key per number, from the library", () => {
  it("keys every spelling of one US number identically, with the country code", () => {
    // BACKLOG-2635's first defect: a number written without its country code
    // could never meet the same number written with one. The old rule collapsed
    // these four by amputation (last 10); this one unifies them by parsing.
    const spellings = [
      "4155550109", // bare 10-digit, no country code typed
      "(415) 555-0109", // as a person writes it
      "415-555-0109",
      "14155550109", // 11-digit, 1-prefixed
      "1 (415) 555-0109",
      "+14155550109", // E.164
      "+1 415 555 0109",
    ];

    const keys = new Set(spellings.map((s) => toLookupKey(s)));

    // Identity, not "they all match something": the exact key, and exactly one.
    expect(keys).toEqual(new Set(["14155550109"]));
  });

  it("keys a +-prefixed non-US number from its own country code, with no US assumption", () => {
    // Zero per-country code of ours is involved. The library reads +44 and +972
    // out of its own metadata. Under the OLD rule both of these were amputated
    // to their last ten digits — BACKLOG-2635's second defect — producing keys
    // that correspond to no real number and can collide with unrelated NANP
    // numbers.
    expect(toLookupKey("+44 20 7946 0958")).toBe("442079460958");
    expect(toLookupKey("+442079460958")).toBe("442079460958");
    expect(toLookupKey("+972 3 602 5852")).toBe("97236025852");

    // The collision the old rule created is gone: the amputated form of the
    // Israeli number is a plausible NANP number, and they must not share a key.
    expect(toLookupKey("+972 3 602 5852")).not.toBe(toLookupKey("(723) 602-5852"));
    expect(preLibraryRule("+972 3 602 5852")).toBe("7236025852"); // what it used to be
  });

  it("invents no country for a 9-digit leading-zero number — the overfit being replaced", () => {
    // This is the exact value SR finding D flagged on the dropped PR #2333:
    // the hand-rolled rule declared ANY 9-digit leading-0 number, in any user's
    // book, forever, to be Israeli (-> "97220794609") and migration v64 would
    // have persisted that guess. The library says "not a valid US number" and
    // this rule then asserts nothing at all about where it is from.
    expect(toLookupKey("020794609")).toBe("020794609");
    expect(toLookupKey("020794609")).toBe(preLibraryRule("020794609"));
    expect(toLookupKey("020794609")).not.toMatch(/^972/);
  });

  it("falls back to the pre-library rule, byte for byte, for everything unparseable", () => {
    // "Never worse than today" is checkable rather than hoped: for every input
    // the library will not validate, the shipped key must equal an INDEPENDENT
    // transcription of the rule that shipped before it.
    const unparseable = [
      "020794609", // 9-digit leading zero
      "0525550123", // 10-digit leading zero — isPossible() true, isValid() false
      "5550109", // 7-digit local, no area code
      "555010",
      "12345", // short code
      "4021", // an extension
      "11", // a typo
      "VERIZON", // alphanumeric sender
      "TXT-ALERT",
      "12345678901234", // a malformed long run
      "+12345678901234",
      "chat123456789@icloud.com", // an Apple ID living in a phone column
      "1115550109", // length-valid, pattern-invalid US (area code 111)
      "9995550123",
      "+44 7700 900123", // Ofcom drama range — invalid in this metadata version
      "",
      "   ",
    ];

    for (const value of unparseable) {
      expect({ value, key: toLookupKey(value) }).toEqual({
        value,
        key: preLibraryRule(value),
      });
    }

    // Null and undefined keep their guard.
    expect(toLookupKey(null)).toBe("");
    expect(toLookupKey(undefined)).toBe("");
  });

  it("exposes the fallback as the shared helper the migration and export path reuse", () => {
    // `legacyDigitKey` is not internal: `contactResolutionService.normalizePhone`
    // calls it directly so the export-resolution path keeps agreeing with the
    // last-ten key its SQL re-derives from `phone_e164`.
    for (const value of ["4155550109", "+442079460958", "12345", "VERIZON", ""]) {
      expect(legacyDigitKey(value)).toBe(preLibraryRule(value));
    }
  });

  it("keeps a short code keyable — BACKLOG-1493's rows must survive", () => {
    // `phone_last_message` is keyed BY the lookup key and short codes are
    // legitimate rows in it. A floor at THIS layer would delete them.
    for (const shortCode of ["12345", "262966", "4021", "911"]) {
      expect(toLookupKey(shortCode)).toBe(shortCode);
      expect(toLookupKey(shortCode).length).toBeGreaterThan(0);
    }
  });

  it("never returns an empty key for a value carrying digits — the '%%' guard", () => {
    // `contactDbService` builds its search needle as `%${toLookupKey(query)}%`.
    // An empty key there makes EVERY row match a short query. This assertion is
    // the tripwire on the whole class: it is what goes red if anyone ever moves
    // the digit floor into `toLookupKey`.
    for (let digits = 1; digits <= 12; digits += 1) {
      const query = "5".repeat(digits);
      expect({ digits, key: toLookupKey(query) }).not.toEqual({ digits, key: "" });
    }
  });

  it("the US default region is load-bearing, and this states what it decides", () => {
    expect(DEFAULT_PHONE_REGION).toBe("US");

    // MUTATION CONTROL. Delete the default region from `toLookupKey` — pass
    // `undefined` instead of DEFAULT_PHONE_REGION — and a bare 10-digit US
    // number can no longer be parsed at all: it falls back to the old
    // last-ten key and stops agreeing with its own "+1" form. Reproduced here
    // so the consequence is pinned rather than described.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parsePhoneNumberFromString } = require("libphonenumber-js");

    const withRegion = parsePhoneNumberFromString("4155550109", DEFAULT_PHONE_REGION);
    const withoutRegion = parsePhoneNumberFromString("4155550109", undefined);

    expect(withRegion?.isValid()).toBe(true);
    expect(withoutRegion).toBeUndefined();

    // ...which is exactly the key divergence the mutation would cause:
    expect(toLookupKey("4155550109")).toBe("14155550109");
    expect(preLibraryRule("4155550109")).toBe("4155550109");
    expect(toLookupKey("4155550109")).toBe(toLookupKey("+14155550109"));
  });

  it("gates on isValid, not isPossible — the difference is a whole invented country", () => {
    // Measured, not assumed: this value is POSSIBLE as a US number (right
    // length) and not VALID (a national number cannot start with 0). Gating on
    // possibility would key it "+1 052…" and re-invent the country-guessing
    // that got the hand-rolled attempt dropped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parsePhoneNumberFromString } = require("libphonenumber-js");
    const parsed = parsePhoneNumberFromString("0525550123", DEFAULT_PHONE_REGION);

    expect(parsed?.isPossible()).toBe(true);
    expect(parsed?.isValid()).toBe(false);
    expect(toLookupKey("0525550123")).toBe("0525550123");
    expect(toLookupKey("0525550123")).not.toMatch(/^1/);
  });

  it("preserves the BACKLOG-2620 invariant: formatting a number cannot change its key", () => {
    // `toLookupKey(formatPhoneNumber(p)) === toLookupKey(p)`. The dedicated
    // 2620 suite runs unmutated elsewhere; this is a second reading of it over
    // the shapes this change actually moved.
    const corpus = [
      "4155550109",
      "14155550109",
      "+14155550109",
      "(415) 555-0109",
      "+442079460958",
      "442079460958",
      "020794609",
      "5550109",
      "12345",
      "VERIZON",
    ];
    for (const value of corpus) {
      expect({ value, key: toLookupKey(formatPhoneNumber(value).trim()) }).toEqual({
        value,
        key: toLookupKey(value),
      });
    }
  });
});

describe("BACKLOG-2630 / BACKLOG-2754 · toMatchingKey — the floor, over candidates only", () => {
  it("puts the floor at 7 digits", () => {
    expect(MATCHING_DIGIT_FLOOR).toBe(7);
  });

  it("sweeps the boundary rather than sampling it", () => {
    // The founder said "6 or 7 or more digits, nothing less" and 7 was chosen —
    // a local number without its area code. One value per side cannot catch an
    // off-by-one, so every length from 3 to 11 is asserted, and the verdict is
    // the EXACT key, not "truthy".
    //
    // Note 415 rather than 555 for the ten-digit rungs: 555 is not a valid NANP
    // area code, so a "5555550109" fixture would fall to the legacy rule and
    // quietly stop testing the parsed path at all.
    const sweep: Array<{ digits: number; value: string; key: string }> = [
      { digits: 3, value: "555", key: "" },
      { digits: 4, value: "4021", key: "" },
      { digits: 5, value: "12345", key: "" },
      { digits: 6, value: "555010", key: "" }, // floor - 1
      { digits: 7, value: "5550109", key: "5550109" }, // floor
      { digits: 8, value: "15550109", key: "15550109" }, // floor + 1
      { digits: 9, value: "020794609", key: "020794609" },
      { digits: 10, value: "4155550109", key: "14155550109" }, // parses as US
      { digits: 11, value: "14155550109", key: "14155550109" },
    ];

    for (const { digits, value, key } of sweep) {
      expect({ digits, value, key: toMatchingKey(value) }).toEqual({
        digits,
        value,
        key,
      });
      // The digit count of each rung is what it claims to be — a fixture that
      // miscounts its own digits would sweep a different boundary than the one
      // in the name.
      expect((value.match(/\d/g) || []).length).toBe(digits);
    }
  });

  it("emits NO key below the floor — not a shorter key, nothing", () => {
    // The founder's words. A below-floor value must be absent from candidate
    // sets entirely, so a shared extension cannot propose two unrelated people
    // as the same person.
    for (const value of ["555010", "12345", "4021", "11", "9", "VERIZON", "ext. 302"]) {
      expect({ value, key: toMatchingKey(value) }).toEqual({ value, key: "" });
    }
  });

  it("agrees with toLookupKey for every value at or above the floor", () => {
    // Above the floor the floor is invisible: `toMatchingKey` is `toLookupKey`.
    for (const value of [
      "5550109",
      "4155550109",
      "(415) 555-0109",
      "+14155550109",
      "+44 20 7946 0958",
      "+972 3 602 5852",
      "020794609",
      "12345678901234",
    ]) {
      expect({ value, key: toMatchingKey(value) }).toEqual({
        value,
        key: toLookupKey(value),
      });
    }
  });

  it("leaves the value STORABLE and SEARCHABLE while barring it from matching", () => {
    // This is the half BACKLOG-2754 says fails if the floor is built at the key
    // layer: the same 6-digit value must still produce a storage key and a
    // non-empty search needle, and must still be findable by a substring of
    // itself, while producing no match candidate.
    const belowFloor = "555010";

    expect(toMatchingKey(belowFloor)).toBe(""); // not a match candidate
    expect(toLookupKey(belowFloor)).toBe("555010"); // still stored
    expect(`%${toLookupKey(belowFloor)}%`).not.toBe("%%"); // still a real needle
    expect(toLookupKey(belowFloor).includes("5550")).toBe(true); // still findable
  });

  it("counts digits of the raw value, so the verdict cannot hinge on parseability", () => {
    // "(555) 010" and "555010" are the same six digits wearing different
    // punctuation. Both are below the floor.
    expect(toMatchingKey("(555) 010")).toBe("");
    expect(toMatchingKey("555-010")).toBe("");
    expect(toMatchingKey("555 010")).toBe("");
    // And seven digits stay above it however they are punctuated.
    expect(toMatchingKey("555-0109")).toBe("5550109");
    expect(toMatchingKey("(555) 0109")).toBe("5550109");
  });

  it("keeps null/undefined/empty on the same guard as toLookupKey", () => {
    expect(toMatchingKey(null)).toBe("");
    expect(toMatchingKey(undefined)).toBe("");
    expect(toMatchingKey("")).toBe("");
    expect(toMatchingKey("   ")).toBe("");
  });
});
