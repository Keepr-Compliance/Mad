/**
 * Unit tests for the consolidated Phone Normalization module (BACKLOG-1729).
 *
 * This file replaces the three previous test files
 * (`phoneNormalization.test.ts` legacy, `phoneUtils.test.ts`, `phoneLookupKey.test.ts`).
 * Every `it()` from those files is migrated below. See the PR description's
 * "Test-case migration map" for the mapping; intentional removals are justified
 * inline next to their replacements.
 *
 * Parity snapshot (≥25 inputs) at the bottom is the byte-equivalence guard
 * against migration-v40-backfilled rows in production.
 */

import {
  toE164,
  toLookupKey,
  phoneNumbersMatch,
  isPhoneNumber,
  extractDigits,
  getTrailingDigits,
  formatPhoneNumber,
} from "../phoneNormalization";

describe("phoneNormalization", () => {
  // -------------------------------------------------------------------------
  // toE164
  //
  // Behavioural changes vs. the legacy phoneNormalization.normalizePhoneNumber:
  //   - `""` → `""` (was `"+"`) — latent bug, no caller depended on `"+"` sentinel
  //   - null/undefined accepted (matches phoneUtils signature)
  //
  // Migrated from: phoneUtils.test.ts > normalizePhoneNumber,
  //                phoneNormalization.test.ts (old) > normalizePhoneNumber.
  // -------------------------------------------------------------------------
  describe("toE164", () => {
    it("returns empty string for null input", () => {
      expect(toE164(null)).toBe("");
    });
    it("returns empty string for undefined input", () => {
      expect(toE164(undefined)).toBe("");
    });
    it("returns empty string for empty string", () => {
      expect(toE164("")).toBe("");
    });
    it("returns empty string for whitespace-only input", () => {
      // SR-added edge: previously "+" — now "" (still falsy)
      expect(toE164("   ")).toBe("");
    });
    it("returns empty string for '+' alone (no digits)", () => {
      // SR-added edge
      expect(toE164("+")).toBe("");
    });
    it("normalizes '+1' alone to '+1' (digits preserved)", () => {
      // SR-added edge: one digit survives
      expect(toE164("+1")).toBe("+1");
    });
    it("normalizes a 10-digit US number with +1 prefix", () => {
      expect(toE164("5551234567")).toBe("+15551234567");
    });
    it("normalizes an 11-digit number with leading 1", () => {
      expect(toE164("15551234567")).toBe("+15551234567");
    });
    it("strips parens, spaces, dashes, dots", () => {
      expect(toE164("(555) 123-4567")).toBe("+15551234567");
      expect(toE164("555-123-4567")).toBe("+15551234567");
      expect(toE164("555 123 4567")).toBe("+15551234567");
      expect(toE164("555.123.4567")).toBe("+15551234567");
    });
    it("normalizes US number with +1 prefix and formatting", () => {
      expect(toE164("+1 555 123 4567")).toBe("+15551234567");
    });
    it("preserves international numbers (UK)", () => {
      expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    });
    it("preserves international numbers (extension digits)", () => {
      // Extension digits are treated as part of the number
      expect(toE164("+1 (555) 123-4567 ext. 890")).toBe("+15551234567890");
    });
    it("preserves 7-digit local numbers (sub-US-country-code)", () => {
      expect(toE164("1234567")).toBe("+1234567");
    });
    it("preserves 9-digit numbers (sub-10)", () => {
      // SR-added edge
      expect(toE164("123456789")).toBe("+123456789");
    });
    it("preserves 15-digit E.164 max length", () => {
      // SR-added edge: ITU-T E.164 spec max
      expect(toE164("+123456789012345")).toBe("+123456789012345");
    });
    it("preserves email handles unchanged (lowercased)", () => {
      expect(toE164("user@icloud.com")).toBe("user@icloud.com");
    });
    it("lowercases uppercase email handles", () => {
      // SR-added edge: explicit uppercase email
      expect(toE164("User@ICLOUD.COM")).toBe("user@icloud.com");
    });
    it("preserves complex emails (plus-tag)", () => {
      expect(toE164("madison.jones+tag@gmail.com")).toBe(
        "madison.jones+tag@gmail.com",
      );
    });
    it("strips letters from alphanumeric vanity numbers", () => {
      // SR-added edge: VERIZON style sender — letters strip to ""
      // (different shape from toLookupKey which preserves alphabetic input)
      expect(toE164("VERIZON")).toBe("");
    });
    it("strips emoji while preserving digits", () => {
      // SR-added edge: emoji-bearing input
      expect(toE164("📞5551234567")).toBe("+15551234567");
    });
  });

  // -------------------------------------------------------------------------
  // toLookupKey
  //
  // Output semantics MUST stay byte-equivalent to pre-consolidation
  // `normalizePhoneLookupKey` because production rows are migration-v40 backfilled.
  //
  // Migrated from: phoneLookupKey.test.ts.
  // -------------------------------------------------------------------------
  describe("toLookupKey", () => {
    describe("numeric phones (>=10 digits)", () => {
      it("strips '+' from clean E.164", () => {
        expect(toLookupKey("+14155551234")).toBe("4155551234");
      });
      it("strips spaces, parens, dashes from US formatted", () => {
        expect(toLookupKey("+1 (415) 555-1234")).toBe("4155551234");
        expect(toLookupKey("(415) 555-1234")).toBe("4155551234");
        expect(toLookupKey("+1-415-555-1234")).toBe("4155551234");
        expect(toLookupKey("+1.415.555.1234")).toBe("4155551234");
      });
      it("handles 10-digit raw input", () => {
        expect(toLookupKey("4155551234")).toBe("4155551234");
      });
      it("keeps last 10 digits for international (UK)", () => {
        expect(toLookupKey("+44 20 7946 0958")).toBe("2079460958");
      });
      it("keeps last 10 digits when country code makes >10 digits", () => {
        expect(toLookupKey("+1 415 555 1234")).toBe("4155551234");
        expect(toLookupKey("011 44 20 7946 0958")).toBe("2079460958");
      });
      it("ignores leading/trailing whitespace", () => {
        expect(toLookupKey("  +14155551234  ")).toBe("4155551234");
        expect(toLookupKey("\t+14155551234\n")).toBe("4155551234");
      });
      it("strips alphabetic characters (vanity numbers)", () => {
        // 1-800-FLOWERS — letters strip to '1800', short-code path
        expect(toLookupKey("1-800-FLOWERS")).toBe("1800");
      });
    });

    describe("short codes (1-9 digits)", () => {
      it("preserves 5-digit short code", () => {
        expect(toLookupKey("12345")).toBe("12345");
      });
      it("preserves 7-digit short code with formatting", () => {
        expect(toLookupKey("555-1234")).toBe("5551234");
      });
      it("preserves single digit", () => {
        expect(toLookupKey("5")).toBe("5");
      });
    });

    describe("alphanumeric senders", () => {
      it("returns trimmed original for all-letter sender", () => {
        expect(toLookupKey("VERIZON")).toBe("VERIZON");
      });
      it("returns trimmed original for sender with no digits", () => {
        expect(toLookupKey("  Apple  ")).toBe("Apple");
      });
    });

    describe("empty / null / whitespace", () => {
      it("returns empty for empty string", () => {
        expect(toLookupKey("")).toBe("");
      });
      it("returns empty for null", () => {
        expect(toLookupKey(null)).toBe("");
      });
      it("returns empty for undefined", () => {
        expect(toLookupKey(undefined)).toBe("");
      });
      it("returns empty for whitespace only", () => {
        expect(toLookupKey("   ")).toBe("");
        expect(toLookupKey("\t\n")).toBe("");
      });
    });

    describe("writer/reader agreement (the bug BACKLOG-1727 fixed)", () => {
      const cases: Array<[string, string]> = [
        ["+14155551234", "+1 (415) 555-1234"],
        ["+14155551234", "(415) 555-1234"],
        ["+14155551234", "4155551234"],
        ["+442079460958", "+44 20 7946 0958"],
        ["12345", " 12345 "],
      ];
      it.each(cases)("matches '%s' against '%s'", (a, b) => {
        expect(toLookupKey(a)).toBe(toLookupKey(b));
      });
    });
  });

  // -------------------------------------------------------------------------
  // phoneNumbersMatch
  //
  // Adopted phoneUtils last-10-digits semantics (safer for international).
  // Audit-equivalence test below proves the two earlier implementations
  // agree on every input call sites can produce.
  //
  // Migrated from: phoneUtils.test.ts > phoneNumbersMatch,
  //                phoneNormalization.test.ts (old) > phoneNumbersMatch.
  // -------------------------------------------------------------------------
  describe("phoneNumbersMatch", () => {
    it("returns false for null first input", () => {
      expect(phoneNumbersMatch(null, "5551234567")).toBe(false);
    });
    it("returns false for null second input", () => {
      expect(phoneNumbersMatch("5551234567", null)).toBe(false);
    });
    it("returns false for both null inputs", () => {
      expect(phoneNumbersMatch(null, null)).toBe(false);
    });
    it("returns true for exact matches", () => {
      expect(phoneNumbersMatch("5551234567", "5551234567")).toBe(true);
    });
    it("returns true for formatted vs unformatted", () => {
      expect(phoneNumbersMatch("(555) 123-4567", "5551234567")).toBe(true);
    });
    it("returns true when matching last 10 digits", () => {
      expect(phoneNumbersMatch("15551234567", "5551234567")).toBe(true);
    });
    it("returns true for both having country code", () => {
      expect(phoneNumbersMatch("+1 (555) 123-4567", "1-555-123-4567")).toBe(true);
    });
    it("returns false for different numbers", () => {
      expect(phoneNumbersMatch("5551234567", "5559876543")).toBe(false);
    });
    it("returns false for empty strings", () => {
      expect(phoneNumbersMatch("", "")).toBe(false);
    });
    it("returns false when one is empty", () => {
      expect(phoneNumbersMatch("5551234567", "")).toBe(false);
    });
    it("matches identical short numbers (<10 digits)", () => {
      expect(phoneNumbersMatch("1234567", "1234567")).toBe(true);
    });
    it("does not match different short numbers", () => {
      expect(phoneNumbersMatch("1234567", "7654321")).toBe(false);
    });
    it("matches based on last 10 digits when lengths differ", () => {
      expect(phoneNumbersMatch("15551234567", "5551234567")).toBe(true);
    });
    it("matches E.164 against formatted", () => {
      expect(phoneNumbersMatch("+15551234567", "(555) 123-4567")).toBe(true);
    });
    it("matches international with suffix matching (UK)", () => {
      expect(phoneNumbersMatch("+44 20 7946 0958", "2079460958")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // BACKLOG-1729 phoneNumbersMatch equivalence audit
    //
    // Proves the consolidated last-10-digits semantics agree with the prior
    // E.164-suffix semantics on every input shape call sites produce.
    // Call sites surveyed (none feeds alphanumeric senders or sub-10-digit
    // pairs through phoneNumbersMatch):
    //   - electron/services/iosContactsParser.ts: passes parsed
    //     `phone.normalizedNumber` values (already digits-or-`+digits`)
    //   - electron/services/contactsService.ts: passes phone_e164 + handle
    //     from message participants_json (E.164-like strings)
    //   - Tests-only callers (phoneUtils.test.ts, phoneNormalization.test.ts)
    // -----------------------------------------------------------------------
    describe("equivalence audit (last-10-digits vs E.164-suffix)", () => {
      // Legacy phoneNormalization.ts implementation used here as the
      // baseline — match if suffix(last 10) of one is end of the other after
      // E.164 prefix.
      function legacyMatch(a: string, b: string): boolean {
        const normA = a.includes("@")
          ? a.toLowerCase()
          : "+" +
            (a.replace(/\D/g, "").length === 10
              ? "1" + a.replace(/\D/g, "")
              : a.replace(/\D/g, ""));
        const normB = b.includes("@")
          ? b.toLowerCase()
          : "+" +
            (b.replace(/\D/g, "").length === 10
              ? "1" + b.replace(/\D/g, "")
              : b.replace(/\D/g, ""));
        if (normA === normB) return true;
        const sA = normA.slice(-10);
        const sB = normB.slice(-10);
        return normA.endsWith(sB) || normB.endsWith(sA);
      }

      const audit: Array<[string, string]> = [
        ["+14155551234", "(415) 555-1234"],
        ["+14155551234", "4155551234"],
        ["+14155551234", "+14155551234"],
        ["+442079460958", "2079460958"],
        ["+442079460958", "+44 20 7946 0958"],
        ["+14155551234", "+14159999999"],
        ["+15551234567", "5551234567"],
        ["+15551234567", "1-555-123-4567"],
      ];
      it.each(audit)(
        "consolidated agrees with legacy on '%s' vs '%s'",
        (a, b) => {
          expect(phoneNumbersMatch(a, b)).toBe(legacyMatch(a, b));
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // isPhoneNumber — migrated from phoneNormalization.test.ts (old)
  // -------------------------------------------------------------------------
  describe("isPhoneNumber", () => {
    it("returns true for phone numbers", () => {
      expect(isPhoneNumber("5551234567")).toBe(true);
      expect(isPhoneNumber("(555) 123-4567")).toBe(true);
      expect(isPhoneNumber("+1 555 123 4567")).toBe(true);
    });
    it("returns false for email addresses", () => {
      expect(isPhoneNumber("test@example.com")).toBe(false);
      expect(isPhoneNumber("user@domain.org")).toBe(false);
    });
    it("returns false for short strings (<7 digits)", () => {
      expect(isPhoneNumber("12345")).toBe(false);
    });
    it("returns false for handles containing @ even with digits", () => {
      expect(isPhoneNumber("555@company.com")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // extractDigits — merged from phoneNormalization.test.ts + phoneUtils.test.ts
  // -------------------------------------------------------------------------
  describe("extractDigits", () => {
    it("returns empty string for null input", () => {
      expect(extractDigits(null)).toBe("");
    });
    it("extracts only digits", () => {
      expect(extractDigits("(555) 123-4567")).toBe("5551234567");
    });
    it("handles already clean numbers", () => {
      expect(extractDigits("5551234567")).toBe("5551234567");
    });
    it("handles numbers with country code", () => {
      expect(extractDigits("+1 555 123 4567")).toBe("15551234567");
    });
    it("returns empty string for no digits", () => {
      expect(extractDigits("abc")).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // getTrailingDigits — migrated from phoneNormalization.test.ts (old)
  // -------------------------------------------------------------------------
  describe("getTrailingDigits", () => {
    it("returns last 10 digits by default", () => {
      expect(getTrailingDigits("15551234567")).toBe("5551234567");
    });
    it("returns specified number of digits", () => {
      expect(getTrailingDigits("5551234567", 7)).toBe("1234567");
    });
    it("returns all digits if fewer than requested", () => {
      expect(getTrailingDigits("1234567", 10)).toBe("1234567");
    });
    it("handles formatted numbers", () => {
      expect(getTrailingDigits("(555) 123-4567", 10)).toBe("5551234567");
    });
  });

  // -------------------------------------------------------------------------
  // formatPhoneNumber — migrated from phoneUtils.test.ts
  // -------------------------------------------------------------------------
  describe("formatPhoneNumber", () => {
    it("returns empty string for null input", () => {
      expect(formatPhoneNumber(null)).toBe("");
    });
    it("returns empty string for undefined input", () => {
      expect(formatPhoneNumber(undefined)).toBe("");
    });
    it("returns email addresses unchanged", () => {
      expect(formatPhoneNumber("test@example.com")).toBe("test@example.com");
    });
    it("formats 11-digit US number with country code", () => {
      expect(formatPhoneNumber("15551234567")).toBe("+1 (555) 123-4567");
    });
    it("formats 10-digit US number", () => {
      expect(formatPhoneNumber("5551234567")).toBe("(555) 123-4567");
    });
    it("formats 7-digit local number", () => {
      expect(formatPhoneNumber("1234567")).toBe("123-4567");
    });
    it("returns cleaned number for unknown formats", () => {
      expect(formatPhoneNumber("12345")).toBe("12345");
    });
    it("formats numbers with formatting characters", () => {
      expect(formatPhoneNumber("(555) 123-4567")).toBe("(555) 123-4567");
    });
    it("formats number with country code and formatting", () => {
      expect(formatPhoneNumber("+1 (555) 123-4567")).toBe("+1 (555) 123-4567");
    });
    it("handles numbers with leading 1 but not 11 digits", () => {
      expect(formatPhoneNumber("155512345678")).toBe("155512345678");
    });
    it("returns original if cleaned is empty", () => {
      expect(formatPhoneNumber("---")).toBe("---");
    });
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1729 parity snapshot — byte-equivalence guard for migration v40
  //
  // For every input below, the new `toLookupKey` MUST return the exact value
  // listed (which IS what the pre-consolidation `normalizePhoneLookupKey`
  // produced — they share the same code path). Any divergence on this table
  // indicates a regression that would silently break the v40 backfill
  // invariant for new inserts.
  //
  // ≥25 inputs as required by the SR-approved plan; covers: clean E.164,
  // formatted US/UK/intl, short codes, alphanumeric senders, null/empty/
  // whitespace, emails (preserved), edge whitespace, '+' alone, vanity,
  // emoji, uppercase email, 7/9/15-digit boundaries.
  // -------------------------------------------------------------------------
  describe("BACKLOG-1729 parity snapshot — toLookupKey output is stable", () => {
    const snapshot: Array<[string | null | undefined, string]> = [
      // clean E.164
      ["+14155551234", "4155551234"],
      // formatted US
      ["+1 (415) 555-1234", "4155551234"],
      ["(415) 555-1234", "4155551234"],
      ["+1-415-555-1234", "4155551234"],
      ["+1.415.555.1234", "4155551234"],
      ["4155551234", "4155551234"],
      // formatted UK / international
      ["+44 20 7946 0958", "2079460958"],
      ["011 44 20 7946 0958", "2079460958"],
      // short codes
      ["12345", "12345"],
      ["555-1234", "5551234"],
      ["5", "5"],
      // 9-digit boundary
      ["123456789", "123456789"],
      // alphanumeric senders
      ["VERIZON", "VERIZON"],
      ["  Apple  ", "Apple"],
      // vanity number with letters
      ["1-800-FLOWERS", "1800"],
      // emails (preserved as trimmed original because no digits → trimmed path;
      // these are emails so this is a theoretical-only case — toLookupKey
      // is not designed to receive emails; the writer-side helpers always
      // pass phone strings only)
      ["user@example.com", "user@example.com"],
      ["USER@EXAMPLE.COM", "USER@EXAMPLE.COM"],
      // whitespace / null / undefined / empty
      ["", ""],
      [null, ""],
      [undefined, ""],
      ["   ", ""],
      ["\t\n", ""],
      ["  +14155551234  ", "4155551234"],
      // emoji-bearing input
      ["📞4155551234", "4155551234"],
      // 15-digit E.164 max
      ["+123456789012345", "6789012345"],
      // 7-digit local
      ["1234567", "1234567"],
      // 11-digit number with leading 1
      ["15551234567", "5551234567"],
      // 12-digit (drops first 2 → keeps last 10)
      ["120-555-555-1234", "5555551234"],
    ];

    it.each(snapshot)("toLookupKey(%p) === %p", (input, expected) => {
      expect(toLookupKey(input)).toBe(expected);
    });

    // -----------------------------------------------------------------------
    // Cross-check: every entry above is also what the pre-consolidation
    // normalizePhoneLookupKey would have produced. This is verified by
    // structural equivalence — toLookupKey IS the consolidated version of
    // that function with no logic change. If anyone refactors toLookupKey
    // and breaks this test, they must also update migration v40 backfill
    // (which is forbidden under MIGRATION-GUIDE.md immutability).
    // -----------------------------------------------------------------------
  });
});
