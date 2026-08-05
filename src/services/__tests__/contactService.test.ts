/**
 * ContactService Tests
 *
 * Comprehensive unit tests for contactService.ts
 *
 * Mock Pattern (consistent with transactionService.test.ts):
 * =====================================
 * 1. Mock window.api at module level using Object.defineProperty
 * 2. Create individual mock functions for each API method
 * 3. Reset all mocks in beforeEach with jest.clearAllMocks()
 * 4. Configure mock return values per test case
 * 5. Test both success and error paths for each method
 *
 * API Surface Tested:
 * - getAll, getAvailable, getSortedByActivity
 * - create, update, delete, remove
 * - checkCanDelete, import
 */

import { contactService } from "../contactService";
import type { Contact, NewContact } from "@/types";

// ============================================
// MOCK SETUP
// ============================================

// Mock functions for window.api.contacts methods
const mockGetAll = jest.fn();
const mockGetAvailable = jest.fn();
const mockGetSortedByActivity = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockRemove = jest.fn();
const mockCheckCanDelete = jest.fn();
const mockImport = jest.fn();

// Setup window.api mock before tests
beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      contacts: {
        getAll: mockGetAll,
        getAvailable: mockGetAvailable,
        getSortedByActivity: mockGetSortedByActivity,
        create: mockCreate,
        update: mockUpdate,
        delete: mockDelete,
        remove: mockRemove,
        checkCanDelete: mockCheckCanDelete,
        import: mockImport,
      },
    },
    writable: true,
    configurable: true,
  });
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================
// TEST FIXTURES
// ============================================

// `source` is required on Contact but is not exercised by these tests, so the
// fixtures are asserted rather than annotated (keeps the payloads untouched).
const mockContact = {
  id: "contact-123",
  user_id: "user-123",
  display_name: "John Doe",
  email: "john@example.com",
  phone: "555-1234",
  company: "Acme Corp",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
} as Contact;

// See note above.
const mockContactList = [
  mockContact,
  {
    id: "contact-456",
    user_id: "user-123",
    display_name: "Jane Smith",
    email: "jane@example.com",
    phone: "555-5678",
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
] as Contact[];

const mockUserId = "user-123";
const mockContactId = "contact-123";

// ============================================
// GET ALL METHOD TESTS
// ============================================

describe("contactService", () => {
  describe("getAll", () => {
    it("should return all contacts successfully", async () => {
      mockGetAll.mockResolvedValue({ success: true, contacts: mockContactList });

      const result = await contactService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContactList);
      expect(mockGetAll).toHaveBeenCalledWith(mockUserId);
    });

    it("should return empty array when no contacts exist", async () => {
      mockGetAll.mockResolvedValue({ success: true, contacts: [] });

      const result = await contactService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should handle undefined contacts field", async () => {
      mockGetAll.mockResolvedValue({ success: true });

      const result = await contactService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return error when API returns failure", async () => {
      mockGetAll.mockResolvedValue({ success: false, error: "User not found" });

      const result = await contactService.getAll(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetAll.mockRejectedValue(new Error("Database connection lost"));

      const result = await contactService.getAll(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database connection lost");
    });
  });

  // ============================================
  // GET AVAILABLE METHOD TESTS
  // ============================================

  describe("getAvailable", () => {
    it("should return available contacts successfully", async () => {
      mockGetAvailable.mockResolvedValue({ success: true, contacts: mockContactList });

      const result = await contactService.getAvailable(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContactList);
      expect(mockGetAvailable).toHaveBeenCalledWith(mockUserId);
    });

    it("should return empty array when no contacts available", async () => {
      mockGetAvailable.mockResolvedValue({ success: true, contacts: [] });

      const result = await contactService.getAvailable(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should handle undefined contacts field", async () => {
      mockGetAvailable.mockResolvedValue({ success: true });

      const result = await contactService.getAvailable(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return error when API returns failure", async () => {
      mockGetAvailable.mockResolvedValue({ success: false, error: "Access denied" });

      const result = await contactService.getAvailable(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Access denied");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetAvailable.mockRejectedValue(new Error("Query timeout"));

      const result = await contactService.getAvailable(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Query timeout");
    });
  });

  // ============================================
  // GET SORTED BY ACTIVITY METHOD TESTS
  // ============================================

  describe("getSortedByActivity", () => {
    it("should return contacts sorted by activity successfully", async () => {
      mockGetSortedByActivity.mockResolvedValue({ success: true, contacts: mockContactList });

      const result = await contactService.getSortedByActivity(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContactList);
      expect(mockGetSortedByActivity).toHaveBeenCalledWith(mockUserId, undefined);
    });

    it("should pass property address filter to API", async () => {
      const propertyAddress = "123 Main St";
      mockGetSortedByActivity.mockResolvedValue({ success: true, contacts: [mockContact] });

      const result = await contactService.getSortedByActivity(mockUserId, propertyAddress);

      expect(result.success).toBe(true);
      expect(mockGetSortedByActivity).toHaveBeenCalledWith(mockUserId, propertyAddress);
    });

    it("should return empty array when no contacts", async () => {
      mockGetSortedByActivity.mockResolvedValue({ success: true, contacts: [] });

      const result = await contactService.getSortedByActivity(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should handle undefined contacts field", async () => {
      mockGetSortedByActivity.mockResolvedValue({ success: true });

      const result = await contactService.getSortedByActivity(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return error when API returns failure", async () => {
      mockGetSortedByActivity.mockResolvedValue({ success: false, error: "Sort failed" });

      const result = await contactService.getSortedByActivity(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Sort failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetSortedByActivity.mockRejectedValue(new Error("Network error"));

      const result = await contactService.getSortedByActivity(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });

  // ============================================
  // CREATE METHOD TESTS
  // ============================================

  describe("create", () => {
    const createInput = {
      display_name: "New Contact",
      email: "new@example.com",
      phone: "555-9999",
    };

    it("should create contact successfully", async () => {
      mockCreate.mockResolvedValue({ success: true, contact: mockContact });

      const result = await contactService.create(mockUserId, createInput);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContact);
      expect(mockCreate).toHaveBeenCalledWith(mockUserId, createInput);
    });

    it("should return error when API returns failure", async () => {
      mockCreate.mockResolvedValue({ success: false, error: "Invalid email" });

      const result = await contactService.create(mockUserId, createInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid email");
    });

    it("should return default error when success but no contact returned", async () => {
      mockCreate.mockResolvedValue({ success: true });

      const result = await contactService.create(mockUserId, createInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to create contact");
    });

    it("should catch and return error when API throws exception", async () => {
      mockCreate.mockRejectedValue(new Error("Validation failed"));

      const result = await contactService.create(mockUserId, createInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Validation failed");
    });
  });

  // ============================================
  // UPDATE METHOD TESTS
  // ============================================

  describe("update", () => {
    const updateInput = {
      display_name: "Updated Name",
      email: "updated@example.com",
    };

    it("should update contact successfully", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await contactService.update(mockContactId, updateInput);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockContactId, updateInput);
    });

    it("should return error when API returns failure", async () => {
      mockUpdate.mockResolvedValue({ success: false, error: "Contact not found" });

      const result = await contactService.update(mockContactId, updateInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Contact not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockUpdate.mockRejectedValue(new Error("Update conflict"));

      const result = await contactService.update(mockContactId, updateInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Update conflict");
    });
  });

  // ============================================
  // DELETE METHOD TESTS
  // ============================================

  describe("delete", () => {
    it("should delete contact successfully", async () => {
      mockDelete.mockResolvedValue({ success: true });

      const result = await contactService.delete(mockContactId);

      expect(result.success).toBe(true);
      expect(mockDelete).toHaveBeenCalledWith(mockContactId);
    });

    it("should return error when API returns failure", async () => {
      mockDelete.mockResolvedValue({ success: false, error: "Contact has dependencies" });

      const result = await contactService.delete(mockContactId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Contact has dependencies");
    });

    it("should catch and return error when API throws exception", async () => {
      mockDelete.mockRejectedValue(new Error("Database error"));

      const result = await contactService.delete(mockContactId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database error");
    });
  });

  // ============================================
  // REMOVE METHOD TESTS (alias for delete)
  // ============================================

  describe("remove", () => {
    it("should remove contact successfully", async () => {
      mockRemove.mockResolvedValue({ success: true });

      const result = await contactService.remove(mockContactId);

      expect(result.success).toBe(true);
      expect(mockRemove).toHaveBeenCalledWith(mockContactId);
    });

    it("should return error when API returns failure", async () => {
      mockRemove.mockResolvedValue({ success: false, error: "Remove failed" });

      const result = await contactService.remove(mockContactId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Remove failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockRemove.mockRejectedValue(new Error("Access denied"));

      const result = await contactService.remove(mockContactId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Access denied");
    });
  });

  // ============================================
  // CHECK CAN DELETE METHOD TESTS
  // ============================================

  describe("checkCanDelete", () => {
    it("should return canDelete true when contact has no transactions", async () => {
      mockCheckCanDelete.mockResolvedValue({ canDelete: true, transactionCount: 0 });

      const result = await contactService.checkCanDelete(mockContactId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ canDelete: true, transactionCount: 0 });
      expect(mockCheckCanDelete).toHaveBeenCalledWith(mockContactId);
    });

    it("should return canDelete false when contact has transactions", async () => {
      mockCheckCanDelete.mockResolvedValue({ canDelete: false, transactionCount: 3 });

      const result = await contactService.checkCanDelete(mockContactId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ canDelete: false, transactionCount: 3 });
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckCanDelete.mockRejectedValue(new Error("Check failed"));

      const result = await contactService.checkCanDelete(mockContactId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Check failed");
    });
  });

  // ============================================
  // IMPORT METHOD TESTS
  // ============================================

  describe("import", () => {
    // See note above: `source` is required on Contact/NewContact but unused here.
    const contactsToImport = [
      { display_name: "Import 1", email: "import1@example.com", user_id: mockUserId },
      { display_name: "Import 2", email: "import2@example.com", user_id: mockUserId },
    ] as NewContact[];

    /**
     * BACKLOG-2510 — these fixtures used to send `{ success: true, imported: 2 }`.
     *
     * `contacts:import` has never returned an `imported` field. It returns
     * `contacts` — the created rows (`contactHandlers.ts:2052-2055`). So the
     * fixture described a response the handler cannot emit, the production code
     * read the field the fixture invented, and the two agreed with each other
     * about a number that was `0` in the real app every single time.
     *
     * Transcribed to the real shape, so the count is now derived from the rows
     * the handler actually sends.
     */
    const importedRows = [
      { id: "contact-import-1", display_name: "Import 1" },
      { id: "contact-import-2", display_name: "Import 2" },
    ];

    it("should count the contacts the handler actually returned", async () => {
      mockImport.mockResolvedValue({ success: true, contacts: importedRows });

      const result = await contactService.import(mockUserId, contactsToImport);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ imported: 2 });
      expect(mockImport).toHaveBeenCalledWith(mockUserId, contactsToImport);
    });

    it("should handle zero imports", async () => {
      mockImport.mockResolvedValue({ success: true, contacts: [] });

      const result = await contactService.import(mockUserId, []);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ imported: 0 });
    });

    it("should handle a success response carrying no contacts array", async () => {
      mockImport.mockResolvedValue({ success: true });

      const result = await contactService.import(mockUserId, contactsToImport);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ imported: 0 });
    });

    it("should return error when API returns failure", async () => {
      mockImport.mockResolvedValue({ success: false, error: "Import quota exceeded" });

      const result = await contactService.import(mockUserId, contactsToImport);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Import quota exceeded");
    });

    it("should catch and return error when API throws exception", async () => {
      mockImport.mockRejectedValue(new Error("Batch import failed"));

      const result = await contactService.import(mockUserId, contactsToImport);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Batch import failed");
    });
  });
});
