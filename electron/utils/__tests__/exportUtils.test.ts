/**
 * @jest-environment node
 */

/**
 * Tests for exportUtils contact resolution functions.
 * TASK-2288: Verifies that contact names are properly resolved for both
 * phone numbers and email handles during export.
 */


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
  formatLocalDate,
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

describe("formatLocalDate — BACKLOG-2190 local-time formatting for real instants", () => {
  it("renders the LOCAL calendar day of an instant, diverging from formatDate (UTC) across a day boundary", () => {
    // 03:24 UTC on 2026-07-22 is still 2026-07-21 in any timezone at least ~4h
    // behind UTC (e.g. PDT = UTC-7, where it is 20:24 on the 21st) — the exact
    // moment the founder pressed export. This is what BUG B mis-rendered.
    const instant = new Date("2026-07-22T03:24:00.000Z");

    // The UTC formatter always reports the UTC day.
    expect(formatDate(instant)).toBe("July 22, 2026");

    // The local formatter reports whatever the runner's local day is. On a
    // behind-UTC runner (offset > 0) that is July 21 — proving the two
    // formatters diverge and that "Generated on" now tracks local time.
    const localDay = formatLocalDate(instant);
    if (instant.getTimezoneOffset() > 0) {
      expect(localDay).toBe("July 21, 2026");
      expect(localDay).not.toBe(formatDate(instant));
    } else {
      // Ahead-of/at-UTC runners: local day is July 22, matching UTC here. Still
      // assert the local formatter produces a well-formed day and never forces
      // UTC of its own accord (regression guard against re-adding timeZone).
      expect(localDay).toMatch(/^[A-Z][a-z]+ \d{1,2}, 2026$/);
    }
  });

  it("matches the machine's own toLocaleDateString (no UTC override applied)", () => {
    const instant = new Date("2026-07-22T03:24:00.000Z");
    const expectedLocal = instant.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(formatLocalDate(instant)).toBe(expectedLocal);
  });

  it("returns N/A for null/undefined", () => {
    expect(formatLocalDate(null)).toBe("N/A");
    expect(formatLocalDate(undefined)).toBe("N/A");
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
          phone_e164: "+15555550112",
          phone_display: "(555) 555-0112",
          display_name: "Morgan Reed",
        },
      ]);

      const result = getContactNamesByPhones(["+15555550112"]);

      expect(result["5555550112"]).toBe("Morgan Reed");
      expect(result["+15555550112"]).toBe("Morgan Reed");
    });

    it("handles multiple phone numbers", () => {
      mockDbAll.mockReturnValue([
        {
          phone_e164: "+15555550112",
          phone_display: "(555) 555-0112",
          display_name: "Morgan Reed",
        },
        {
          phone_e164: "+15555550121",
          phone_display: "555-555-0121",
          display_name: "John Doe",
        },
      ]);

      const result = getContactNamesByPhones(["+15555550112", "+15555550121"]);

      expect(result["5555550112"]).toBe("Morgan Reed");
      expect(result["5555550121"]).toBe("John Doe");
    });

    it("handles database errors gracefully", () => {
      mockDbAll.mockImplementation(() => {
        throw new Error("Database not initialized");
      });

      const result = getContactNamesByPhones(["+15555550112"]);
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
          display_name: "Morgan Reed",
        },
      ]);

      const result = getContactNamesByEmails(["madison@gmail.com"]);

      expect(result["madison@gmail.com"]).toBe("Morgan Reed");
    });

    it("handles case-insensitive email lookup", () => {
      mockDbAll.mockReturnValue([
        {
          email: "madison@gmail.com",
          display_name: "Morgan Reed",
        },
      ]);

      const result = getContactNamesByEmails(["Madison@Gmail.com"]);

      // Should store under both lowercase and original case
      expect(result["madison@gmail.com"]).toBe("Morgan Reed");
      expect(result["Madison@Gmail.com"]).toBe("Morgan Reed");
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
            phone_e164: "+15555550112",
            phone_display: "(555) 555-0112",
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
        "+15555550112",
        "email@example.com",
      ]);

      expect(result["5555550112"]).toBe("Phone Contact");
      expect(result["email@example.com"]).toBe("Email Contact");
    });

    it("handles mixed handles with some unresolved", () => {
      // Phone query returns a match
      mockDbAll
        .mockReturnValueOnce([
          {
            phone_e164: "+15555550112",
            phone_display: "",
            display_name: "Known Contact",
          },
        ])
        // Email query returns no matches
        .mockReturnValueOnce([]);

      const result = getContactNamesByHandles([
        "+15555550112",
        "unknown@nowhere.com",
      ]);

      expect(result["5555550112"]).toBe("Known Contact");
      expect(result["unknown@nowhere.com"]).toBeUndefined();
    });

    it("skips empty and whitespace-only handles", () => {
      mockDbAll.mockReturnValue([]);

      getContactNamesByHandles(["", "  ", "+15555550112"]);

      // Should still call dbAll for the one valid phone
      expect(mockDbAll).toHaveBeenCalled();
    });

    it("resolves all participant types for export", () => {
      // Simulates the real export scenario: a mix of phone numbers and email handles
      // from extractParticipantHandles output
      mockDbAll
        .mockReturnValueOnce([
          {
            phone_e164: "+15555550112",
            phone_display: "(555) 555-0112",
            display_name: "Morgan Reed",
          },
          {
            phone_e164: "+15555550121",
            phone_display: "555-555-0121",
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
        "+15555550112",
        "+15555550121",
        "paul@icloud.com",
      ];

      const result = getContactNamesByHandles(handles);

      expect(result["5555550112"]).toBe("Morgan Reed");
      expect(result["5555550121"]).toBe("John Doe");
      expect(result["paul@icloud.com"]).toBe("Paul Johnson");
    });
  });
});
