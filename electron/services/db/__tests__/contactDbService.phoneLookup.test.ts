/**
 * @jest-environment node
 */

/**
 * Unit tests for Contact Phone Lookup
 * Tests the getContactNamesByPhones function which handles:
 * - Phone number normalization
 * - Multiple format lookups
 * - macOS Contacts fallback
 *
 * TASK-1405: Fix contact phone lookup normalization
 */


// Mock the core database connection
const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbAll: mockDbAll,
}));

// Mock logService
const mockLogService = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("../../logService", () => mockLogService);

// Mock contactsService for macOS Contacts fallback
const mockGetContactNames = jest.fn();
jest.mock("../../contactsService", () => ({
  getContactNames: mockGetContactNames,
}));

// Import after mocks are set up
import { getContactNamesByPhones } from "../contactDbService";

describe("contactDbService.getContactNamesByPhones", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no macOS contacts
    mockGetContactNames.mockResolvedValue({ contactMap: {} });
  });

  describe("basic phone lookup", () => {
    it("should return empty map for empty input", async () => {
      const result = await getContactNamesByPhones([]);
      expect(result.size).toBe(0);
      expect(mockDbAll).not.toHaveBeenCalled();
    });

    it("should return empty map when phones are too short", async () => {
      const result = await getContactNamesByPhones(["123", "456"]);
      expect(result.size).toBe(0);
      expect(mockDbAll).not.toHaveBeenCalled();
    });

    it("should lookup contact by 10-digit phone number", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "John Doe", phone: "+15551234567" },
      ]);

      const result = await getContactNamesByPhones(["5551234567"]);

      expect(result.get("5551234567")).toBe("John Doe");
      expect(mockDbAll).toHaveBeenCalled();
    });
  });

  describe("phone number normalization and multiple formats", () => {
    it("should store result by raw 10-digit format", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Jane Smith", phone: "+15559876543" },
      ]);

      const result = await getContactNamesByPhones(["+15559876543"]);

      // Should be stored by 10-digit format
      expect(result.get("5559876543")).toBe("Jane Smith");
    });

    it("should store result by +1 prefix E.164 format", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Jane Smith", phone: "+15559876543" },
      ]);

      const result = await getContactNamesByPhones(["+15559876543"]);

      // Should be stored by E.164 format with +1
      expect(result.get("+15559876543")).toBe("Jane Smith");
    });

    it("should store result by 11-digit format with 1 prefix", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Jane Smith", phone: "+15559876543" },
      ]);

      const result = await getContactNamesByPhones(["+15559876543"]);

      // Should be stored by 11-digit format
      expect(result.get("15559876543")).toBe("Jane Smith");
    });

    it("should handle lookup with different input format than stored", async () => {
      // Contact stored with +1 format
      mockDbAll.mockReturnValue([
        { display_name: "Bob Wilson", phone: "+15551112222" },
      ]);

      // Input as 10-digit
      const result = await getContactNamesByPhones(["5551112222"]);

      // Should still find the contact by multiple keys
      expect(result.get("5551112222")).toBe("Bob Wilson");
      expect(result.get("+15551112222")).toBe("Bob Wilson");
      expect(result.get("15551112222")).toBe("Bob Wilson");
    });

    it("should handle input with country code and store all variants", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Alice Green", phone: "+15553334444" },
      ]);

      // Input with +1 country code
      const result = await getContactNamesByPhones(["+15553334444"]);

      // All three formats should resolve to the same name
      expect(result.get("5553334444")).toBe("Alice Green");
      expect(result.get("+15553334444")).toBe("Alice Green");
      expect(result.get("15553334444")).toBe("Alice Green");
    });

    it("should handle formatted phone numbers with dashes and spaces", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Charlie Brown", phone: "(555) 444-3333" },
      ]);

      const result = await getContactNamesByPhones(["555-444-3333"]);

      // Should normalize to 10-digit and store multiple variants
      expect(result.get("5554443333")).toBe("Charlie Brown");
      expect(result.get("+15554443333")).toBe("Charlie Brown");
    });
  });

  describe("macOS Contacts fallback", () => {
    it("should fallback to macOS Contacts when not found in DB", async () => {
      // DB returns no results
      mockDbAll.mockReturnValue([]);

      // macOS Contacts has the contact
      mockGetContactNames.mockResolvedValue({
        contactMap: {
          "(555) 666-7777": "macOS Contact",
        },
      });

      const result = await getContactNamesByPhones(["5556667777"]);

      // Should find via macOS Contacts fallback
      expect(result.get("5556667777")).toBe("macOS Contact");
    });

    it("should store multiple formats from macOS Contacts fallback", async () => {
      mockDbAll.mockReturnValue([]);

      mockGetContactNames.mockResolvedValue({
        contactMap: {
          "(555) 888-9999": "macOS User",
        },
      });

      const result = await getContactNamesByPhones(["5558889999"]);

      // Should store by normalized and country code variants
      expect(result.get("5558889999")).toBe("macOS User");
      expect(result.get("+15558889999")).toBe("macOS User");
      expect(result.get("15558889999")).toBe("macOS User");
    });

    it("should handle macOS Contacts failure gracefully", async () => {
      mockDbAll.mockReturnValue([]);
      mockGetContactNames.mockRejectedValue(new Error("Access denied"));

      // Should not throw
      const result = await getContactNamesByPhones(["5551234567"]);

      expect(result.size).toBe(0);
      expect(mockLogService.warn).toHaveBeenCalledWith(
        "Failed to load macOS Contacts for fallback lookup",
        "Contacts",
        expect.any(Object)
      );
    });
  });

  describe("multiple contacts lookup", () => {
    it("should handle multiple phone numbers in single call", async () => {
      mockDbAll.mockReturnValue([
        { display_name: "Person One", phone: "+15551111111" },
        { display_name: "Person Two", phone: "+15552222222" },
      ]);

      const result = await getContactNamesByPhones([
        "5551111111",
        "5552222222",
      ]);

      expect(result.get("5551111111")).toBe("Person One");
      expect(result.get("5552222222")).toBe("Person Two");
      // E.164 variants should also work
      expect(result.get("+15551111111")).toBe("Person One");
      expect(result.get("+15552222222")).toBe("Person Two");
    });

    it("should combine DB and macOS Contacts results", async () => {
      // First contact in DB
      mockDbAll.mockReturnValue([
        { display_name: "DB Contact", phone: "+15551111111" },
      ]);

      // Second contact only in macOS Contacts
      mockGetContactNames.mockResolvedValue({
        contactMap: {
          "(555) 222-2222": "macOS Only Contact",
        },
      });

      const result = await getContactNamesByPhones([
        "5551111111",
        "5552222222",
      ]);

      expect(result.get("5551111111")).toBe("DB Contact");
      expect(result.get("5552222222")).toBe("macOS Only Contact");
    });
  });

  describe("international numbers (non-US)", () => {
    it("should handle short international numbers without adding +1 variants", async () => {
      // 7-digit number (not 10 digits, so no +1 variants)
      mockDbAll.mockReturnValue([
        { display_name: "Short Number Contact", phone: "5551234" },
      ]);

      const result = await getContactNamesByPhones(["5551234"]);

      expect(result.get("5551234")).toBe("Short Number Contact");
      // Should NOT have +1 variants (only for 10-digit numbers)
      expect(result.has("+15551234")).toBe(false);
    });
  });
});
