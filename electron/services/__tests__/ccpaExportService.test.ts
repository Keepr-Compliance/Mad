/**
 * @jest-environment node
 */

/**
 * Unit tests for CCPA Data Export Service
 * TASK-2053: Verifies data gathering, structure, sanitization, and output
 */


// ============================================
// MOCKS
// ============================================

// Mock electron app
jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn().mockReturnValue("2.3.0"),
  },
}));

// Mock fs
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
jest.mock("fs", () => ({
  promises: {
    writeFile: mockWriteFile,
  },
}));

// Mock logService
const mockLogService = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("../logService", () => mockLogService);

// Mock database services
const mockGetUserById = jest.fn();
jest.mock("../db/userDbService", () => ({
  getUserById: mockGetUserById,
}));

const mockGetTransactions = jest.fn();
jest.mock("../db/transactionDbService", () => ({
  getTransactions: mockGetTransactions,
}));

const mockGetContacts = jest.fn();
jest.mock("../db/contactDbService", () => ({
  getContacts: mockGetContacts,
}));

const mockGetEmailsByUser = jest.fn();
jest.mock("../db/emailDbService", () => ({
  getEmailsByUser: mockGetEmailsByUser,
}));

const mockGetAuditLogs = jest.fn();
jest.mock("../db/auditLogDbService", () => ({
  getAuditLogs: mockGetAuditLogs,
}));

const mockGetExternalContacts = jest.fn();
jest.mock("../db/externalContactDbService", () => ({
  getAllForUser: mockGetExternalContacts,
}));

// Mock dbAll for direct SQL queries (messages, feedback, preferences, oauth_tokens)
const mockDbAll = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  dbAll: mockDbAll,
}));

// Import after mocks
import {
  exportUserData,
  writeExportFile,
  type CcpaExportData,
} from "../ccpaExportService";

// ============================================
// TEST DATA
// ============================================

const TEST_USER_ID = "user-123-abc";

const mockUser = {
  id: TEST_USER_ID,
  email: "test@example.com",
  first_name: "John",
  last_name: "Doe",
  display_name: "John Doe",
  created_at: "2024-01-01T00:00:00.000Z",
};

const mockTransactions = [
  {
    id: "txn-1",
    user_id: TEST_USER_ID,
    property_address: "123 Main St",
    status: "active",
    created_at: "2024-06-01T00:00:00.000Z",
  },
  {
    id: "txn-2",
    user_id: TEST_USER_ID,
    property_address: "456 Oak Ave",
    status: "closed",
    created_at: "2024-03-15T00:00:00.000Z",
  },
];

const mockContacts = [
  {
    id: "contact-1",
    user_id: TEST_USER_ID,
    display_name: "Jane Smith",
    email: "jane@example.com",
  },
];

const mockMessages = [
  {
    id: "msg-1",
    user_id: TEST_USER_ID,
    channel: "sms",
    body_text: "Hello there",
    sent_at: "2024-06-01T10:00:00.000Z",
  },
];

const mockEmails = [
  {
    id: "email-1",
    user_id: TEST_USER_ID,
    subject: "RE: Property inquiry",
    sender: "agent@realty.com",
    sent_at: "2024-06-02T14:00:00.000Z",
  },
];

const mockFeedback = [
  {
    id: "fb-1",
    user_id: TEST_USER_ID,
    feedback_type: "classification",
    original_value: "spam",
    corrected_value: "relevant",
  },
];

const mockPreferences = [
  {
    user_id: TEST_USER_ID,
    preferences: '{"export":{"defaultFormat":"pdf"}}',
  },
];

const mockAuditLogs = [
  {
    id: "log-1",
    userId: TEST_USER_ID,
    action: "login",
    timestamp: new Date("2024-06-01T08:00:00.000Z"),
    success: true,
  },
];

const mockOAuthTokens = [
  {
    provider: "google",
    purpose: "mailbox",
    scopes_granted: '["email","profile"]',
    connected_email_address: "user@gmail.com",
    permissions_granted_at: "2024-01-15T00:00:00.000Z",
    created_at: "2024-01-15T00:00:00.000Z",
  },
];

const mockExternalContacts = [
  {
    id: "ext-1",
    user_id: TEST_USER_ID,
    name: "Bob Builder",
    phones: ["+15555555555"],
    emails: ["bob@example.com"],
    source: "macos",
  },
];

// ============================================
// HELPER
// ============================================

function setupDefaultMocks(): void {
  mockGetUserById.mockResolvedValue(mockUser);
  mockGetTransactions.mockResolvedValue(mockTransactions);
  mockGetContacts.mockResolvedValue(mockContacts);
  mockGetEmailsByUser.mockResolvedValue(mockEmails);
  mockGetAuditLogs.mockResolvedValue(mockAuditLogs);
  mockGetExternalContacts.mockReturnValue(mockExternalContacts);

  // dbAll is called for messages, classification_feedback, feedback_learning,
  // user_preferences, and oauth_tokens
  mockDbAll.mockImplementation((sql: string) => {
    if (sql.includes("FROM messages")) return mockMessages;
    if (sql.includes("FROM classification_feedback")) return mockFeedback;
    if (sql.includes("FROM feedback_learning")) return [];
    if (sql.includes("FROM user_preferences")) return mockPreferences;
    if (sql.includes("FROM oauth_tokens")) return mockOAuthTokens;
    return [];
  });
}

// ============================================
// TESTS
// ============================================

describe("CcpaExportService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  describe("exportUserData", () => {
    it("should include all required CCPA categories", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.metadata).toBeDefined();
      expect(result.identifiers).toBeDefined();
      expect(result.commercial_information).toBeDefined();
      expect(result.contacts).toBeDefined();
      expect(result.electronic_activity).toBeDefined();
      expect(result.inferences).toBeDefined();
      expect(result.preferences).toBeDefined();
      expect(result.audit_trail).toBeDefined();
      expect(result.authentication).toBeDefined();
      expect(result.external_contacts).toBeDefined();
    });

    it("should include correct metadata", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.metadata.userId).toBe(TEST_USER_ID);
      expect(result.metadata.appVersion).toBe("2.3.0");
      expect(result.metadata.exportDate).toBeDefined();
      expect(result.metadata.dataCategories).toHaveLength(9);
      expect(result.metadata.dataCategories).toContain("identifiers");
      expect(result.metadata.dataCategories).toContain("commercial_information");
      expect(result.metadata.dataCategories).toContain("contacts");
      expect(result.metadata.dataCategories).toContain("electronic_activity");
      expect(result.metadata.dataCategories).toContain("inferences");
      expect(result.metadata.dataCategories).toContain("preferences");
      expect(result.metadata.dataCategories).toContain("audit_trail");
      expect(result.metadata.dataCategories).toContain("authentication");
      expect(result.metadata.dataCategories).toContain("external_contacts");
    });

    it("should include user identifiers", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.identifiers.records).toHaveLength(1);
      expect(result.identifiers.count).toBe(1);
      expect(result.identifiers.description).toContain("identification");
    });

    it("should include transactions as commercial information", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.commercial_information.records).toHaveLength(2);
      expect(result.commercial_information.count).toBe(2);
    });

    it("should include contacts", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.contacts.records).toHaveLength(1);
      expect(result.contacts.count).toBe(1);
    });

    it("should include electronic activity with messages and emails", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.electronic_activity.messages.count).toBe(1);
      expect(result.electronic_activity.messages.records).toHaveLength(1);
      expect(result.electronic_activity.emails.count).toBe(1);
      expect(result.electronic_activity.emails.records).toHaveLength(1);
    });

    it("should include inferences (feedback)", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.inferences.feedback).toHaveLength(1);
      expect(result.inferences.feedback_learning).toHaveLength(0);
    });

    it("should include preferences", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.preferences.records).toHaveLength(1);
      expect(result.preferences.count).toBe(1);
    });

    it("should include audit trail", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.audit_trail.records).toHaveLength(1);
      expect(result.audit_trail.count).toBe(1);
    });

    it("should include external contacts", async () => {
      const result = await exportUserData(TEST_USER_ID);

      expect(result.external_contacts.records).toHaveLength(1);
      expect(result.external_contacts.count).toBe(1);
    });

    it("should exclude OAuth token values (security)", async () => {
      const result = await exportUserData(TEST_USER_ID);

      // Should only have provider, scope, purpose, and created_at
      const providers = result.authentication.connected_providers;
      expect(providers).toHaveLength(1);
      expect(providers[0].provider).toBe("google");
      expect(providers[0].scope).toBeDefined();
      expect(providers[0].purpose).toBe("mailbox");
      expect(providers[0].created_at).toBeDefined();

      // CRITICAL: Must NOT contain actual token values
      const authJson = JSON.stringify(result.authentication);
      expect(authJson).not.toContain("access_token");
      expect(authJson).not.toContain("refresh_token");
    });

    it("should handle empty tables gracefully", async () => {
      mockGetUserById.mockResolvedValue(null);
      mockGetTransactions.mockResolvedValue([]);
      mockGetContacts.mockResolvedValue([]);
      mockGetEmailsByUser.mockResolvedValue([]);
      mockGetAuditLogs.mockResolvedValue([]);
      mockGetExternalContacts.mockReturnValue([]);
      mockDbAll.mockReturnValue([]);

      const result = await exportUserData(TEST_USER_ID);

      // All categories should be present with empty arrays
      expect(result.identifiers.records).toHaveLength(0);
      expect(result.commercial_information.records).toHaveLength(0);
      expect(result.contacts.records).toHaveLength(0);
      expect(result.electronic_activity.messages.records).toHaveLength(0);
      expect(result.electronic_activity.emails.records).toHaveLength(0);
      expect(result.inferences.feedback).toHaveLength(0);
      expect(result.preferences.records).toHaveLength(0);
      expect(result.audit_trail.records).toHaveLength(0);
      expect(result.authentication.connected_providers).toHaveLength(0);
      expect(result.external_contacts.records).toHaveLength(0);

      // Counts should be 0
      expect(result.identifiers.count).toBe(0);
      expect(result.commercial_information.count).toBe(0);
    });

    it("should call progress callback for each category", async () => {
      const progressCallback = jest.fn();

      await exportUserData(TEST_USER_ID, progressCallback);

      // Should be called 9 times (one per category)
      expect(progressCallback).toHaveBeenCalledTimes(9);

      // Progress should increase with each call
      const calls = progressCallback.mock.calls;
      let lastProgress = 0;
      for (const call of calls) {
        const progress = call[1] as number;
        expect(progress).toBeGreaterThanOrEqual(lastProgress);
        lastProgress = progress;
      }

      // Final call should be 100%
      expect(calls[calls.length - 1][1]).toBe(100);
    });

    it("should handle feedback_learning table not existing", async () => {
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM messages")) return mockMessages;
        if (sql.includes("FROM classification_feedback")) return mockFeedback;
        if (sql.includes("FROM feedback_learning")) {
          throw new Error("no such table: feedback_learning");
        }
        if (sql.includes("FROM user_preferences")) return mockPreferences;
        if (sql.includes("FROM oauth_tokens")) return mockOAuthTokens;
        return [];
      });

      const result = await exportUserData(TEST_USER_ID);

      // Should not throw - feedback_learning should be empty
      expect(result.inferences.feedback_learning).toHaveLength(0);
      // Other feedback should still be present
      expect(result.inferences.feedback).toHaveLength(1);
    });

    it("should produce valid JSON", async () => {
      const result = await exportUserData(TEST_USER_ID);

      // Stringify and parse should not throw
      const jsonString = JSON.stringify(result);
      const parsed = JSON.parse(jsonString);
      expect(parsed.metadata.userId).toBe(TEST_USER_ID);
    });

    it("should produce export matching expected structure", async () => {
      const result = await exportUserData(TEST_USER_ID);

      // Verify top-level structure matches spec
      const keys = Object.keys(result);
      expect(keys).toContain("metadata");
      expect(keys).toContain("identifiers");
      expect(keys).toContain("commercial_information");
      expect(keys).toContain("contacts");
      expect(keys).toContain("electronic_activity");
      expect(keys).toContain("inferences");
      expect(keys).toContain("preferences");
      expect(keys).toContain("audit_trail");
      expect(keys).toContain("authentication");
      expect(keys).toContain("external_contacts");

      // Verify each category has a description
      expect(result.identifiers.description).toBeTruthy();
      expect(result.commercial_information.description).toBeTruthy();
      expect(result.contacts.description).toBeTruthy();
      expect(result.electronic_activity.description).toBeTruthy();
      expect(result.inferences.description).toBeTruthy();
      expect(result.preferences.description).toBeTruthy();
      expect(result.audit_trail.description).toBeTruthy();
      expect(result.authentication.description).toBeTruthy();
      expect(result.external_contacts.description).toBeTruthy();
    });
  });

  describe("writeExportFile", () => {
    it("should write JSON with indentation", async () => {
      const data = await exportUserData(TEST_USER_ID);
      await writeExportFile(data, "/tmp/test-export.json");

      expect(mockWriteFile).toHaveBeenCalledWith(
        "/tmp/test-export.json",
        expect.any(String),
        expect.objectContaining({ encoding: "utf-8" }),
      );

      // Verify the written content is formatted JSON
      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain("  "); // Indentation
      expect(JSON.parse(writtenContent)).toBeDefined(); // Valid JSON
    });

    it("should write to the specified file path", async () => {
      const data = await exportUserData(TEST_USER_ID);
      const testPath = "/Users/test/Documents/export.json";

      await writeExportFile(data, testPath);

      expect(mockWriteFile).toHaveBeenCalledWith(
        testPath,
        expect.any(String),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });
});
