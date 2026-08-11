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
 * THE CORPUS SWEEPS BRANCHES AND BOUNDARIES, IT DOES NOT SAMPLE THEM
 * ===========================================================================
 * `formatPhoneNumber` has six outcomes and they are selected by DIGIT COUNT, so
 * one input per branch cannot catch an off-by-one. Digit counts 0..14 are all
 * present, both with and without a leading "+", which is the other selector.
 *
 * Phone-shaped fixtures stay inside the NANP range reserved for fiction
 * (555-0100..555-0199) wherever a full ten digits are used; the shorter and
 * longer shapes are digit runs, not dialable numbers.
 */

import { formatPhoneNumber, toLookupKey } from "../phoneNormalization";

/** Every input shape. Grouped only so a failure names which branch broke. */
const CORPUS: Array<{ group: string; values: string[] }> = [
  {
    group: "US 11-digit with leading 1 — the '+1 (XXX) XXX-XXXX' branch",
    values: ["+15555550112", "15555550112", "1 (555) 555-0112", "+1-555-555-0199"],
  },
  {
    group: "US 10-digit — the '(XXX) XXX-XXXX' branch",
    values: ["5555550112", "(555) 555-0112", "555.555.0100", "555 555 0199"],
  },
  {
    group: "7-digit local — the 'XXX-XXXX' branch",
    values: ["5550112", "555-0112", "555 0199"],
  },
  {
    group: "international — the '+<digits>' branch",
    values: ["+50664103686", "+44 20 7946 0958", "+861234567890123", "+12"],
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
    expect(formatPhoneNumber("+50664103686")).toBe("+50664103686");
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
});
