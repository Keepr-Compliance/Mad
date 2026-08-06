/**
 * @jest-environment node
 */

/**
 * Tests for getEarliestCommunicationDate (TASK-1974)
 * Tests the query logic for auto-detecting audit start dates
 * from earliest email/message communications for given contacts.
 */

import { getEarliestCommunicationDate } from "../transactionService";

// Mock dbGet and dbAll from dbConnection
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
}));

// Mock all other transactionService dependencies to prevent import errors
jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../logService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(),
}));
jest.mock("../messageMatchingService", () => ({
  createCommunicationReference: jest.fn(),
  normalizePhone: jest.fn(),
}));
jest.mock("../autoLinkService", () => ({
  autoLinkCommunicationsForContact: jest.fn(),
}));
jest.mock("../db/emailDbService", () => ({
  createEmail: jest.fn(),
  getEmailByExternalId: jest.fn(),
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn(),
}));
jest.mock("../db/externalContactDbService", () => ({}));
jest.mock("../extraction/hybridExtractorService", () => ({
  HybridExtractorService: jest.fn(),
}));
jest.mock("../extraction/extractionStrategyService", () => ({
  ExtractionStrategyService: jest.fn(),
  ExtractionStrategy: {},
}));
jest.mock("../llm/llmConfigService", () => ({
  LLMConfigService: jest.fn(),
}));

describe("getEarliestCommunicationDate", () => {
  const mockUserId = "user-123";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return null when contactIds is empty", () => {
    const result = getEarliestCommunicationDate([], mockUserId);
    expect(result).toBeNull();
    expect(mockDbAll).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it("should return null when contactIds is not provided", () => {
    const result = getEarliestCommunicationDate(
      null as unknown as string[],
      mockUserId,
    );
    expect(result).toBeNull();
  });

  it("should return earliest email date when only emails exist", () => {
    // Contact has emails but no phones
    mockDbAll
      .mockReturnValueOnce([{ email: "client@example.com" }]) // contact_emails
      .mockReturnValueOnce([]); // contact_phones (none)

    // Email query returns a date
    mockDbGet.mockReturnValueOnce({ earliest: "2024-06-15T10:00:00Z" });

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBe("2024-06-15T10:00:00Z");
    // Should have queried for contact emails and phones
    expect(mockDbAll).toHaveBeenCalledTimes(2);
    // Should have queried for earliest email (no message query since no phones)
    expect(mockDbGet).toHaveBeenCalledTimes(1);
  });

  it("should return earliest message date when only messages exist", () => {
    // Contact has phones but no emails
    mockDbAll
      .mockReturnValueOnce([]) // contact_emails (none)
      .mockReturnValueOnce([{ phone_e164: "+14155550102" }]); // contact_phones

    // Message query returns a date
    mockDbGet.mockReturnValueOnce({ earliest: "2024-03-20T08:30:00Z" });

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBe("2024-03-20T08:30:00Z");
  });

  it("should return the earlier of email and message dates", () => {
    // Contact has both emails and phones
    mockDbAll
      .mockReturnValueOnce([{ email: "client@example.com" }]) // contact_emails
      .mockReturnValueOnce([{ phone_e164: "+14155550102" }]); // contact_phones

    // Email is earlier than message
    mockDbGet
      .mockReturnValueOnce({ earliest: "2024-01-10T12:00:00Z" }) // email
      .mockReturnValueOnce({ earliest: "2024-06-15T08:00:00Z" }); // message

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBe("2024-01-10T12:00:00Z");
  });

  it("should return the earlier message when message is before email", () => {
    mockDbAll
      .mockReturnValueOnce([{ email: "client@example.com" }])
      .mockReturnValueOnce([{ phone_e164: "+14155550102" }]);

    // Message is earlier than email
    mockDbGet
      .mockReturnValueOnce({ earliest: "2024-06-15T08:00:00Z" }) // email
      .mockReturnValueOnce({ earliest: "2024-01-10T12:00:00Z" }); // message

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBe("2024-01-10T12:00:00Z");
  });

  it("should return null when no communications found for contacts", () => {
    // Contact has emails and phones, but no matching communications
    mockDbAll
      .mockReturnValueOnce([{ email: "nobody@example.com" }])
      .mockReturnValueOnce([{ phone_e164: "+10000000000" }]);

    // Both queries return null earliest
    mockDbGet
      .mockReturnValueOnce({ earliest: null })
      .mockReturnValueOnce({ earliest: null });

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBeNull();
  });

  it("should handle multiple contacts", () => {
    // Two contacts with different emails and phones
    mockDbAll
      .mockReturnValueOnce([
        { email: "alice@example.com" },
        { email: "bob@example.com" },
      ])
      .mockReturnValueOnce([
        { phone_e164: "+14155550001" },
        { phone_e164: "+14155550002" },
      ]);

    mockDbGet
      .mockReturnValueOnce({ earliest: "2024-03-01T00:00:00Z" })
      .mockReturnValueOnce({ earliest: "2024-05-01T00:00:00Z" });

    const result = getEarliestCommunicationDate(
      ["contact-1", "contact-2"],
      mockUserId,
    );

    expect(result).toBe("2024-03-01T00:00:00Z");

    // Should have used placeholders for both contact IDs
    expect(mockDbAll.mock.calls[0][1]).toEqual(["contact-1", "contact-2"]);
  });

  it("should handle contacts with no emails and no phones gracefully", () => {
    mockDbAll
      .mockReturnValueOnce([]) // no emails
      .mockReturnValueOnce([]); // no phones

    const result = getEarliestCommunicationDate(
      ["contact-1"],
      mockUserId,
    );

    expect(result).toBeNull();
    // Should not have run any queries
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it("should normalize phone numbers by stripping non-digits", () => {
    mockDbAll
      .mockReturnValueOnce([]) // no emails
      .mockReturnValueOnce([{ phone_e164: "+1-415-555-0102" }]);

    mockDbGet.mockReturnValueOnce({ earliest: "2024-04-01T00:00:00Z" });

    getEarliestCommunicationDate(["contact-1"], mockUserId);

    // The phone number should be normalized (non-digits stripped)
    // in the SQL query params: "14155550102"
    const messageQueryParams = mockDbGet.mock.calls[0][1];
    expect(messageQueryParams).toContain("14155550102");
  });
});
