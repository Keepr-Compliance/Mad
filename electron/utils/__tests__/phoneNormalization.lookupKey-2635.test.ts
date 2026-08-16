/**
 * @jest-environment node
 *
 * BACKLOG-2635 — a phone stored without its country code never matches the
 * same number stored with one.
 *
 * ===========================================================================
 * THE TWO DEFECTS THIS FILE PINS THE FIX FOR
 * ===========================================================================
 * The pre-fix rule was:
 *
 *     if (digits.length >= 10) return digits.slice(-10);
 *     return digits;                       // under 10: kept whole
 *
 * 1. SHORT KEYS NEVER MEET LONG ONES. An Israeli landline stored domestically
 *    ("03-555-0121" → "035550121") and the same line stored E.164
 *    ("+972 3 555 0121" → old key "7235550121") produced different keys and
 *    were invisible to each other. 54 of the 61 affected values in the
 *    founder's book are this exact 9-digit Israeli shape.
 *
 * 2. slice(-10) MANGLED LONG COUNTRY CODES. "+97235550121" is 11 digits; the
 *    old key dropped the leading "9" and produced "7235550121" — a key that
 *    corresponds to no real number and that COLLIDES with the genuine NANP
 *    number (723) 555-0121.
 *
 * The new rule is DIGIT-SHAPE-ONLY (the "+" carries no information the digit
 * string does not), which is what keeps the BACKLOG-2620 invariant
 * `toLookupKey(formatPhoneNumber(p)) === toLookupKey(p)` true by construction:
 * formatPhoneNumber never adds, drops or reorders digits.
 *
 * ===========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT (control-1 deviation, declared)
 * ===========================================================================
 * The item's illustrative US pair — "555-0121" vs "+1 (503) 555-0121" — CANNOT
 * be given identical keys: the area code is simply not present in the 7-digit
 * input, and the only mechanism that would join them is suffix matching, which
 * the item body forbids ("Do NOT match on the last 7 digits" — a shared
 * 7-digit suffix across area codes is common and would trade this recall bug
 * for the false-merge class BACKLOG-2619 just removed). A 7-digit local
 * remains AMBIGUOUS-NOT-EQUAL: its key is its own digits, it matches only
 * itself, and surfacing it as a question is BACKLOG-2630's job. Pinned below.
 *
 * All fixtures use the reserved 555-01xx range embedded in synthetic
 * national/international shells; none is a dialable real number.
 */

import {
  DEFAULT_PHONE_REGIONS,
  toE164,
  toLookupKey,
  toLookupKeyForRegions,
} from "../phoneNormalization";

describe("BACKLOG-2635 defect 1 — domestic and E.164 forms of the same number share a key", () => {
  it("Israeli landline: 9-digit domestic ≡ E.164 (the 54-value population)", () => {
    const domestic = toLookupKey("03-555-0121"); // 035550121 — 9 digits, leading 0
    const e164 = toLookupKey("+972 3 555 0121"); // 97235550121 — 11 digits
    expect(domestic).toBe("97235550121");
    expect(e164).toBe("97235550121");
    expect(domestic).toBe(e164);
  });

  it("Israeli mobile: 10-digit 05x domestic ≡ E.164", () => {
    const domestic = toLookupKey("052-555-0123"); // 0525550123
    const e164 = toLookupKey("+972 52 555 0123"); // 972525550123 — 12 digits
    expect(domestic).toBe("972525550123");
    expect(e164).toBe("972525550123");
  });

  it("Israeli VoIP: 10-digit 07x domestic ≡ E.164 (07x included by decision — real IL range)", () => {
    expect(toLookupKey("072-555-0199")).toBe("972725550199");
    expect(toLookupKey("+972 72 555 0199")).toBe("972725550199");
  });

  it("US: every storage shape of one number folds to the historical 10-digit key (v40-stable)", () => {
    for (const form of [
      "5035550121",
      "(503) 555-0121",
      "1-503-555-0121",
      "15035550121",
      "+1 (503) 555-0121",
      "+15035550121",
    ]) {
      expect([form, toLookupKey(form)]).toEqual([form, "5035550121"]);
    }
  });
});

describe("BACKLOG-2635 defect 2 — country codes are kept, not sliced off", () => {
  it("keeps the full digit string for 11-digit non-NANP E.164", () => {
    // Old rule: slice(-10) = "7235550121" — dropped the 9, fabricated a key.
    expect(toLookupKey("+97235550121")).toBe("97235550121");
  });

  it("the fabricated key no longer collides with the genuine NANP number it used to shadow", () => {
    const israeli = toLookupKey("+97235550121"); // was "7235550121" pre-fix
    const nanp = toLookupKey("(723) 555-0121"); //  is  "7235550121"
    expect(nanp).toBe("7235550121");
    expect(israeli).not.toBe(nanp);
  });

  it("12-digit and longer international forms keep every digit", () => {
    expect(toLookupKey("+972525550123")).toBe("972525550123");
    expect(toLookupKey("+44 20 5550 0958")).toBe("442055500958");
    expect(toLookupKey("+123456789012345")).toBe("123456789012345"); // 15-digit E.164 max
  });

  it("international exit prefixes 011/00 fold onto the '+' form (pinned behavior preserved)", () => {
    expect(toLookupKey("011 972 3 555 0121")).toBe("97235550121"); // ≡ +972 form
    expect(toLookupKey("00 972 3 555 0121")).toBe("97235550121"); //  ≡ +972 form
    expect(toLookupKey("011 44 20 5550 0958")).toBe(toLookupKey("+44 20 5550 0958"));
  });
});

describe("BACKLOG-2635 — the toE164 write-path round trip", () => {
  /**
   * The persisted key is computed FROM phone_e164 (contactDbService:423) while
   * the matchers key from the RAW string (contactSourceLinker:321). toE164
   * prepends "1" to ANY 10-digit input — including the Israeli mobile
   * "0525550123", stored as "+10525550123" — so the 11-leading-1 branch must
   * strip the NANP code and RE-INTERPRET the remainder, or write-path and
   * read-path keys diverge for exactly the population this fix targets.
   */
  it("toLookupKey(toE164(x)) === toLookupKey(x) for every digit-bearing phone shape", () => {
    const corpus = [
      "5035550121",
      "(503) 555-0121",
      "15035550121",
      "+15035550121",
      "555-0121",
      "03-555-0121",
      "052-555-0123",
      "072-555-0199",
      "+972 3 555 0121",
      "+972 52 555 0123",
      "+44 20 5550 0958",
      "011 972 3 555 0121",
      "12345",
      "5",
    ];
    for (const x of corpus) {
      expect([x, toLookupKey(toE164(x))]).toEqual([x, toLookupKey(x)]);
    }
  });

  it("the Israeli mobile the founder's write path actually persists", () => {
    expect(toE164("052-555-0123")).toBe("+10525550123"); // toE164's US assumption, unchanged here
    expect(toLookupKey("+10525550123")).toBe("972525550123"); // …but the KEY recovers the number
  });
});

describe("BACKLOG-2635 — exact-key boundary sweep, digit lengths 3–15, with and without '+'", () => {
  /**
   * One input per branch cannot catch an off-by-one: every length crosses the
   * 8→9, 9→10, 10→11 and 11→12 selectors, for a leading digit that triggers
   * region folds (1, 0) and one that does not (9). Keys are asserted EXACTLY —
   * pairwise equality alone could pass with a rule that collapses everything.
   */
  const nine = (n: number) => "9".repeat(n);
  const leadOne = (n: number) => "1" + "5".repeat(n - 1);
  const leadZero = (n: number) => "0" + "3".repeat(n - 1);

  const expectations: Array<[string, string]> = [
    // lead-9 runs: never region-folded; ≤10 kept (unchanged), ≥11 kept WHOLE (was slice(-10))
    ...([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const).map(
      (n): [string, string] => [nine(n), nine(n)],
    ),
    // lead-1 runs: 11 digits folds the NANP country code; 12+ has no NANP shape → kept whole
    [leadOne(3), leadOne(3)],
    [leadOne(9), leadOne(9)],
    [leadOne(10), leadOne(10)],
    [leadOne(11), "5".repeat(10)],
    [leadOne(12), leadOne(12)],
    [leadOne(15), leadOne(15)],
    // lead-0 runs: exactly 9 digits is the IL national landline shape; other lengths are not
    [leadZero(3), leadZero(3)],
    [leadZero(8), leadZero(8)],
    [leadZero(9), "972" + "3".repeat(8)],
    [leadZero(10), leadZero(10)], // "03…" 10-digit is NOT an IL shape (05/07 gate) — kept whole
    [leadZero(11), leadZero(11)],
    // IL mobile/VoIP gate at exactly 10 digits
    ["0525550123", "972525550123"],
    ["0725550199", "972725550199"],
    // any 9-digit lead-0 run takes the IL-national reading, by shape rule —
    // real IL landline area codes are not enumerated; a garbage "05…" 9-digit
    // keys uniquely (real IL mobile keys are 12 digits) and merges with nothing
    ["052555012", "97252555012"],
  ];

  it.each(expectations)("toLookupKey(%p) === %p", (input, expected) => {
    expect(toLookupKey(input)).toBe(expected);
  });

  it("a '+' changes nothing the digits do not already say", () => {
    for (const [input, expected] of expectations) {
      expect([input, toLookupKey("+" + input)]).toEqual([input, expected]);
    }
  });

  it("exit-prefix thresholds: '011' needs ≥13 digits, '00' needs ≥12, both need ≥10 after the strip", () => {
    expect(toLookupKey("011" + "97235550121")).toBe("97235550121"); // 14 → stripped
    expect(toLookupKey("011" + "355501219")).toBe("011355501219"); // 12 → NOT an 011 strip
    expect(toLookupKey("00" + "9725255501234".slice(0, 10))).toBe("9725255501"); // 12 → stripped, 10 remain
    expect(toLookupKey("00" + "972525501")).toBe("00972525501"); // 11 → too short to strip → 11-digit non-NANP kept whole
  });
});

describe("BACKLOG-2635 — no false merges: what the old rule kept apart stays apart", () => {
  it("two different Israeli numbers", () => {
    expect(toLookupKey("03-555-0121")).not.toBe(toLookupKey("03-555-0122"));
    expect(toLookupKey("052-555-0123")).not.toBe(toLookupKey("052-555-0124"));
  });

  it("a US number and an Israeli number sharing their trailing seven digits", () => {
    const us = toLookupKey("(503) 555-0121"); //  5035550121
    const il = toLookupKey("+972 3 555 0121"); // 97235550121
    expect(us).toBe("5035550121");
    expect(il).toBe("97235550121");
    expect(us).not.toBe(il);
  });

  it("the 7-digit local stays ambiguous-not-equal (control-1 deviation, by the item's own rule)", () => {
    // "Do NOT match on the last 7 digits" — the area code is not in the input,
    // so these are DIFFERENT keys on purpose. BACKLOG-2630 turns this into ASK.
    expect(toLookupKey("555-0121")).toBe("5550121");
    expect(toLookupKey("555-0121")).not.toBe(toLookupKey("+1 (503) 555-0121"));
    expect(toLookupKey("555-0121")).not.toBe(toLookupKey("+1 (212) 555-0121"));
  });

  it("distinct 10-digit NANP numbers keep distinct keys (the 1,203-value population)", () => {
    expect(toLookupKey("(503) 555-0121")).not.toBe(toLookupKey("(212) 555-0121"));
  });
});

describe("BACKLOG-2635 — key algebra the persisted stores rely on", () => {
  const corpus = [
    "5035550121",
    "+15035550121",
    "15035550121",
    "555-0121",
    "03-555-0121",
    "0525550123",
    "+972 3 555 0121",
    "+972 52 555 0123",
    "011 972 3 555 0121",
    "+44 20 5550 0958",
    "12345",
    "VERIZON",
    "",
    "   ",
  ];

  it("idempotence: key(key(x)) === key(x) — stored keys re-normalize to themselves", () => {
    // externalContactDbService re-normalizes already-normalized keys; a rule
    // whose output is not a fixed point would corrupt on every round trip.
    for (const x of corpus) {
      const k = toLookupKey(x);
      expect([x, toLookupKey(k)]).toEqual([x, k]);
    }
  });

  it("totality: null/undefined/empty/no-digit behavior is byte-identical to the old rule", () => {
    expect(toLookupKey(null)).toBe("");
    expect(toLookupKey(undefined)).toBe("");
    expect(toLookupKey("")).toBe("");
    expect(toLookupKey("   ")).toBe("");
    expect(toLookupKey("VERIZON")).toBe("VERIZON");
    expect(toLookupKey("  Apple  ")).toBe("Apple");
    expect(toLookupKey("1-800-FLOWERS")).toBe("1800");
  });
});

describe("BACKLOG-2635 — the default-region assumption is explicit and overridable", () => {
  it("the default region set is US + IL, in that documented shape", () => {
    expect(DEFAULT_PHONE_REGIONS).toEqual(["US", "IL"]);
  });

  it("without IL, the Israeli national shapes are left as bare digit runs", () => {
    expect(toLookupKeyForRegions("03-555-0121", ["US"])).toBe("035550121");
    expect(toLookupKeyForRegions("052-555-0123", ["US"])).toBe("0525550123");
  });

  it("without US, the NANP country code is not folded", () => {
    expect(toLookupKeyForRegions("15035550121", ["IL"])).toBe("15035550121");
    expect(toLookupKeyForRegions("+15035550121", ["IL"])).toBe("15035550121");
  });

  it("toLookupKey stays unary — safe as a bare Array.map callback", () => {
    // phones.map(toLookupKey) is a real call shape in this codebase; an
    // optional regions parameter would receive the map INDEX (the
    // map(parseInt) trap). The override lives in toLookupKeyForRegions.
    expect(["03-555-0121", "052-555-0123"].map(toLookupKey)).toEqual([
      "97235550121",
      "972525550123",
    ]);
    expect(toLookupKey.length).toBe(1);
  });
});
