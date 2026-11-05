/**
 * Message Matching Service Tests
 * Tests for phone normalization and message-contact matching logic.
 *
 * @see TASK-977
 * @see BACKLOG-4039 / BACKLOG-3984 (auto-link path removed; control C2 below)
 */

import {
  normalizePhone,
  phonesMatch,
} from "../messageMatchingService";

describe("messageMatchingService", () => {
  describe("normalizePhone", () => {
    it("normalizes 10-digit US phone numbers", () => {
      expect(normalizePhone("4155550102")).toBe("+14155550102");
      expect(normalizePhone("415-555-0102")).toBe("+14155550102");
      expect(normalizePhone("(415) 555-0102")).toBe("+14155550102");
      expect(normalizePhone("415.555.0102")).toBe("+14155550102");
      expect(normalizePhone("415 555 0102")).toBe("+14155550102");
    });

    it("normalizes 11-digit US phone numbers with country code", () => {
      expect(normalizePhone("14155550102")).toBe("+14155550102");
      expect(normalizePhone("1-415-555-0102")).toBe("+14155550102");
      expect(normalizePhone("+14155550102")).toBe("+14155550102");
      expect(normalizePhone("+1 (415) 555-0102")).toBe("+14155550102");
    });

    it("normalizes international phone numbers", () => {
      expect(normalizePhone("+442079460123")).toBe("+442079460123");
      expect(normalizePhone("+44 20 7946 0123")).toBe("+442079460123");
      expect(normalizePhone("442079460123")).toBe("+442079460123");
    });

    it("returns null for empty/null/undefined/no-digit input", () => {
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
      expect(normalizePhone("")).toBeNull();
      expect(normalizePhone("abc")).toBeNull();
    });

    it("BACKLOG-1729: short codes (1-9 digits) now return E.164-ish '+digits' (not null)", () => {
      // Previously this function returned null for <10-digit inputs.
      // The consolidated toE164 emits "+digits" for any positive digit count.
      // Audited consumers (autoLinkService, internal callers) only ever
      // build their phoneToContact maps from phone_e164 columns (≥10 digits),
      // so a non-null short-code result here cannot cause a false match.
      expect(normalizePhone("123")).toBe("+123");
      expect(normalizePhone("12345")).toBe("+12345");
    });

    it("handles edge cases", () => {
      // Leading zeros are preserved as they indicate international format
      expect(normalizePhone("04155550102")).toBe("+04155550102");
      // Numbers with extensions: all digits are kept, treated as international (>10 digits)
      expect(normalizePhone("4155550102 ext 123")).toBe("+4155550102123");
    });

    it("preserves email handles unchanged (lowercased)", () => {
      expect(normalizePhone("user@icloud.com")).toBe("user@icloud.com");
    });

    it("lowercases email handles", () => {
      expect(normalizePhone("User@ICLOUD.COM")).toBe("user@icloud.com");
    });

    it("preserves complex email handles", () => {
      expect(normalizePhone("madison.jones+tag@gmail.com")).toBe(
        "madison.jones+tag@gmail.com",
      );
    });
  });

  describe("phonesMatch", () => {
    it("matches identical normalized phone numbers", () => {
      expect(phonesMatch("+14155550102", "+14155550102")).toBe(true);
      expect(phonesMatch("+442079460123", "+442079460123")).toBe(true);
    });

    it("matches phone numbers in different formats", () => {
      expect(phonesMatch("(415) 555-0102", "+14155550102")).toBe(true);
      expect(phonesMatch("415-555-0102", "1-415-555-0102")).toBe(true);
      expect(phonesMatch("4155550102", "+1 (415) 555-0102")).toBe(true);
    });

    it("returns false for different phone numbers", () => {
      expect(phonesMatch("+14155550102", "+14155550001")).toBe(false);
      expect(phonesMatch("4155550102", "5105550000")).toBe(false);
    });

    it("returns false for invalid phone numbers", () => {
      expect(phonesMatch(null, "+14155550102")).toBe(false);
      expect(phonesMatch("+14155550102", null)).toBe(false);
      expect(phonesMatch(null, null)).toBe(false);
      expect(phonesMatch("", "+14155550102")).toBe(false);
      expect(phonesMatch("123", "+14155550102")).toBe(false);
    });
  });
});

// ============================================
// BACKLOG-4039 / BACKLOG-3984 — CONTROL C2
// ============================================
// The deal-level auto-link path (texts + emails, behind the IPC channel
// `transactions:auto-link-texts`) had no caller in src/ and its email half read
// columns `messages` has never had. It was removed, not repaired: live email
// auto-linking is autoLinkService, on the `emails` table. These assertions go
// red if any removed export comes back, under its name or on the default object.
describe("BACKLOG-4039/3984 C2 — the removed auto-link path stays removed", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const service = require("../messageMatchingService") as Record<string, unknown> & {
    default: Record<string, unknown>;
  };
  const sqlModule = require("../db/messageMatchingSql") as Record<string, unknown>;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const REMOVED_FUNCTIONS = [
    "autoLinkAllToTransaction",
    "autoLinkTextsToTransaction",
    "autoLinkEmailsToTransaction",
    "findEmailsByAddresses",
  ];
  // filterEmailMatchesByAddress was never exported, so no runtime lookup can see
  // it; its removal is proven by type-check and lint, not here.
  const REMOVED_SQL = [
    "EMAIL_CHANNEL_CANDIDATES_SQL",
    "TRANSACTION_ADDRESS_SQL",
    "ignoredEmailsByExternalIdSql",
    "claimMessagesForTransactionSql085",
    "claimMessagesForTransactionSql09",
    "TRANSACTION_TEXT_WINDOW_SQL",
    "MESSAGE_THREAD_ID_SQL",
    "messageBodiesSql",
  ];

  it.each(REMOVED_FUNCTIONS)("messageMatchingService does not export %s", (name) => {
    expect(typeof service[name]).toBe("undefined");
    expect(typeof service.default[name]).toBe("undefined");
  });

  it.each(REMOVED_SQL)("messageMatchingSql does not export %s", (name) => {
    expect(typeof sqlModule[name]).toBe("undefined");
  });

  it("the kept helpers are still exported (positive control for the lookups above)", () => {
    for (const name of ["normalizePhone", "phonesMatch", "createCommunicationReferenceSync", "findTextMessagesByPhones"]) {
      expect(typeof service[name]).toBe("function");
    }
    expect(typeof sqlModule.TRANSACTION_CONTACT_EMAILS_SQL).not.toBe("undefined");
    expect(typeof sqlModule.messagesForPhoneMatchingSql).toBe("function");
  });
});
