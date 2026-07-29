/**
 * Unit tests for enhancedExportService date filtering
 * TASK-1143: Verify PDF exports filter messages by transaction date range
 * BACKLOG-2343: The audit-window end must be INCLUSIVE of the whole closing day.
 *
 * These tests exercise the REAL `_filterCommunicationsByDate` on the singleton
 * (via a typed cast) rather than a hand-copied mirror, so the export bug that
 * dropped an in-window text (Audit Summary read "TOTAL TEXT MESSAGES: 0") is
 * guarded against for real.
 */
import type { Communication } from "../../types/models";

// enhancedExportService (→ folderExportService → databaseService) only needs
// electron's `app` mocked at import time; the DB layer is auto-mocked via the
// jest moduleNameMapper. Mirrors exportSecurityService.test.ts.
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/test-downloads"),
  },
}));

import enhancedExportService from "../enhancedExportService";

// `_filterCommunicationsByDate` is private; access it through a typed cast so we
// test the shipping implementation directly.
type FilterByDate = (
  communications: Communication[],
  startDate?: string,
  endDate?: string,
) => Communication[];

const filterByDate: FilterByDate = (
  enhancedExportService as unknown as {
    _filterCommunicationsByDate: FilterByDate;
  }
)._filterCommunicationsByDate.bind(enhancedExportService);

describe("EnhancedExportService Date Filtering", () => {
  // Sample communications for testing (all at 10:00Z on their day)
  const createCommunication = (id: string, date: string): Communication =>
    ({
      id,
      sent_at: date,
      subject: `Email ${id}`,
      sender: "test@example.com",
      recipients: "recipient@example.com",
      communication_type: "email",
    }) as Communication;

  const sampleCommunications: Communication[] = [
    createCommunication("1", "2024-01-01T10:00:00Z"), // Before range
    createCommunication("2", "2024-01-15T10:00:00Z"), // Start of range
    createCommunication("3", "2024-02-01T10:00:00Z"), // In range
    createCommunication("4", "2024-02-15T10:00:00Z"), // In range
    createCommunication("5", "2024-03-01T10:00:00Z"), // End of range
    createCommunication("6", "2024-03-15T10:00:00Z"), // After range
  ];

  describe("_filterCommunicationsByDate", () => {
    it("should return all communications when no dates are provided", () => {
      const result = filterByDate(sampleCommunications, undefined, undefined);
      expect(result).toHaveLength(6);
      expect(result).toEqual(sampleCommunications);
    });

    it("should filter communications before start date", () => {
      const result = filterByDate(sampleCommunications, "2024-01-15", undefined);
      // Should exclude communication #1 (2024-01-01)
      expect(result).toHaveLength(5);
      expect(result.map((c) => c.id)).toEqual(["2", "3", "4", "5", "6"]);
    });

    it("should INCLUDE messages sent on the end date (inclusive closing day)", () => {
      // BACKLOG-2343: end date "2024-03-01" now covers ALL of March 1st, so the
      // 2024-03-01T10:00Z message (#5) is kept. Callers pass the transaction's
      // closed_at directly; they no longer need to pass "the day after".
      const result = filterByDate(sampleCommunications, undefined, "2024-03-01");
      expect(result.map((c) => c.id)).toEqual(["1", "2", "3", "4", "5"]);
      expect(result.find((c) => c.id === "5")).toBeDefined();
    });

    it("should filter communications outside date range (both dates)", () => {
      const result = filterByDate(sampleCommunications, "2024-01-15", "2024-03-01");
      // Excludes #1 (before start) and #6 (after end). #5 (on the end day) stays.
      expect(result.map((c) => c.id)).toEqual(["2", "3", "4", "5"]);
    });

    it("should include communications exactly on start date", () => {
      const result = filterByDate(sampleCommunications, "2024-01-15", "2024-03-15");
      // Communication #2 is on 2024-01-15 and should be included
      expect(result.find((c) => c.id === "2")).toBeDefined();
    });

    it("should include a message on the end date even at a later time of day", () => {
      // BACKLOG-2343 core regression: previously "2024-03-15" (midnight UTC)
      // EXCLUDED the 2024-03-15T10:00Z message. It must now be INCLUDED.
      const result = filterByDate(sampleCommunications, "2024-01-01", "2024-03-15");
      expect(result.find((c) => c.id === "6")).toBeDefined();
    });

    it("should still exclude messages sent after the end date", () => {
      // End "2024-03-14" -> inclusive through end of the 14th; #6 (03-15) excluded.
      const result = filterByDate(sampleCommunications, "2024-01-01", "2024-03-14");
      expect(result.find((c) => c.id === "6")).toBeUndefined();
      expect(result.map((c) => c.id)).toEqual(["1", "2", "3", "4", "5"]);
    });

    it("BACKLOG-2343: keeps a text sent late on the closing day in a UTC-negative timezone", () => {
      // Founder repro: text sent Jul 28 ~11:30pm America/Chicago (UTC-5) is
      // stored as 2026-07-29T04:30Z. Audit window Jan 1 - Jul 29 2026. Before the
      // fix this was dropped and the Audit Summary showed 0 texts.
      const inWindowText = createCommunication("t", "2026-07-29T04:30:00Z");
      const result = filterByDate([inWindowText], "2026-01-01", "2026-07-29");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t");
    });

    it("falls back to received_at when sent_at is missing", () => {
      // Parity with the folder-export handler: a message missing sent_at must not
      // be silently dropped (a naive new Date(null) => 1970 => excluded).
      const noSentAt = {
        id: "r",
        sent_at: undefined,
        received_at: "2024-02-10T10:00:00Z",
        communication_type: "sms",
      } as unknown as Communication;
      const result = filterByDate([noSentAt], "2024-01-01", "2024-03-01");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("r");
    });

    it("should handle empty communications array", () => {
      const result = filterByDate([], "2024-01-15", "2024-03-01");
      expect(result).toHaveLength(0);
    });

    it("should handle start date only with empty result", () => {
      // Start date after all communications
      const result = filterByDate(sampleCommunications, "2024-12-01", undefined);
      expect(result).toHaveLength(0);
    });

    it("should handle end date only with empty result", () => {
      // End date before all communications (even after the inclusive +1 day)
      const result = filterByDate(sampleCommunications, undefined, "2023-01-01");
      expect(result).toHaveLength(0);
    });

    it("should handle ISO date strings with time component", () => {
      const result = filterByDate(
        sampleCommunications,
        "2024-01-15T00:00:00Z",
        "2024-03-01T23:59:59Z",
      );
      // Excludes #1 (before) and #6 (2024-03-15, after). #2..#5 stay.
      expect(result.map((c) => c.id)).toEqual(["2", "3", "4", "5"]);
    });
  });
});

describe("ExportOptions date parameters", () => {
  it("should accept startDate and endDate in options interface", () => {
    // This is a type test - verifying the interface accepts these fields
    interface ExportOptions {
      contentType?: "text" | "email" | "both";
      exportFormat?: "pdf" | "excel" | "csv" | "json" | "txt_eml";
      startDate?: string;
      endDate?: string;
    }

    const options: ExportOptions = {
      exportFormat: "pdf",
      startDate: "2024-01-15",
      endDate: "2024-03-01",
    };

    expect(options.startDate).toBe("2024-01-15");
    expect(options.endDate).toBe("2024-03-01");
  });
});
