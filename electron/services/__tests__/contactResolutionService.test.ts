/**
 * Unit tests for contactResolutionService
 * Tests normalizePhone handles both phone numbers and email addresses correctly.
 *
 * TASK-2027: Verifies the fix for email handles being destroyed by digit-only stripping.
 * Previously, "quincypoe@example.com" would become "" (empty string) because
 * .replace(/\D/g, '') strips all non-digit characters including @ and letters.
 *
 * The email fixtures below deliberately contain NO digits: that is the property
 * that made the old digit-only strip collapse them to "".
 */

import { normalizePhone } from "../contactResolutionService";

describe("contactResolutionService", () => {
  describe("normalizePhone", () => {
    it("should return email addresses as lowercase without stripping characters", () => {
      expect(normalizePhone("quincypoe@example.com")).toBe("quincypoe@example.com");
    });

    it("should lowercase email addresses for case-insensitive matching", () => {
      expect(normalizePhone("QuincyPoe@Example.COM")).toBe("quincypoe@example.com");
    });

    it("should strip non-digit characters from phone numbers and take last 10 digits", () => {
      expect(normalizePhone("+12065550142")).toBe("2065550142");
    });

    it("should return 10-digit phone numbers unchanged", () => {
      expect(normalizePhone("1234567890")).toBe("1234567890");
    });

    it("should preserve short phone numbers as-is (fewer than 10 digits)", () => {
      expect(normalizePhone("123")).toBe("123");
    });

    it("should handle formatted phone numbers with dashes and spaces", () => {
      expect(normalizePhone("(206) 555-0142")).toBe("2065550142");
    });

    it("should handle 11-digit numbers by taking last 10", () => {
      expect(normalizePhone("12065550142")).toBe("2065550142");
    });
  });
});
