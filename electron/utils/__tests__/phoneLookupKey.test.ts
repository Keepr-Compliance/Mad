/**
 * @jest-environment node
 */

import { normalizePhoneLookupKey } from "../phoneLookupKey";

describe("normalizePhoneLookupKey", () => {
  describe("numeric phones (>=10 digits)", () => {
    it("strips '+' from clean E.164", () => {
      expect(normalizePhoneLookupKey("+14155551234")).toBe("4155551234");
    });

    it("strips spaces, parens, dashes from US formatted", () => {
      expect(normalizePhoneLookupKey("+1 (415) 555-1234")).toBe("4155551234");
      expect(normalizePhoneLookupKey("(415) 555-1234")).toBe("4155551234");
      expect(normalizePhoneLookupKey("+1-415-555-1234")).toBe("4155551234");
      expect(normalizePhoneLookupKey("+1.415.555.1234")).toBe("4155551234");
    });

    it("handles 10-digit raw input", () => {
      expect(normalizePhoneLookupKey("4155551234")).toBe("4155551234");
    });

    it("keeps last 10 digits for international (UK)", () => {
      expect(normalizePhoneLookupKey("+44 20 7946 0958")).toBe("2079460958");
    });

    it("keeps last 10 digits when country code makes >10 digits", () => {
      expect(normalizePhoneLookupKey("+1 415 555 1234")).toBe("4155551234");
      expect(normalizePhoneLookupKey("011 44 20 7946 0958")).toBe("2079460958");
    });

    it("ignores leading/trailing whitespace", () => {
      expect(normalizePhoneLookupKey("  +14155551234  ")).toBe("4155551234");
      expect(normalizePhoneLookupKey("\t+14155551234\n")).toBe("4155551234");
    });

    it("strips alphabetic characters (vanity numbers)", () => {
      // 1-800-FLOWERS — letters strip to '1800', short-code path
      expect(normalizePhoneLookupKey("1-800-FLOWERS")).toBe("1800");
    });
  });

  describe("short codes (1-9 digits)", () => {
    it("preserves 5-digit short code", () => {
      expect(normalizePhoneLookupKey("12345")).toBe("12345");
    });

    it("preserves 7-digit short code with formatting", () => {
      expect(normalizePhoneLookupKey("555-1234")).toBe("5551234");
    });

    it("preserves single digit", () => {
      expect(normalizePhoneLookupKey("5")).toBe("5");
    });
  });

  describe("alphanumeric senders", () => {
    it("returns trimmed original for all-letter sender", () => {
      expect(normalizePhoneLookupKey("VERIZON")).toBe("VERIZON");
    });

    it("returns trimmed original for sender with no digits", () => {
      expect(normalizePhoneLookupKey("  Apple  ")).toBe("Apple");
    });
  });

  describe("empty / null / whitespace", () => {
    it("returns empty for empty string", () => {
      expect(normalizePhoneLookupKey("")).toBe("");
    });

    it("returns empty for null", () => {
      expect(normalizePhoneLookupKey(null)).toBe("");
    });

    it("returns empty for undefined", () => {
      expect(normalizePhoneLookupKey(undefined)).toBe("");
    });

    it("returns empty for whitespace only", () => {
      expect(normalizePhoneLookupKey("   ")).toBe("");
      expect(normalizePhoneLookupKey("\t\n")).toBe("");
    });
  });

  describe("writer/reader agreement (the bug this fixes)", () => {
    // The whole point of this helper: messages-side and contacts-side
    // produce the SAME key for the SAME logical phone number, regardless
    // of how each side originally formatted it.
    const cases: Array<[string, string]> = [
      ["+14155551234", "+1 (415) 555-1234"], // clean vs US-formatted
      ["+14155551234", "(415) 555-1234"], // E.164 vs no-country-code
      ["+14155551234", "4155551234"], // E.164 vs digits-only
      ["+442079460958", "+44 20 7946 0958"], // UK clean vs spaced
      ["12345", " 12345 "], // short code padded
    ];

    it.each(cases)("matches '%s' against '%s'", (a, b) => {
      expect(normalizePhoneLookupKey(a)).toBe(normalizePhoneLookupKey(b));
    });
  });
});
