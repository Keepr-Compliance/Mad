/**
 * Tests for TransactionCard component and utility functions
 */

import { formatCommunicationCounts } from "../TransactionCard";

describe("formatCommunicationCounts", () => {
  describe("email only (text is zero)", () => {
    it("shows plural for multiple emails with zero texts", () => {
      expect(formatCommunicationCounts(5, 0)).toBe("5 emails, 0 Texts");
    });

    it("shows singular for one email with zero texts", () => {
      expect(formatCommunicationCounts(1, 0)).toBe("1 email, 0 Texts");
    });
  });

  describe("text only (email is zero)", () => {
    it("shows plural for multiple texts with zero emails", () => {
      expect(formatCommunicationCounts(0, 3)).toBe("0 emails, 3 Texts");
    });

    it("shows singular for one text with zero emails", () => {
      expect(formatCommunicationCounts(0, 1)).toBe("0 emails, 1 Text");
    });
  });

  describe("both email and text", () => {
    it("shows both counts when both exist", () => {
      expect(formatCommunicationCounts(8, 4)).toBe("8 emails, 4 Texts");
    });

    it("handles singular correctly for both", () => {
      expect(formatCommunicationCounts(1, 1)).toBe("1 email, 1 Text");
    });

    it("handles mixed singular/plural", () => {
      expect(formatCommunicationCounts(1, 5)).toBe("1 email, 5 Texts");
      expect(formatCommunicationCounts(3, 1)).toBe("3 emails, 1 Text");
    });
  });

  describe("no communications (both zero)", () => {
    it("shows zero counts for both when both are zero", () => {
      expect(formatCommunicationCounts(0, 0)).toBe("0 emails, 0 Texts");
    });
  });

  describe("edge cases", () => {
    it("handles large numbers", () => {
      expect(formatCommunicationCounts(100, 50)).toBe("100 emails, 50 Texts");
    });
  });
});
