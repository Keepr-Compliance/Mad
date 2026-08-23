/**
 * @jest-environment node
 *
 * BACKLOG-2798 — THE PHONE-CORPUS INVARIANT SUITE.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR
 * ===========================================================================
 * `fixtures/phoneCorpora.ts` is about to become shared infrastructure: nine
 * suites are blind to the parser because every fixture they own sits on the
 * unassignable NANP area code 555, and the migration off that blindness runs
 * through this corpus. A shared corpus that is wrong is worse than nine private
 * ones that are wrong, because it is wrong in nine places at once and each of
 * them looks green.
 *
 * So this file holds the corpus to two obligations:
 *
 *   1. **It is what it says it is.** Every declared `parseClass`, `digits`,
 *      `lookupKey` and `matchingKey` is re-derived here against the live library
 *      and the live functions. The corpus file itself imports neither — its
 *      expectations are transcribed literals — so this is a genuine comparison
 *      and not a function being asked whether it equals itself.
 *
 *   2. **It has teeth.** A corpus can be "correct" and still prove nothing:
 *      that is precisely the state the 555 fixtures were in, agreeing with the
 *      code on every input while touching one branch of two. The controls below
 *      assert that the parsed branch is genuinely reached, that the two branches
 *      are genuinely distinguishable on this corpus, and — over the retained
 *      pre-2798 fixtures — that they genuinely were NOT distinguishable before.
 *
 * ===========================================================================
 * SCOPE: KEYS ONLY (BACKLOG-2754)
 * ===========================================================================
 * This suite asserts what `toLookupKey` and `toMatchingKey` RETURN. It asserts
 * nothing about lookup, contact search, candidate SQL or any persisted column.
 * BACKLOG-2754's whole point is that the digit floor belongs over the matcher
 * and not over the key layer — a floor in `toLookupKey` would drop short codes
 * from `phone_last_message` (undoing BACKLOG-1493) and turn the contact-search
 * needle into `'%%'`. The one thing this file says about that boundary is the
 * key-level half: `toLookupKey` has no floor. The search-level half lives with
 * the search code, where it can actually fail.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

import {
  DEFAULT_PHONE_REGION,
  MATCHING_DIGIT_FLOOR,
  legacyDigitKey,
  toLookupKey,
  toMatchingKey,
} from "../phoneNormalization";

import {
  ALL_PHONE_FIXTURES,
  CA_PARSEABLE,
  FLOOR_BOUNDARY,
  INTERNATIONAL_PARSEABLE,
  LEGACY_555_FIXTURES,
  PARSED_WITH_DIGITS_DROPPED,
  PARSEABLE,
  UNPARSEABLE,
  UNPARSEABLE_555,
  US_PARSEABLE,
  digitCount,
  ofClass,
  type PhoneFixture,
} from "./fixtures/phoneCorpora";

/**
 * The branch selector, read straight from the library rather than inferred.
 *
 * Deliberately NOT `toLookupKey(v) !== legacyDigitKey(v)`. That proxy is
 * tempting and wrong: it reports "fallback" for any country whose full E.164
 * digit string happens to equal its own last ten — a ten-digit total, e.g. a
 * `+45` Danish number — even though the library parsed it perfectly. Using the
 * proxy as the instrument would understate parse coverage in exactly the
 * regions a corpus is added to cover. It is used below as a SEPARATE
 * falsifiability check, which is a different job.
 */
function reachesParser(raw: string): boolean {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_PHONE_REGION);
  return !!(parsed && parsed.isValid());
}

const parsedCount = (values: readonly string[]): number => values.filter(reachesParser).length;

describe("BACKLOG-2798 · the corpus is what it declares itself to be", () => {
  const named: Array<[string, readonly PhoneFixture[]]> = [
    ["US_PARSEABLE", US_PARSEABLE],
    ["CA_PARSEABLE", CA_PARSEABLE],
    ["INTERNATIONAL_PARSEABLE", INTERNATIONAL_PARSEABLE],
    ["PARSED_WITH_DIGITS_DROPPED", PARSED_WITH_DIGITS_DROPPED],
    ["UNPARSEABLE", UNPARSEABLE],
    ["FLOOR_BOUNDARY", FLOOR_BOUNDARY],
  ];

  it.each(named)(
    "%s — every declared parseClass matches the live library's verdict",
    (_group, fixtures) => {
      for (const f of fixtures) {
        // Identity per fixture, so a failure names the value rather than a count.
        expect({ raw: f.raw, parseClass: f.parseClass }).toEqual({
          raw: f.raw,
          parseClass: reachesParser(f.raw) ? "parsed" : "fallback",
        });
      }
    },
  );

  it.each(named)("%s — every declared digit count is the raw value's own", (_group, fixtures) => {
    // A fixture that miscounts its own digits would sweep a different boundary
    // than the one its position in the list claims.
    for (const f of fixtures) {
      expect({ raw: f.raw, digits: f.digits }).toEqual({ raw: f.raw, digits: digitCount(f.raw) });
    }
  });

  it.each(named)("%s — every declared lookupKey is the key the code produces", (_group, fixtures) => {
    for (const f of fixtures) {
      expect({ raw: f.raw, lookupKey: f.lookupKey }).toEqual({
        raw: f.raw,
        lookupKey: toLookupKey(f.raw),
      });
    }
  });

  it.each(named)("%s — every declared matchingKey is the key the code produces", (_group, fixtures) => {
    for (const f of fixtures) {
      expect({ raw: f.raw, matchingKey: f.matchingKey }).toEqual({
        raw: f.raw,
        matchingKey: toMatchingKey(f.raw),
      });
    }
  });

  it("carries no duplicate raw values inside a group", () => {
    // Two rows for one value are how a corpus silently disagrees with itself
    // after an edit. FLOOR_BOUNDARY deliberately overlaps the other groups, so
    // uniqueness is asserted per group and not across ALL_PHONE_FIXTURES.
    for (const [group, fixtures] of named) {
      const raws = fixtures.map((f) => f.raw);
      expect({ group, unique: new Set(raws).size }).toEqual({ group, unique: raws.length });
    }
  });
});

describe("BACKLOG-2798 · the corpus has teeth — it reaches the branch 555 cannot", () => {
  it("actually reaches the parsed branch, and the exact count is pinned", () => {
    // The whole point of the item. Pinned as an exact number rather than
    // ">0" so that deleting parseable fixtures is a red test and not a quiet
    // narrowing of coverage.
    const parsed = ofClass(ALL_PHONE_FIXTURES, "parsed");
    expect(parsed.length).toBe(32);
    expect(parsedCount(ALL_PHONE_FIXTURES.map((f) => f.raw))).toBe(32);

    // And it still exercises the fallback: a corpus that only parsed would stop
    // testing `legacyDigitKey`, which is the other half of the shipped rule.
    expect(ofClass(ALL_PHONE_FIXTURES, "fallback").length).toBe(43);
  });

  it("reaches the parser on the DEFAULT-REGION path, not only via a leading '+'", () => {
    // This is the specific hole the pre-2798 corpus had. Three `+`-prefixed
    // values parsed there incidentally; NOTHING typed the way a US user types a
    // phone number did. A bare or punctuated ten-digit number with no country
    // code is the path `DEFAULT_PHONE_REGION` exists for.
    const noPlus = US_PARSEABLE.filter((f) => !f.raw.trim().startsWith("+")).map((f) => f.raw);

    expect(noPlus.length).toBeGreaterThan(0);
    expect(parsedCount(noPlus)).toBe(noPlus.length);

    // And it is the region that does it — without one, these do not parse at all.
    for (const raw of noPlus) {
      expect({ raw, parsedWithoutRegion: parsePhoneNumberFromString(raw.trim(), undefined) }).toEqual({
        raw,
        parsedWithoutRegion: undefined,
      });
    }
  });

  it("distinguishes the two branches: every parsed value keys differently from the old rule", () => {
    // The falsifiability check PR #2346's repaired corpora established. If a
    // parsed fixture produced the same key as the pre-library rule, it would be
    // indistinguishable from a fallback fixture and would prove nothing by being
    // present.
    for (const f of PARSEABLE) {
      expect({ raw: f.raw, differs: toLookupKey(f.raw) !== legacyDigitKey(f.raw.trim()) }).toEqual({
        raw: f.raw,
        differs: true,
      });
    }
  });

  it("covers more than one country, so the corpus is not one shape wearing flags", () => {
    const countries = new Set(
      PARSEABLE.map((f) => parsePhoneNumberFromString(f.raw.trim(), DEFAULT_PHONE_REGION)?.country),
    );
    // US and CA share +1 and are different countries; the rest carry their own.
    expect(countries).toEqual(new Set(["US", "CA", "GB", "FR", "AU", "IL", "CN"]));
  });
});

describe("BACKLOG-2798 · the control — the pre-2798 fixtures could not tell the branches apart", () => {
  it("no 555 fixture reaches the parser", () => {
    // Area code 555 is unassignable, so the library rejects every one of them.
    // If a metadata update ever changed that, this goes red and the premise of
    // the whole item has changed — which is worth being told about.
    expect(parsedCount(LEGACY_555_FIXTURES)).toBe(0);
    expect(parsedCount(UNPARSEABLE_555.map((f) => f.raw))).toBe(0);
  });

  it("and on those fixtures the parsed rule and the old rule are INDISTINGUISHABLE", () => {
    // This is the blindness stated as a property rather than as a story: over
    // the old fixture set, `toLookupKey` and the pre-library rule return the
    // same string for every input. A suite built on them cannot fail when the
    // parsed branch breaks, because it never observes a difference between the
    // branch that broke and the branch that did not.
    for (const raw of LEGACY_555_FIXTURES) {
      expect({ raw, key: toLookupKey(raw) }).toEqual({ raw, key: legacyDigitKey(raw.trim()) });
    }

    // Stated once as a whole-set claim, so the contrast with the corpus above is
    // a single readable line: 0 of 11 there, 31 of 31 here.
    const oldDistinguishing = LEGACY_555_FIXTURES.filter(
      (raw) => toLookupKey(raw) !== legacyDigitKey(raw.trim()),
    );
    const newDistinguishing = PARSEABLE.filter(
      (f) => toLookupKey(f.raw) !== legacyDigitKey(f.raw.trim()),
    );
    expect({ old: oldDistinguishing.length, corpus: newDistinguishing.length }).toEqual({
      old: 0,
      corpus: PARSEABLE.length,
    });
  });
});

describe("BACKLOG-2798 · the floor-7 matching-key derivation", () => {
  it("puts the floor at 7", () => {
    expect(MATCHING_DIGIT_FLOOR).toBe(7);
  });

  it("is a total law over the whole corpus, asserted as exact keys", () => {
    // `toMatchingKey` is `toLookupKey` above the floor and `""` below it, and
    // nothing else. Asserted over every fixture rather than over a chosen few,
    // so a rule that held for the examples and not for the corpus goes red.
    for (const f of ALL_PHONE_FIXTURES) {
      const expected = digitCount(f.raw) >= MATCHING_DIGIT_FLOOR ? toLookupKey(f.raw) : "";
      expect({ raw: f.raw, matchingKey: toMatchingKey(f.raw) }).toEqual({
        raw: f.raw,
        matchingKey: expected,
      });
    }
  });

  it("sweeps digit counts 1..12 rather than sampling either side", () => {
    // One value per side of a threshold cannot catch an off-by-one. Every rung
    // is present and the verdict is the EXACT key, never truthiness.
    const byDigits = new Map<number, PhoneFixture[]>();
    for (const f of FLOOR_BOUNDARY) {
      byDigits.set(f.digits, [...(byDigits.get(f.digits) ?? []), f]);
    }

    expect([...byDigits.keys()].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);

    for (const f of FLOOR_BOUNDARY) {
      expect({ raw: f.raw, digits: f.digits, matchingKey: toMatchingKey(f.raw) }).toEqual({
        raw: f.raw,
        digits: f.digits,
        matchingKey: f.matchingKey,
      });
    }

    // The two rungs either side of the floor, named, so the boundary is not
    // merely implied by a list.
    expect(toMatchingKey("555010")).toBe(""); // 6 digits
    expect(toMatchingKey("5550109")).toBe("5550109"); // 7 digits
  });

  it("counts the RAW digits, so the verdict cannot hinge on parseability", () => {
    // Same six digits, three punctuations: all below the floor. Same seven
    // digits, three punctuations: all at it.
    for (const raw of ["555010", "(555) 010", "555-010"]) {
      expect({ raw, matchingKey: toMatchingKey(raw) }).toEqual({ raw, matchingKey: "" });
    }
    for (const raw of ["5550109", "555-0109", "(555) 0109"]) {
      expect({ raw, matchingKey: toMatchingKey(raw) }).toEqual({ raw, matchingKey: "5550109" });
    }

    // And a ten-digit value produces a matching key on BOTH branches — the
    // parsed one (an 11-digit key from 10 raw digits) and the fallback one.
    expect(toMatchingKey("4155550109")).toBe("14155550109");
    expect(toMatchingKey("0525550123")).toBe("0525550123");
  });

  it("agrees with toLookupKey for every at-or-above-floor value, on both branches", () => {
    for (const f of ALL_PHONE_FIXTURES.filter((x) => digitCount(x.raw) >= MATCHING_DIGIT_FLOOR)) {
      expect({ raw: f.raw, matchingKey: toMatchingKey(f.raw) }).toEqual({
        raw: f.raw,
        matchingKey: toLookupKey(f.raw),
      });
    }
  });
});

describe("BACKLOG-2754 · the floor is over matching keys ONLY — the key layer has none", () => {
  it("keeps a lookup key for every below-floor value that carries digits", () => {
    // The half BACKLOG-2754 says fails if the floor is ever moved into
    // `toLookupKey`: short codes are legitimate `phone_last_message` rows
    // (BACKLOG-1493), and an empty key makes the contact-search needle `'%%'`,
    // matching every row on file. This is the tripwire on that whole class.
    const belowFloor = ALL_PHONE_FIXTURES.filter(
      (f) => digitCount(f.raw) > 0 && digitCount(f.raw) < MATCHING_DIGIT_FLOOR,
    );

    expect(belowFloor.length).toBeGreaterThan(5);

    for (const f of belowFloor) {
      expect({ raw: f.raw, matchingKey: toMatchingKey(f.raw) }).toEqual({ raw: f.raw, matchingKey: "" });
      expect({ raw: f.raw, empty: toLookupKey(f.raw) === "" }).toEqual({ raw: f.raw, empty: false });
    }
  });

  it("never empties a lookup key for a digit run of any length 1..12", () => {
    for (let digits = 1; digits <= 12; digits += 1) {
      const query = "5".repeat(digits);
      expect({ digits, key: toLookupKey(query) }).not.toEqual({ digits, key: "" });
    }
  });
});
