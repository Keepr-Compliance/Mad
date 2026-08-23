/**
 * @jest-environment node
 *
 * `formatPhoneNumber` PRESERVES THE LOOKUP KEY — the invariant that let
 * BACKLOG-2620 delete `autoLinkNameGuard`'s second phone arm.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT
 * ===========================================================================
 * `usableName` used to compare a candidate name against the record's phones
 * TWICE: once as a lookup key, and once as an exact match on
 * `formatPhoneNumber(phone)` — the string `buildContactLabel` writes into a
 * nameless record's name field. SR's re-review of PR #2274 deleted each arm
 * separately and measured: deleting the second left all 114 tests green.
 *
 * The arm is deleted, and this file is what makes that safe. It is NOT a pin on
 * the deleted code — nothing here mentions the guard's internals. It asserts the
 * one live property the deletion rests on:
 *
 *     toLookupKey(formatPhoneNumber(p).trim()) === toLookupKey(p)
 *
 * If that ever stops holding — the obvious way being a country-specific
 * regrouping in `formatPhoneNumber` that drops, pads or reorders digits — this
 * file goes red, and the message says what to do about it: the guard needs its
 * second arm back, because a baked label would then key differently from the
 * phone it was baked from and would read as a NAME.
 *
 * ===========================================================================
 * BACKLOG-2798 — THIS SUITE WAS BLIND TO THE PARSER, AND NOW IS NOT
 * ===========================================================================
 * `toLookupKey` has two branches: the library-parsed E.164 digits when
 * `parsePhoneNumberFromString(raw, "US").isValid()`, and `legacyDigitKey` —
 * the pre-library `slice(-10)` rule — for everything else.
 *
 * Every phone-shaped fixture this file used to own sat on NANP area code 555.
 * 555 is not assignable, so the library reports `isValid() === false` for all of
 * them and they take the fallback, always. Measured over the whole pre-2798
 * fixture set — 37 listed values plus the 60 generated digit runs:
 *
 *   - **59 of those 97 values carry no leading `+`, and ZERO of them parse.**
 *     That is the branch `DEFAULT_PHONE_REGION` governs, and the one a US
 *     user's own ten-digit number takes.
 *   - 3 values parse, all `+`-prefixed and all present for
 *     `formatPhoneNumber`'s international DISPLAY branch rather than for the
 *     parser: `+50664103686`, `+44 20 7946 0958`, `+861234567890123`. (The
 *     BACKLOG-2798 census records this file as having no parseable fixture at
 *     all; that is very nearly true and not exactly true, and the corrected
 *     measurement is written down here rather than left to be rediscovered.)
 *
 * So the invariant above was verified almost entirely on one side of a branch it
 * never named. It is now asserted over the shared corpus in
 * `fixtures/phoneCorpora.ts`, which reaches both — including 15 US and Canadian
 * spellings that parse WITHOUT a country code, the case with no representation
 * here before.
 *
 * **The invariant holds on both branches.** Probed across 55 values before this
 * migration was written: 0 breaks. This change widens the ground the property
 * stands on; it did not uncover a defect in `formatPhoneNumber`.
 *
 * The parse-coverage counts below are asserted, not narrated, so this file can
 * never quietly slide back into single-branch blindness.
 *
 * ===========================================================================
 * THE CORPUS SWEEPS BRANCHES AND BOUNDARIES, IT DOES NOT SAMPLE THEM
 * ===========================================================================
 * `formatPhoneNumber` has six outcomes and they are selected by DIGIT COUNT, so
 * one input per branch cannot catch an off-by-one. Digit counts 0..14 are all
 * present, both with and without a leading "+", which is the other selector.
 *
 * Phone-shaped fixtures stay inside ranges reserved for fiction (NANP 555-01xx
 * on a real area code, Ofcom, ARCEP, ACMA) or are labelled synthetic in the
 * corpus file; the shorter and longer shapes are digit runs, not dialable
 * numbers.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

import {
  DEFAULT_PHONE_REGION,
  formatPhoneNumber,
  legacyDigitKey,
  toLookupKey,
} from "../phoneNormalization";

import {
  CA_PARSEABLE,
  INTERNATIONAL_PARSEABLE,
  LEGACY_555_FIXTURES,
  PARSED_WITH_DIGITS_DROPPED,
  UNPARSEABLE_555,
  US_PARSEABLE,
  rawValues,
} from "./fixtures/phoneCorpora";

/** The branch selector, read from the library rather than inferred from keys. */
function reachesParser(raw: string): boolean {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_PHONE_REGION);
  return !!(parsed && parsed.isValid());
}

const parsedCount = (values: readonly string[]): number => values.filter(reachesParser).length;

/**
 * Every input shape. Grouped only so a failure names which branch broke.
 *
 * The first three groups are the BACKLOG-2798 corpus — the parsed branch, which
 * nothing here reached before. The 555 group is retained deliberately: it is a
 * legitimate unparseable class and removing it would stop testing the fallback.
 * What was wrong was never that 555 was present, only that it was alone.
 */
const CORPUS: Array<{ group: string; values: string[] }> = [
  {
    group: "US, parsed branch — real area codes, reserved 555-01xx line (BACKLOG-2798)",
    values: rawValues(US_PARSEABLE),
  },
  {
    group: "Canada, parsed branch — same +1, different country (BACKLOG-2798)",
    values: rawValues(CA_PARSEABLE),
  },
  {
    group: "international, parsed branch — GB / FR / AU / IL (BACKLOG-2798)",
    values: rawValues(INTERNATIONAL_PARSEABLE),
  },
  {
    group: "NANP area code 555 — unparseable, the fallback branch",
    values: rawValues(UNPARSEABLE_555),
  },
  {
    group: "7-digit local — the 'XXX-XXXX' branch",
    values: ["5550112", "555-0112", "555 0199"],
  },
  {
    group: "a parse that silently drops seven digits — retained from the pre-2798 corpus",
    values: rawValues(PARSED_WITH_DIGITS_DROPPED),
  },
  {
    group: "international, fallback branch — a '+' does not imply a parse",
    values: ["+12", "+44 7700 900123"],
  },
  {
    group: "bare digit runs with no '+' — the cleaned-digits fallback",
    values: ["12345", "1", "12", "123456", "123456789", "123456789012", "12345678901234"],
  },
  {
    group: "no digits at all — the original-string fallback",
    values: ["VERIZON", "AMAZON", "+ABC", "-", "a.b.c"],
  },
  {
    group: "mixed alphanumeric — digits are extracted, letters are not",
    values: ["ABC123", "1a2b3c", "x5550112y", "+ab5550112"],
  },
  {
    group: "email handles, which the phone list can legitimately carry",
    values: ["dana.reyes@example.com", "USER2024@example.org"],
  },
  {
    group: "whitespace and empty",
    values: ["", "   ", "\t", " 5555550112 "],
  },
];

/**
 * The boundary sweep. Digit counts 0..14, each with and without a leading "+",
 * so every branch selector is crossed in both directions rather than sampled.
 */
function digitRuns(): string[] {
  const out: string[] = [];
  for (let n = 0; n <= 14; n++) {
    // A run that starts with 1 and one that does not: the 11-digit branch is
    // selected by the FIRST DIGIT as well as by the length.
    const startingWithOne = "1" + "5".repeat(Math.max(0, n - 1));
    const startingWithNine = "9".repeat(n);
    for (const digits of [startingWithOne.slice(0, n), startingWithNine]) {
      out.push(digits);
      out.push("+" + digits);
    }
  }
  return out;
}

describe("formatPhoneNumber preserves toLookupKey — the invariant BACKLOG-2620's deletion rests on", () => {
  const all = [...CORPUS.flatMap((c) => c.values), ...digitRuns()];

  it.each(CORPUS)("$group", ({ values }) => {
    for (const p of values) {
      expect([p, toLookupKey(formatPhoneNumber(p).trim())]).toEqual([p, toLookupKey(p)]);
    }
  });

  it("digit-count boundaries 0..14, with and without a leading '+'", () => {
    for (const p of digitRuns()) {
      expect([p, toLookupKey(formatPhoneNumber(p).trim())]).toEqual([p, toLookupKey(p)]);
    }
  });

  /**
   * The corpus has to be able to FAIL, or the sweep above proves nothing.
   *
   * Two inputs whose formatted output is not their input — the regrouping
   * branches — must be present, otherwise every case is trivially
   * `format(p) === p` and a `formatPhoneNumber` that returned its argument
   * unchanged would pass the whole file.
   */
  it("the corpus actually exercises the regrouping branches", () => {
    const reformatted = all.filter((p) => formatPhoneNumber(p).trim() !== p.trim());
    expect(reformatted.length).toBeGreaterThan(10);
    expect(formatPhoneNumber("5555550112")).toBe("(555) 555-0112");
    expect(formatPhoneNumber("+15555550112")).toBe("+1 (555) 555-0112");
    expect(formatPhoneNumber("5550112")).toBe("555-0112");
    expect(formatPhoneNumber("+861234567890123")).toBe("+861234567890123");
    expect(formatPhoneNumber("VERIZON")).toBe("VERIZON");
  });

  /**
   * And the invariant is not vacuous in the other direction either: the keys it
   * compares are real keys, not a set of empty strings.
   */
  it("the invariant is asserted over non-empty keys, not over nothing", () => {
    const nonEmpty = all.filter((p) => toLookupKey(p).length > 0);
    expect(nonEmpty.length).toBeGreaterThan(40);
  });

  /**
   * =========================================================================
   * BACKLOG-2798 — THE PARSE-COVERAGE CONTROL
   * =========================================================================
   * The instrument is the library's own verdict, not a key comparison. A proxy
   * like `toLookupKey(v) !== legacyDigitKey(v)` reports "fallback" for any
   * country whose full E.164 digit string equals its own last ten, so it would
   * understate coverage in precisely the regions this corpus was added for.
   */
  it("the pre-2798 fixtures reached the parser ZERO times on the default-region path", () => {
    // The 555 fixtures this file used to own: not one of them parses.
    expect(parsedCount(LEGACY_555_FIXTURES)).toBe(0);

    // Nor does any generated digit run, in either polarity.
    expect(parsedCount(digitRuns())).toBe(0);

    // Those two lists contribute 39 values carrying no "+", and not one of
    // them parses. Across the file's ENTIRE pre-2798 fixture set the figure is
    // 59 of 97 — measured, and stated in the docblock; the subset asserted here
    // is the part this file can still compute now that the rest has migrated.
    const oldNoPlus = [...LEGACY_555_FIXTURES, ...digitRuns()].filter(
      (v) => !v.trim().startsWith("+"),
    );
    expect(oldNoPlus.length).toBe(39);
    expect(parsedCount(oldNoPlus)).toBe(0);
  });

  it("the corpus reaches it 29 times, 15 of them without a country code", () => {
    // Exact counts, not ">0": deleting parseable fixtures must be a red test
    // rather than a silent narrowing of what this file covers.
    expect(parsedCount(all)).toBe(29);

    const noCountryCode = all.filter((v) => reachesParser(v) && !v.trim().startsWith("+"));
    expect(noCountryCode.length).toBe(15);

    // The default region is what makes those 15 parse at all — without it the
    // library cannot even identify them, and each would fall to the old rule.
    for (const raw of noCountryCode) {
      expect({ raw, parsedWithoutRegion: parsePhoneNumberFromString(raw.trim(), undefined) }).toEqual({
        raw,
        parsedWithoutRegion: undefined,
      });
    }

    // And the parse is load-bearing ON THE KEY, not merely on the library's
    // opinion of the value. MEASURED CONTROL: replace `toLookupKey`'s parsed
    // branch with its fallback and these two lines go red — while the pre-2798
    // version of this file passed 12/12 with that same branch deleted. That gap
    // is the whole of BACKLOG-2798, stated as something that can fail.
    expect(toLookupKey("(415) 555-0109")).toBe("14155550109");
    expect(legacyDigitKey("(415) 555-0109")).toBe("4155550109");
  });

  it("and the invariant is asserted on BOTH branches, not just the one", () => {
    // The property this file exists for, restated per branch so neither can be
    // dropped without a failure naming which one went missing.
    const parsed = all.filter(reachesParser);
    const fallback = all.filter((v) => !reachesParser(v));

    expect(parsed.length).toBeGreaterThan(0);
    expect(fallback.length).toBeGreaterThan(0);

    for (const p of [...parsed, ...fallback]) {
      expect([p, toLookupKey(formatPhoneNumber(p).trim())]).toEqual([p, toLookupKey(p)]);
    }
  });
});
