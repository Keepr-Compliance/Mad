/**
 * @jest-environment node
 */

/**
 * Tests for exportUtils contact resolution functions.
 * TASK-2288: Verifies that contact names are properly resolved for both
 * phone numbers and email handles during export.
 */

import { jest } from "@jest/globals";

// Mock the database layer
jest.mock("../../services/db/core/dbConnection", () => ({
  dbAll: jest.fn().mockReturnValue([]),
}));

// Mock the contactResolutionService
jest.mock("../../services/contactResolutionService", () => ({
  normalizePhone: jest.fn((phone: string) => {
    if (phone.includes("@")) return phone.toLowerCase();
    const digits = phone.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }),
}));

// Mock logService
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { dbAll } from "../../services/db/core/dbConnection";
import {
  getContactNamesByPhones,
  getContactNamesByEmails,
  getContactNamesByHandles,
  formatDate,
} from "../exportUtils";

const mockDbAll = dbAll as jest.MockedFunction<typeof dbAll>;

describe("formatDate — BACKLOG-2182 UTC date-only formatting", () => {
  it("formats a UTC-midnight date string to the correct calendar day, not the day before", () => {
    // A date-only value stored as UTC midnight. Without `timeZone: "UTC"`,
    // any machine west of UTC (e.g. America/* zones) would render Dec 31.
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("January 1, 2026");
    expect(formatDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("formats a UTC-midnight Date object to the correct calendar day", () => {
    expect(formatDate(new Date("2026-07-04T00:00:00Z"))).toBe("July 4, 2026");
  });

  it("returns N/A for null/undefined", () => {
    expect(formatDate(null)).toBe("N/A");
    expect(formatDate(undefined)).toBe("N/A");
  });
});

describe("exportUtils - contact resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getContactNamesByPhones", () => {
    it("returns empty object for empty input", () => {
      const result = getContactNamesByPhones([]);
      expect(result).toEqual({});
      expect(mockDbAll).not.toHaveBeenCalled();
    });

    it("resolves phone numbers to contact names", () => {
      mockDbAll.mockReturnValue([
        {
          phone_e164: "+15551234567",
          phone_display: "(555) 123-4567",
          display_name: "Madison Smith",
        },
      ]);

      const result = getContactNamesByPhones(["+15551234567"]);

      expect(result["5551234567"]).toBe("Madison Smith");
      expect(result["+15551234567"]).toBe("Madison Smith");
    });

    it("handles multiple phone numbers", () => {
      mockDbAll.mockReturnValue([
        {
          phone_e164: "+15551234567",
          phone_display: "(555) 123-4567",
          display_name: "Madison Smith",
        },
        {
          phone_e164: "+15559876543",
          phone_display: "555-987-6543",
          display_name: "John Doe",
        },
      ]);

      const result = getContactNamesByPhones(["+15551234567", "+15559876543"]);

      expect(result["5551234567"]).toBe("Madison Smith");
      expect(result["5559876543"]).toBe("John Doe");
    });

    it("handles database errors gracefully", () => {
      mockDbAll.mockImplementation(() => {
        throw new Error("Database not initialized");
      });

      const result = getContactNamesByPhones(["+15551234567"]);
      expect(result).toEqual({});
    });
  });

  describe("getContactNamesByEmails", () => {
    it("returns empty object for empty input", () => {
      const result = getContactNamesByEmails([]);
      expect(result).toEqual({});
      expect(mockDbAll).not.toHaveBeenCalled();
    });

    it("resolves email addresses to contact names", () => {
      mockDbAll.mockReturnValue([
        {
          email: "madison@gmail.com",
          display_name: "Madison Smith",
        },
      ]);

      const result = getContactNamesByEmails(["madison@gmail.com"]);

      expect(result["madison@gmail.com"]).toBe("Madison Smith");
    });

    it("handles case-insensitive email lookup", () => {
      mockDbAll.mockReturnValue([
        {
          email: "madison@gmail.com",
          display_name: "Madison Smith",
        },
      ]);

      const result = getContactNamesByEmails(["Madison@Gmail.com"]);

      // Should store under both lowercase and original case
      expect(result["madison@gmail.com"]).toBe("Madison Smith");
      expect(result["Madison@Gmail.com"]).toBe("Madison Smith");
    });

    it("handles database errors gracefully", () => {
      mockDbAll.mockImplementation(() => {
        throw new Error("Database not initialized");
      });

      const result = getContactNamesByEmails(["test@example.com"]);
      expect(result).toEqual({});
    });
  });

  describe("getContactNamesByHandles", () => {
    it("returns empty object for empty input", () => {
      const result = getContactNamesByHandles([]);
      expect(result).toEqual({});
    });

    it("partitions phones and emails correctly", () => {
      // First call for phones, second for emails
      mockDbAll
        .mockReturnValueOnce([
          {
            phone_e164: "+15551234567",
            phone_display: "(555) 123-4567",
            display_name: "Phone Contact",
          },
        ])
        .mockReturnValueOnce([
          {
            email: "email@example.com",
            display_name: "Email Contact",
          },
        ]);

      const result = getContactNamesByHandles([
        "+15551234567",
        "email@example.com",
      ]);

      expect(result["5551234567"]).toBe("Phone Contact");
      expect(result["email@example.com"]).toBe("Email Contact");
    });

    it("handles mixed handles with some unresolved", () => {
      // Phone query returns a match
      mockDbAll
        .mockReturnValueOnce([
          {
            phone_e164: "+15551234567",
            phone_display: "",
            display_name: "Known Contact",
          },
        ])
        // Email query returns no matches
        .mockReturnValueOnce([]);

      const result = getContactNamesByHandles([
        "+15551234567",
        "unknown@nowhere.com",
      ]);

      expect(result["5551234567"]).toBe("Known Contact");
      expect(result["unknown@nowhere.com"]).toBeUndefined();
    });

    it("skips empty and whitespace-only handles", () => {
      mockDbAll.mockReturnValue([]);

      getContactNamesByHandles(["", "  ", "+15551234567"]);

      // Should still call dbAll for the one valid phone
      expect(mockDbAll).toHaveBeenCalled();
    });

    it("resolves all participant types for export", () => {
      // Simulates the real export scenario: a mix of phone numbers and email handles
      // from extractParticipantHandles output
      mockDbAll
        .mockReturnValueOnce([
          {
            phone_e164: "+15551234567",
            phone_display: "(555) 123-4567",
            display_name: "Madison Smith",
          },
          {
            phone_e164: "+15559876543",
            phone_display: "555-987-6543",
            display_name: "John Doe",
          },
        ])
        .mockReturnValueOnce([
          {
            email: "paul@icloud.com",
            display_name: "Paul Johnson",
          },
        ]);

      const handles = [
        "+15551234567",
        "+15559876543",
        "paul@icloud.com",
      ];

      const result = getContactNamesByHandles(handles);

      expect(result["5551234567"]).toBe("Madison Smith");
      expect(result["5559876543"]).toBe("John Doe");
      expect(result["paul@icloud.com"]).toBe("Paul Johnson");
    });
  });
});
