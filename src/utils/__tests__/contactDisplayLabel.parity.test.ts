/**
 * @jest-environment node
 *
 * BACKLOG-2461 — the two copies of the contact display-label rule must agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO COPIES AT ALL
 * ---------------------------------------------------------------------------
 * `tsconfig.electron.json` sets `rootDir: "./electron"`, so nothing under
 * `electron/` may import from `src/` or `shared/` — the same constraint that
 * produced the two copies of `contactNameCompat.ts`. Importing the other way is
 * worse: the export path pulls in main-process modules that cannot exist in the
 * renderer bundle.
 *
 * So the rule is stated twice, and THIS FILE is what stops the two statements
 * drifting. A test file is not bundled, so it is the one place both copies can
 * be loaded at once and compared.
 *
 * The drift is not hypothetical — it is the whole of BACKLOG-2461. The contact
 * list said "Unknown Contact" and the audit PDF said "Unknown" for the SAME
 * condition, because the two surfaces each decided it alone. Two literals for
 * one condition is what a missing shared rule looks like from the outside.
 */

import {
  contactDisplayLabel as electronLabel,
  realContactName as electronRealName,
  NO_NAME_PLACEHOLDER as ELECTRON_PLACEHOLDER,
} from "../../../electron/utils/contactDisplayLabel";
import { formatPhoneNumber as electronFormatPhone } from "../../../electron/utils/phoneNormalization";
import {
  contactDisplayLabel as rendererLabel,
  realContactName as rendererRealName,
  NO_NAME_PLACEHOLDER as RENDERER_PLACEHOLDER,
} from "../contactDisplayLabel";
import { formatPhoneNumber as rendererFormatPhone } from "../phoneNormalization";

/**
 * `expected` is asserted too, not just parity — two copies that are identically
 * WRONG would agree perfectly, so agreement alone proves nothing.
 */
const LABEL_CASES: Array<{
  desc: string;
  parts: {
    name?: string | null;
    organization?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  expected: string;
}> = [
  // --- tier 1: the name ---
  { desc: "a name wins outright", parts: { name: "Jane Doe" }, expected: "Jane Doe" },
  {
    desc: "a name beats organisation, phone and email",
    parts: {
      name: "Jane Doe",
      organization: "Acme Realty",
      phone: "+14155550134",
      email: "jane@acme.com",
    },
    expected: "Jane Doe",
  },
  { desc: "a name is trimmed", parts: { name: "  Jane Doe  " }, expected: "Jane Doe" },

  // --- tier 2: organisation ---
  {
    desc: "no name falls to organisation",
    parts: { organization: "Acme Realty", phone: "+14155550134" },
    expected: "Acme Realty",
  },

  // --- tier 3: phone (the founder's headline case) ---
  {
    desc: "no name and no organisation falls to the formatted phone",
    parts: { phone: "+14155550134", email: "jane@acme.com" },
    expected: "+1 (415) 555-0134",
  },
  {
    desc: "a bare 10-digit US phone is formatted",
    parts: { phone: "4155550134" },
    expected: "(415) 555-0134",
  },
  {
    desc: "a NON-US number keeps its country code (Costa Rica, real founder data)",
    parts: { phone: "+50664103686" },
    expected: "+50664103686",
  },
  {
    desc: "a NON-US number is not mangled into a bare digit run (UK)",
    parts: { phone: "+442071838750" },
    expected: "+442071838750",
  },

  // --- tier 4: email ---
  {
    desc: "no name, organisation or phone falls to the email",
    parts: { email: "jane@acme.com" },
    expected: "jane@acme.com",
  },

  // --- tier 5: the placeholder ---
  {
    desc: "nothing at all yields the placeholder",
    parts: {},
    expected: "No name",
  },
  {
    desc: "whitespace-only fields are not values",
    parts: { name: "   ", organization: "  ", phone: "  ", email: "   " },
    expected: "No name",
  },
  {
    desc: "null and undefined are handled",
    parts: { name: null, organization: undefined, phone: null, email: undefined },
    expected: "No name",
  },

  // --- legacy sentinels: rows written before this change ---
  {
    desc: 'a persisted "Unknown" is not a name — the phone shows instead',
    parts: { name: "Unknown", phone: "+14155550134" },
    expected: "+1 (415) 555-0134",
  },
  {
    desc: 'a persisted "Unknown Contact" is not a name either',
    parts: { name: "Unknown Contact", phone: "+14155550134" },
    expected: "+1 (415) 555-0134",
  },
  {
    desc: "the sentinel match is case-insensitive and trimmed",
    parts: { name: "  uNkNoWn  ", email: "jane@acme.com" },
    expected: "jane@acme.com",
  },
  {
    desc: 'a REAL name containing "Unknown" is left alone',
    parts: { name: "Unknown Records LLC", phone: "+14155550134" },
    expected: "Unknown Records LLC",
  },
  {
    desc: "a sentinel with nothing to fall back to still yields the placeholder",
    parts: { name: "Unknown" },
    expected: "No name",
  },
];

const PHONE_CASES: Array<{ input: string | null | undefined; expected: string }> = [
  { input: "+14155550134", expected: "+1 (415) 555-0134" },
  { input: "4155550134", expected: "(415) 555-0134" },
  { input: "5550134", expected: "555-0134" },
  { input: "+50664103686", expected: "+50664103686" },
  { input: "+442071838750", expected: "+442071838750" },
  { input: "+33 6 12 34 56 78", expected: "+33612345678" },
  { input: "jane@acme.com", expected: "jane@acme.com" },
  { input: "", expected: "" },
  { input: null, expected: "" },
  { input: undefined, expected: "" },
];

describe("contactDisplayLabel — electron/renderer parity", () => {
  it("both copies name the same placeholder", () => {
    expect(ELECTRON_PLACEHOLDER).toBe("No name");
    expect(RENDERER_PLACEHOLDER).toBe(ELECTRON_PLACEHOLDER);
  });

  describe.each(LABEL_CASES)("$desc", ({ parts, expected }) => {
    it(`both copies return ${JSON.stringify(expected)}`, () => {
      expect(electronLabel(parts)).toBe(expected);
      expect(rendererLabel(parts)).toBe(expected);
    });
  });

  describe.each(PHONE_CASES)("formatPhoneNumber($input)", ({ input, expected }) => {
    it(`both copies return ${JSON.stringify(expected)}`, () => {
      expect(electronFormatPhone(input)).toBe(expected);
      expect(rendererFormatPhone(input)).toBe(expected);
    });
  });

  it("realContactName agrees on what counts as a name", () => {
    for (const candidate of [
      "Jane Doe",
      "  Jane Doe  ",
      "",
      "   ",
      "Unknown",
      "unknown contact",
      "Unknown Records LLC",
      null,
      undefined,
    ]) {
      expect(rendererRealName(candidate)).toBe(electronRealName(candidate));
    }
  });
});

/**
 * The founder's three cases, stated as the ticket states them, asserted on BOTH
 * surfaces' shared rule at once. If these ever diverge the bug is back.
 */
describe("BACKLOG-2461 acceptance — same chain, same strings, both surfaces", () => {
  it("a record with a phone and no name shows the formatted number", () => {
    const parts = { name: "", phone: "+14155550134" };
    expect(electronLabel(parts)).toBe("+1 (415) 555-0134");
    expect(rendererLabel(parts)).toBe(electronLabel(parts));
  });

  it("a record with an email and no name and no phone shows the email", () => {
    const parts = { name: "", email: "jane@acme.com" };
    expect(electronLabel(parts)).toBe("jane@acme.com");
    expect(rendererLabel(parts)).toBe(electronLabel(parts));
  });

  it('a record with neither shows "No name", identically', () => {
    const parts = { name: "" };
    expect(electronLabel(parts)).toBe("No name");
    expect(rendererLabel(parts)).toBe(electronLabel(parts));
    // The old bug in one line: two literals for one condition.
    expect(electronLabel(parts)).not.toBe("Unknown");
    expect(rendererLabel(parts)).not.toBe("Unknown Contact");
  });
});
