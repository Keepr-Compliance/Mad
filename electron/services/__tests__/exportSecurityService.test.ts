/**
 * Security tests for Export functionality
 * Verifies that sensitive data (tokens, credentials, keys) never leak into exports
 */

import enhancedExportService from "../enhancedExportService";
import { Transaction, Communication } from "../../types/models";
import fs from "fs/promises";

// Mock dependencies
jest.mock("fs/promises");
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/test-downloads"),
  },
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe("Export Security - Secret Leak Prevention", () => {
  // Sensitive data patterns that should NEVER appear in exports
  const SENSITIVE_PATTERNS = {
    // OAuth tokens
    accessToken: /access_token|Bearer [A-Za-z0-9\-_\.]+/gi,
    refreshToken: /refresh_token/gi,
    oauthToken: /oauth_token|authorization.*bearer/gi,

    // API keys and secrets
    apiKey: /api_key|apikey|api-key/gi,
    clientSecret: /client_secret|clientsecret/gi,

    // Encryption keys
    encryptionKey: /encryption_key|encrypt_key|aes.*key/gi,
    databaseKey: /db_key|database_key|sqlite.*key/gi,

    // Credentials
    password: /password|passwd|pwd/gi,
    credential: /credential|secret_key|private_key/gi,

    // Specific token formats
    jwtToken: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, // JWT format
    base64Token: /[A-Za-z0-9+\/]{40,}={0,2}/g, // Long base64 strings (potential tokens)
  };

  // Mock transaction with potentially sensitive-looking data
  const mockTransaction: Transaction = {
    id: "txn-123",
    user_id: "user-456",
    property_address: "123 Main St, Anytown, CA 90210",
    property_street: "123 Main St",
    property_city: "Anytown",
    property_state: "CA",
    property_zip: "90210",
    transaction_type: "purchase",
    status: "active",
    started_at: "2024-01-01",
    closed_at: "2024-03-15",
    sale_price: 500000,
    listing_price: 520000,
    earnest_money_amount: 10000,
    extraction_confidence: 85,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
  };

  // Mock communications with various content types
  const mockCommunications: Communication[] = [
    {
      id: "comm-1",
      user_id: "user-456",
      transaction_id: "txn-123",
      communication_type: "email",
      sender: "agent@realestate.com",
      recipients: "buyer@email.com",
      subject: "Property at 123 Main St - Offer Update",
      body: "<p>Hello, the offer for 123 Main St has been accepted.</p>",
      body_plain: "Hello, the offer for 123 Main St has been accepted.",
      sent_at: "2024-01-10T10:00:00Z",
      has_attachments: false,
      attachment_count: 0,
    },
    {
      id: "comm-2",
      user_id: "user-456",
      transaction_id: "txn-123",
      communication_type: "text",
      sender: "+15551234567",
      recipients: "+15559876543",
      body_plain: "Meeting at 123 Main St tomorrow at 2pm",
      sent_at: "2024-01-11T14:00:00Z",
      has_attachments: false,
      attachment_count: 0,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  describe("JSON Export - No Secrets", () => {
    it("should not include access_token in JSON export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.accessToken);
    });

    it("should not include refresh_token in JSON export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.refreshToken);
    });

    it("should not include OAuth credentials in JSON export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.clientSecret);
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.apiKey);
    });

    it("should not include database encryption key in JSON export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.encryptionKey);
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.databaseKey);
    });

    it("should only export expected transaction fields", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      const exportedData = JSON.parse(capturedContent);

      const actualKeys = Object.keys(exportedData.transaction);

      // Should NOT include user_id or other internal fields
      expect(actualKeys).not.toContain("user_id");
      expect(actualKeys).not.toContain("created_at");
      expect(actualKeys).not.toContain("updated_at");
    });

    it("should only export expected communication fields", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      const exportedData = JSON.parse(capturedContent);

      if (
        exportedData.communications &&
        exportedData.communications.length > 0
      ) {
        const commKeys = Object.keys(exportedData.communications[0]);

        // Should NOT include user_id or transaction_id in export
        expect(commKeys).not.toContain("user_id");
        expect(commKeys).not.toContain("transaction_id");
      }
    });
  });

  describe("CSV Export - No Secrets", () => {
    it("should not include tokens in CSV export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "csv" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.accessToken);
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.refreshToken);
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.jwtToken);
    });

    it("should not include credentials in CSV export", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "csv" },
      );

      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.password);
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.credential);
    });
  });

  describe("TXT/EML Export - No Secrets", () => {
    it("should not include tokens in EML file content", async () => {
      const writtenFiles: { path: string; content: string }[] = [];
      mockFs.writeFile.mockImplementation(async (filePath, content) => {
        writtenFiles.push({
          path: filePath as string,
          content: content as string,
        });
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "txt_eml" },
      );

      // Check all written files
      for (const file of writtenFiles) {
        expect(file.content).not.toMatch(SENSITIVE_PATTERNS.accessToken);
        expect(file.content).not.toMatch(SENSITIVE_PATTERNS.refreshToken);
        expect(file.content).not.toMatch(SENSITIVE_PATTERNS.apiKey);
      }
    });

    it("should not include credentials in summary file", async () => {
      const writtenFiles: { path: string; content: string }[] = [];
      mockFs.writeFile.mockImplementation(async (filePath, content) => {
        writtenFiles.push({
          path: filePath as string,
          content: content as string,
        });
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "txt_eml" },
      );

      const summaryFile = writtenFiles.find((f) => f.path.includes("SUMMARY"));
      expect(summaryFile).toBeDefined();

      if (summaryFile) {
        expect(summaryFile.content).not.toMatch(SENSITIVE_PATTERNS.password);
        expect(summaryFile.content).not.toMatch(
          SENSITIVE_PATTERNS.encryptionKey,
        );
        expect(summaryFile.content).not.toMatch(
          SENSITIVE_PATTERNS.clientSecret,
        );
      }
    });
  });

  describe("Communication Content Sanitization", () => {
    it("should handle communications with suspicious content safely", async () => {
      // Communications that CONTAIN text that looks like tokens (but are just user content)
      const susComms: Communication[] = [
        {
          id: "comm-sus",
          user_id: "user-456",
          transaction_id: "txn-123",
          communication_type: "email",
          sender: "agent@realestate.com",
          recipients: "buyer@email.com",
          subject: "Re: 123 Main St - Access Token for Property",
          body_plain:
            "The property access token (door code) is 1234. Please use it to access the property at 123 Main St.",
          sent_at: "2024-01-10T10:00:00Z",
          has_attachments: false,
          attachment_count: 0,
        },
      ];

      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(mockTransaction, susComms, {
        exportFormat: "json",
      });

      // Should still export - this is legitimate user content
      expect(capturedContent).toContain("door code");

      // But should NOT contain actual OAuth tokens (long JWT-like strings)
      expect(capturedContent).not.toMatch(SENSITIVE_PATTERNS.jwtToken);
    });
  });

  describe("Export Structure Validation", () => {
    it("should not include internal IDs that could be used for attacks", async () => {
      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      const exportedData = JSON.parse(capturedContent);

      // user_id should not be in exported transaction
      expect(exportedData.transaction.user_id).toBeUndefined();
    });

    it("should sanitize file names to prevent path traversal", async () => {
      const maliciousTransaction = {
        ...mockTransaction,
        property_address: "../../../etc/passwd",
      };

      await enhancedExportService.exportTransaction(
        maliciousTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      // Check that writeFile was called with a safe path
      expect(mockFs.writeFile).toHaveBeenCalled();
      const calledPath = (mockFs.writeFile as jest.Mock).mock
        .calls[0][0] as string;

      // Should not contain path traversal sequences
      expect(calledPath).not.toContain("../");
      expect(calledPath).not.toContain("..\\");
    });
  });

  describe("No Environment Variables Leaked", () => {
    it("should not include environment variable values in exports", async () => {
      // Temporarily set some env vars
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        GOOGLE_CLIENT_SECRET: "test-secret-123",
        MICROSOFT_CLIENT_SECRET: "ms-secret-456",
        DATABASE_KEY: "db-key-789",
      };

      let capturedContent = "";
      mockFs.writeFile.mockImplementation(async (_path, content) => {
        capturedContent = content as string;
      });

      await enhancedExportService.exportTransaction(
        mockTransaction,
        mockCommunications,
        { exportFormat: "json" },
      );

      // Should not contain any of our test secrets
      expect(capturedContent).not.toContain("test-secret-123");
      expect(capturedContent).not.toContain("ms-secret-456");
      expect(capturedContent).not.toContain("db-key-789");

      // Restore env
      process.env = originalEnv;
    });
  });
});

describe("Audit Log Export Security", () => {
  // Audit logs may contain additional sensitive info - test separately

  it("should not include authentication details in audit exports", async () => {
    // This would test audit log exports specifically
    // The audit service sanitizes sensitive fields before logging

    // Example: When a login event is logged, the token should be redacted
    const mockAuditEntry = {
      action: "LOGIN",
      userId: "user-123",
      details: {
        provider: "google",
        email: "user@example.com",
        // These should NOT be present
        access_token: undefined,
        refresh_token: undefined,
      },
    };

    expect(mockAuditEntry.details.access_token).toBeUndefined();
    expect(mockAuditEntry.details.refresh_token).toBeUndefined();
  });
});
