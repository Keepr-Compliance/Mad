/**
 * Tests for Input Validation Utilities
 * Ensures transaction data validation works correctly, especially for dates and prices
 *
 * SECURITY TESTS (TASK-601): Includes tests for UDID and path validation
 * that prevent command injection in spawn/exec calls.
 */

import {
  ValidationError,
  validateContactId,
  validateContactData,
  validateTransactionId,
  validateTransactionData,
  validateProvider,
  validateDeviceUdid,
  isValidDeviceUdid,
  validateExecutablePath,
  validateMsiPath,
  validateSessionToken,
  isSessionTokenCorruptionError,
  SESSION_TOKEN_MIN_LENGTH,
  SESSION_TOKEN_MAX_LENGTH,
} from "../validation";
import {
  TransactionTypeSchema,
  TransactionStatusSchema,
} from "../../schemas/transaction";

describe("Contact Validation", () => {
  describe("validateContactId", () => {
    it("should accept valid UUID strings", () => {
      const validUUID = "9cc92292-400f-406b-a9e6-02522278a65a";
      expect(validateContactId(validUUID)).toBe(validUUID);
    });

    it("should trim whitespace from valid UUIDs", () => {
      const uuidWithSpaces = "  448aa043-9866-4cc7-8d14-8975003dc216  ";
      const trimmedUUID = "448aa043-9866-4cc7-8d14-8975003dc216";
      expect(validateContactId(uuidWithSpaces)).toBe(trimmedUUID);
    });

    it("should reject non-string values", () => {
      expect(() => validateContactId(123)).toThrow(ValidationError);
      expect(() => validateContactId(123)).toThrow(
        "Contact ID must be a string",
      );
    });

    it("should reject invalid UUID format", () => {
      expect(() => validateContactId("not-a-uuid")).toThrow(ValidationError);
      expect(() => validateContactId("not-a-uuid")).toThrow(
        "Contact ID must be a valid UUID",
      );
    });

    it("should reject integer IDs (regression test for the bug)", () => {
      // This tests the original bug - contact IDs were being validated as integers
      expect(() => validateContactId(12345)).toThrow(ValidationError);
      expect(() => validateContactId("12345")).toThrow(ValidationError);
    });

    it("should handle required parameter", () => {
      expect(() => validateContactId(null, true)).toThrow(
        "Contact ID is required",
      );
      expect(validateContactId(null, false)).toBeNull();
      expect(() => validateContactId("", true)).toThrow(
        "Contact ID is required",
      );
      expect(validateContactId("", false)).toBeNull();
    });

    it("should accept UUIDs in different cases", () => {
      const lowerUUID = "a6f3ccec-5e25-48f7-85dc-8be3f4c1048d";
      const upperUUID = "A6F3CCEC-5E25-48F7-85DC-8BE3F4C1048D";
      const mixedUUID = "A6f3CceC-5E25-48f7-85dC-8Be3f4C1048D";

      expect(validateContactId(lowerUUID)).toBe(lowerUUID);
      expect(validateContactId(upperUUID)).toBe(upperUUID);
      expect(validateContactId(mixedUUID)).toBe(mixedUUID);
    });
  });
});

describe("Transaction Validation", () => {
  describe("validateTransactionId", () => {
    it("should accept valid UUID strings", () => {
      const validUUID = "a6f3ccec-5e25-48f7-85dc-8be3f4c1048d";
      expect(validateTransactionId(validUUID)).toBe(validUUID);
    });

    it("should reject non-string values", () => {
      expect(() => validateTransactionId(123)).toThrow(ValidationError);
      expect(() => validateTransactionId(123)).toThrow(
        "Transaction ID must be a string",
      );
    });

    it("should reject invalid UUID format", () => {
      expect(() => validateTransactionId("not-a-uuid")).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionId("not-a-uuid")).toThrow(
        "Transaction ID must be a valid UUID",
      );
    });

    it("should handle required parameter", () => {
      expect(() => validateTransactionId(null, true)).toThrow(
        "Transaction ID is required",
      );
      expect(validateTransactionId(null, false)).toBeNull();
    });
  });

  describe("validateTransactionData - Date Fields", () => {
    it("should accept and validate started_at", () => {
      const data = {
        started_at: "2024-01-15",
      };
      const validated = validateTransactionData(data, true);
      expect(validated.started_at).toBe("2024-01-15");
    });

    it("should accept and validate closed_at", () => {
      const data = {
        closed_at: "2024-03-30",
      };
      const validated = validateTransactionData(data, true);
      expect(validated.closed_at).toBe("2024-03-30");
    });

    it("should accept and validate closing_date_verified", () => {
      const data = {
        closing_date_verified: 1,
      };
      const validated = validateTransactionData(data, true);
      expect(validated.closing_date_verified).toBe(1);
    });

    it("should reject invalid date formats for started_at", () => {
      const data = {
        started_at: "01/15/2024", // Wrong format
      };
      expect(() => validateTransactionData(data, true)).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionData(data, true)).toThrow(
        "Started at date must be in YYYY-MM-DD format",
      );
    });

    it("should reject invalid date formats for closed_at", () => {
      const data = {
        closed_at: "03/30/2024", // Wrong format
      };
      expect(() => validateTransactionData(data, true)).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionData(data, true)).toThrow(
        "Closed at date must be in YYYY-MM-DD format",
      );
    });

    it("should reject invalid closing_date_verified values", () => {
      const data = {
        closing_date_verified: 2, // Must be 0 or 1
      };
      expect(() => validateTransactionData(data, true)).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionData(data, true)).toThrow(
        "Closing date verified must be 0 or 1",
      );
    });

    it("forwards null for date fields, because null is how they are cleared", () => {
      // BACKLOG-2759 — THIS TEST USED TO ASSERT THE DEFECT.
      //
      // It read "should allow null values for date fields" and then required
      // that all three keys be ABSENT from the result, i.e. that an explicit
      // clear be silently discarded. That is the bug: the writer never learned
      // a clear was asked for, and `useAuditSubmission.ts` sends `closed_at`
      // as `|| null`, so blanking a closing date left the old date on the row
      // while the call reported success.
      //
      // Inverted rather than deleted, so the change of intent is on the record
      // where the old expectation stood.
      const data = {
        started_at: null,
        closed_at: null,
        closing_date_verified: null,
      };
      const validated = validateTransactionData(data, true);

      expect(validated.started_at).toBeNull();
      expect(validated.closed_at).toBeNull();
      expect(validated.closing_date_verified).toBeNull();
    });
  });

  describe("validateTransactionData - Price Fields", () => {
    it("should accept and validate sale_price", () => {
      const data = {
        sale_price: 500000,
      };
      const validated = validateTransactionData(data, true);
      expect(validated.sale_price).toBe(500000);
    });

    it("should accept and validate listing_price", () => {
      const data = {
        listing_price: 525000,
      };
      const validated = validateTransactionData(data, true);
      expect(validated.listing_price).toBe(525000);
    });

    it("should accept string numbers for prices", () => {
      const data = {
        sale_price: "500000",
        listing_price: "525000",
      };
      const validated = validateTransactionData(data, true);
      expect(validated.sale_price).toBe(500000);
      expect(validated.listing_price).toBe(525000);
    });

    it("should reject negative prices", () => {
      const data = {
        sale_price: -100,
      };
      expect(() => validateTransactionData(data, true)).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionData(data, true)).toThrow(
        "Sale price must be a non-negative number",
      );
    });

    it("should reject invalid price values", () => {
      const data = {
        listing_price: "not-a-number",
      };
      expect(() => validateTransactionData(data, true)).toThrow(
        ValidationError,
      );
      expect(() => validateTransactionData(data, true)).toThrow(
        "Listing price must be a non-negative number",
      );
    });
  });

  describe("validateTransactionData - Full Update Scenario", () => {
    it("should validate complete transaction update with all fields", () => {
      const data = {
        property_address: "123 Main St, Anytown, CA 12345",
        transaction_type: "purchase",
        status: "active",
        started_at: "2024-01-15",
        closed_at: "2024-03-30",
        closing_date_verified: 1,
        sale_price: 500000,
        listing_price: 525000,
        notes: "Test transaction with all fields",
      };

      const validated = validateTransactionData(data, true);

      expect(validated.property_address).toBe("123 Main St, Anytown, CA 12345");
      expect(validated.transaction_type).toBe("purchase");
      expect(validated.status).toBe("active");
      expect(validated.started_at).toBe("2024-01-15");
      expect(validated.closed_at).toBe("2024-03-30");
      expect(validated.closing_date_verified).toBe(1);
      expect(validated.sale_price).toBe(500000);
      expect(validated.listing_price).toBe(525000);

      // BACKLOG-2558 (SR finding F6): `notes` is CHECKED but no longer
      // FORWARDED — `transactions` has no `notes` column on any path, so
      // forwarding it only handed the writer a key it had to discard. The
      // validation itself is still in force; see the rejection cases below.
      expect("notes" in validated).toBe(false);
    });

    // BACKLOG-2755: two tests stood here — "still REJECTS a malformed notes
    // value even though it is not forwarded" and the same for `amount`. They
    // pinned a deliberate BACKLOG-2558 decision to keep validating two keys
    // that belong to no table. That decision is REPLACED, not quietly dropped:
    // `RawTransactionData` is now keyed off the real column set, so `amount`
    // and `notes` cannot be read here at all and a re-added check is a compile
    // error rather than a runtime one. What is traded away is the error a
    // caller got for `amount: -5`; no caller sends it. The replacement
    // guarantee is asserted in
    // `electron/utils/__tests__/validationFieldSet-2560.test.ts`.

    it("forwards suggested_contacts, which the review UI sends as its only key", () => {
      // BACKLOG-2737/2558 (F6): stripped here before the fix, so dismissing a
      // suggested party reached the writer with an empty payload and threw
      // "No valid fields to update".
      const payload = JSON.stringify([{ name: "Dana Example", role: "buyer_agent" }]);
      expect(
        validateTransactionData({ suggested_contacts: payload }, true).suggested_contacts,
      ).toBe(payload);

      // null is how the LAST remaining suggestion is cleared; it must survive.
      const cleared = validateTransactionData({ suggested_contacts: null }, true);
      expect("suggested_contacts" in cleared).toBe(true);
      expect(cleared.suggested_contacts).toBeNull();
    });

    it("should validate partial update with only dates", () => {
      const data = {
        started_at: "2024-01-15",
        closed_at: "2024-03-30",
        closing_date_verified: 1,
      };

      const validated = validateTransactionData(data, true);

      expect(validated.started_at).toBe("2024-01-15");
      expect(validated.closed_at).toBe("2024-03-30");
      expect(validated.closing_date_verified).toBe(1);
      // Other fields should not be present
      expect(validated.property_address).toBeUndefined();
      expect(validated.sale_price).toBeUndefined();
    });
  });

  describe("Regression Tests - Date Saving Bug", () => {
    it("should NOT strip out date fields during validation (regression test)", () => {
      // This test ensures the bug where dates were being stripped is fixed
      const updateData = {
        started_at: "2024-01-15",
        closed_at: "2024-03-30",
        closing_date_verified: 1,
      };

      const validated = validateTransactionData(updateData, true);

      // These fields MUST be present in the validated object
      expect(validated).toHaveProperty("started_at");
      expect(validated).toHaveProperty("closed_at");
      expect(validated).toHaveProperty("closing_date_verified");

      // And they must have the correct values
      expect(validated.started_at).toBe("2024-01-15");
      expect(validated.closed_at).toBe("2024-03-30");
      expect(validated.closing_date_verified).toBe(1);
    });

    it("should NOT strip out price fields during validation (regression test)", () => {
      // This test ensures price fields are not stripped
      const updateData = {
        sale_price: 500000,
        listing_price: 525000,
      };

      const validated = validateTransactionData(updateData, true);

      // These fields MUST be present in the validated object
      expect(validated).toHaveProperty("sale_price");
      expect(validated).toHaveProperty("listing_price");

      // And they must have the correct values
      expect(validated.sale_price).toBe(500000);
      expect(validated.listing_price).toBe(525000);
    });
  });
});

describe("Provider Validation", () => {
  describe("validateProvider", () => {
    it("should accept 'google' provider", () => {
      expect(validateProvider("google")).toBe("google");
    });

    it("should accept 'microsoft' provider", () => {
      expect(validateProvider("microsoft")).toBe("microsoft");
    });

    it("should accept 'Google' (case-insensitive)", () => {
      expect(validateProvider("Google")).toBe("google");
    });

    it("should accept 'Microsoft' (case-insensitive)", () => {
      expect(validateProvider("Microsoft")).toBe("microsoft");
    });

    it("should normalize 'azure' to 'microsoft'", () => {
      expect(validateProvider("azure")).toBe("microsoft");
    });

    it("should normalize 'Azure' to 'microsoft' (case-insensitive)", () => {
      expect(validateProvider("Azure")).toBe("microsoft");
    });

    it("should normalize 'AZURE' to 'microsoft' (case-insensitive)", () => {
      expect(validateProvider("AZURE")).toBe("microsoft");
    });

    it("should reject invalid providers", () => {
      expect(() => validateProvider("invalid-provider")).toThrow(
        ValidationError,
      );
      expect(() => validateProvider("invalid-provider")).toThrow(
        "Provider must be one of: google, microsoft",
      );
    });

    it("should reject empty string", () => {
      expect(() => validateProvider("")).toThrow(ValidationError);
      expect(() => validateProvider("")).toThrow(
        "Provider is required and must be a string",
      );
    });

    it("should reject null", () => {
      expect(() => validateProvider(null)).toThrow(ValidationError);
      expect(() => validateProvider(null)).toThrow(
        "Provider is required and must be a string",
      );
    });

    it("should reject undefined", () => {
      expect(() => validateProvider(undefined)).toThrow(ValidationError);
      expect(() => validateProvider(undefined)).toThrow(
        "Provider is required and must be a string",
      );
    });

    it("should reject non-string values", () => {
      expect(() => validateProvider(123)).toThrow(ValidationError);
      expect(() => validateProvider({})).toThrow(ValidationError);
    });
  });
});

// =============================================================================
// SECURITY TESTS (TASK-601): Device UDID and Path Validation
// =============================================================================
// These tests verify that validators properly prevent command injection attacks
// when UDIDs and paths are used in spawn/exec calls.

describe("Security Validation - TASK-601", () => {
  describe("validateDeviceUdid", () => {
    describe("Valid UDID formats", () => {
      it("should accept traditional 40-hex-char UDID format (pre-iPhone X)", () => {
        const traditionalUdid = "a1b2c3d4e5f6789012345678901234567890abcd";
        expect(validateDeviceUdid(traditionalUdid)).toBe(traditionalUdid);
      });

      it("should accept modern 8-4-16 UDID format (iPhone X+)", () => {
        const modernUdid = "00000000-0000000000000000";
        expect(validateDeviceUdid(modernUdid)).toBe(modernUdid);
      });

      it("should accept simulator UUID format", () => {
        const simulatorUdid = "12345678-1234-1234-1234-123456789012";
        expect(validateDeviceUdid(simulatorUdid)).toBe(simulatorUdid);
      });

      it("should trim whitespace from valid UDIDs", () => {
        const udidWithSpaces = "  00000000-0000000000000000  ";
        expect(validateDeviceUdid(udidWithSpaces)).toBe(
          "00000000-0000000000000000",
        );
      });

      it("should accept uppercase hex characters", () => {
        const upperUdid = "A1B2C3D4E5F6789012345678901234567890ABCD";
        expect(validateDeviceUdid(upperUdid)).toBe(upperUdid);
      });

      it("should accept mixed case hex characters", () => {
        const mixedUdid = "a1B2c3D4e5F6789012345678901234567890AbCd";
        expect(validateDeviceUdid(mixedUdid)).toBe(mixedUdid);
      });
    });

    describe("Invalid UDID formats - Security", () => {
      it("should reject command injection attempt with shell commands", () => {
        expect(() => validateDeviceUdid("$(rm -rf /)")).toThrow(ValidationError);
        expect(() => validateDeviceUdid("; rm -rf /")).toThrow(ValidationError);
        expect(() => validateDeviceUdid("| cat /etc/passwd")).toThrow(
          ValidationError,
        );
      });

      it("should reject UDID with shell metacharacters", () => {
        expect(() => validateDeviceUdid("udid`whoami`")).toThrow(
          ValidationError,
        );
        expect(() => validateDeviceUdid("udid&&echo")).toThrow(ValidationError);
        expect(() => validateDeviceUdid("udid||true")).toThrow(ValidationError);
      });

      it("should reject UDID with path traversal sequences", () => {
        expect(() => validateDeviceUdid("../../../etc/passwd")).toThrow(
          ValidationError,
        );
        expect(() => validateDeviceUdid("..\\..\\windows")).toThrow(
          ValidationError,
        );
      });

      it("should reject UDID with newline injection", () => {
        expect(() => validateDeviceUdid("valid\n;malicious")).toThrow(
          ValidationError,
        );
        expect(() => validateDeviceUdid("valid\r\nmalicious")).toThrow(
          ValidationError,
        );
      });

      it("should reject UDID that is too short", () => {
        expect(() => validateDeviceUdid("short")).toThrow(ValidationError);
        expect(() => validateDeviceUdid("0000000000")).toThrow(ValidationError);
      });

      it("should reject UDID that is too long", () => {
        const tooLong = "a".repeat(50);
        expect(() => validateDeviceUdid(tooLong)).toThrow(ValidationError);
      });

      it("should reject non-hexadecimal characters", () => {
        expect(() =>
          validateDeviceUdid("g1b2c3d4e5f6789012345678901234567890abcd"),
        ).toThrow(ValidationError);
        expect(() =>
          validateDeviceUdid("!1b2c3d4e5f6789012345678901234567890abcd"),
        ).toThrow(ValidationError);
      });

      it("should reject invalid hyphen placement", () => {
        // Wrong number of hyphens for modern format
        expect(() => validateDeviceUdid("00000000--0000000000000000")).toThrow(
          ValidationError,
        );
        // Hyphen in wrong position
        expect(() => validateDeviceUdid("0000-0000-0000000000000000")).toThrow(
          ValidationError,
        );
      });
    });

    describe("Required parameter behavior", () => {
      it("should throw when required and UDID is null", () => {
        expect(() => validateDeviceUdid(null, true)).toThrow(
          "Device UDID is required",
        );
      });

      it("should throw when required and UDID is undefined", () => {
        expect(() => validateDeviceUdid(undefined, true)).toThrow(
          "Device UDID is required",
        );
      });

      it("should throw when required and UDID is empty string", () => {
        expect(() => validateDeviceUdid("", true)).toThrow(
          "Device UDID is required",
        );
      });

      it("should return empty string when not required and UDID is empty", () => {
        expect(validateDeviceUdid("", false)).toBe("");
        expect(validateDeviceUdid(null, false)).toBe("");
      });

      it("should reject non-string values", () => {
        expect(() => validateDeviceUdid(12345)).toThrow(
          "Device UDID must be a string",
        );
        expect(() => validateDeviceUdid({ udid: "value" })).toThrow(
          "Device UDID must be a string",
        );
      });
    });
  });

  describe("isValidDeviceUdid", () => {
    it("should return true for valid UDIDs", () => {
      expect(isValidDeviceUdid("00000000-0000000000000000")).toBe(true);
      expect(
        isValidDeviceUdid("a1b2c3d4e5f6789012345678901234567890abcd"),
      ).toBe(true);
    });

    it("should return false for invalid UDIDs", () => {
      expect(isValidDeviceUdid("$(rm -rf /)")).toBe(false);
      expect(isValidDeviceUdid("short")).toBe(false);
      expect(isValidDeviceUdid(null)).toBe(false);
      expect(isValidDeviceUdid(undefined)).toBe(false);
    });
  });

  describe("validateExecutablePath", () => {
    const allowedPaths = [
      "/app/resources/win/libimobiledevice",
      "C:\\Program Files\\7-Zip",
      "/home/user/safe",
    ];

    describe("Valid paths", () => {
      it("should accept paths within allowed directories", () => {
        expect(
          validateExecutablePath(
            "/app/resources/win/libimobiledevice/ideviceinfo.exe",
            allowedPaths,
          ),
        ).toBe("/app/resources/win/libimobiledevice/ideviceinfo.exe");
      });

      it("should accept Windows paths within allowed directories", () => {
        expect(
          validateExecutablePath(
            "C:\\Program Files\\7-Zip\\7z.exe",
            allowedPaths,
          ),
        ).toBe("C:\\Program Files\\7-Zip\\7z.exe");
      });

      it("should trim whitespace from valid paths", () => {
        expect(
          validateExecutablePath(
            "  /home/user/safe/script.sh  ",
            allowedPaths,
          ),
        ).toBe("/home/user/safe/script.sh");
      });
    });

    describe("Invalid paths - Security", () => {
      it("should reject paths outside allowed directories", () => {
        expect(() =>
          validateExecutablePath("/etc/passwd", allowedPaths),
        ).toThrow("Executable path is not in an allowed location");
      });

      it("should reject path traversal attacks", () => {
        expect(() =>
          validateExecutablePath(
            "/app/resources/win/libimobiledevice/../../../etc/passwd",
            allowedPaths,
          ),
        ).toThrow("Executable path contains path traversal sequences");
      });

      it("should reject shell metacharacters in paths", () => {
        expect(() =>
          validateExecutablePath(
            "/app/resources/win/libimobiledevice/;rm -rf /",
            allowedPaths,
          ),
        ).toThrow("Executable path contains dangerous characters");

        expect(() =>
          validateExecutablePath(
            "/app/resources/win/libimobiledevice/$(whoami)",
            allowedPaths,
          ),
        ).toThrow("Executable path contains dangerous characters");
      });

      it("should reject empty paths", () => {
        expect(() => validateExecutablePath("", allowedPaths)).toThrow(
          "Executable path is required",
        );
      });

      it("should reject null/undefined paths", () => {
        expect(() => validateExecutablePath(null, allowedPaths)).toThrow(
          "Executable path is required",
        );
        expect(() => validateExecutablePath(undefined, allowedPaths)).toThrow(
          "Executable path is required",
        );
      });

      it("should reject newline injection in paths", () => {
        expect(() =>
          validateExecutablePath(
            "/app/resources/win/libimobiledevice/file\n;malicious",
            allowedPaths,
          ),
        ).toThrow("Executable path contains dangerous characters");
      });
    });
  });

  describe("validateMsiPath", () => {
    const allowedPaths = [
      "C:\\Users\\App\\AppData\\Roaming\\keepr",
      "C:\\Program Files\\keepr\\resources",
    ];

    describe("Valid MSI paths", () => {
      it("should accept MSI files within allowed directories", () => {
        const msiPath =
          "C:\\Users\\App\\AppData\\Roaming\\keepr\\drivers\\AppleMobileDeviceSupport64.msi";
        expect(validateMsiPath(msiPath, allowedPaths)).toBe(msiPath);
      });

      it("should be case-insensitive for .msi extension", () => {
        const msiPath =
          "C:\\Users\\App\\AppData\\Roaming\\keepr\\drivers\\Driver.MSI";
        expect(validateMsiPath(msiPath, allowedPaths)).toBe(msiPath);
      });
    });

    describe("Invalid MSI paths - Security", () => {
      it("should reject files that are not MSI", () => {
        expect(() =>
          validateMsiPath(
            "C:\\Users\\App\\AppData\\Roaming\\keepr\\malware.exe",
            allowedPaths,
          ),
        ).toThrow("Path must be an MSI file");
      });

      it("should reject MSI files outside allowed directories", () => {
        expect(() =>
          validateMsiPath("C:\\Windows\\System32\\evil.msi", allowedPaths),
        ).toThrow("Executable path is not in an allowed location");
      });

      it("should reject path traversal in MSI paths", () => {
        expect(() =>
          validateMsiPath(
            "C:\\Users\\App\\AppData\\Roaming\\keepr\\..\\..\\..\\evil.msi",
            allowedPaths,
          ),
        ).toThrow("Executable path contains path traversal sequences");
      });

      it("should reject null/empty MSI paths", () => {
        expect(() => validateMsiPath(null, allowedPaths)).toThrow(
          "MSI path is required",
        );
        expect(() => validateMsiPath("", allowedPaths)).toThrow(
          "MSI path is required",
        );
      });
    });
  });

  // TASK-2280: Session token validation and corruption detection
  describe("Session Token Validation", () => {
    describe("validateSessionToken", () => {
      it("should accept valid session tokens", () => {
        const validToken = "a".repeat(36); // UUID-like length
        expect(validateSessionToken(validToken)).toBe(validToken);
      });

      it("should accept tokens at minimum length boundary", () => {
        const token = "x".repeat(SESSION_TOKEN_MIN_LENGTH);
        expect(validateSessionToken(token)).toBe(token);
      });

      it("should accept tokens at maximum length boundary", () => {
        const token = "y".repeat(SESSION_TOKEN_MAX_LENGTH);
        expect(validateSessionToken(token)).toBe(token);
      });

      it("should trim whitespace from valid tokens", () => {
        const token = "  " + "a".repeat(36) + "  ";
        expect(validateSessionToken(token)).toBe("a".repeat(36));
      });

      it("should throw ValidationError for tokens that are too short", () => {
        expect(() => validateSessionToken("short")).toThrow(ValidationError);
        expect(() => validateSessionToken("short")).toThrow("Session token has invalid length");
      });

      it("should throw ValidationError for tokens that are too long", () => {
        const longToken = "x".repeat(SESSION_TOKEN_MAX_LENGTH + 1);
        expect(() => validateSessionToken(longToken)).toThrow(ValidationError);
        expect(() => validateSessionToken(longToken)).toThrow("Session token has invalid length");
      });

      it("should throw ValidationError for null/undefined", () => {
        expect(() => validateSessionToken(null)).toThrow(ValidationError);
        expect(() => validateSessionToken(undefined)).toThrow(ValidationError);
      });

      it("should throw ValidationError for non-string types", () => {
        expect(() => validateSessionToken(12345)).toThrow(ValidationError);
        expect(() => validateSessionToken({})).toThrow(ValidationError);
      });
    });

    describe("isSessionTokenCorruptionError", () => {
      it("should return true for session token invalid length errors", () => {
        const error = new ValidationError("Session token has invalid length", "sessionToken");
        expect(isSessionTokenCorruptionError(error)).toBe(true);
      });

      it("should return false for other ValidationErrors", () => {
        const error = new ValidationError("Session token is required and must be a string", "sessionToken");
        expect(isSessionTokenCorruptionError(error)).toBe(false);
      });

      it("should return false for ValidationErrors on other fields", () => {
        const error = new ValidationError("Something has invalid length", "userId");
        expect(isSessionTokenCorruptionError(error)).toBe(false);
      });

      it("should return false for non-ValidationError instances", () => {
        expect(isSessionTokenCorruptionError(new Error("Session token has invalid length"))).toBe(false);
      });

      it("should return false for non-error values", () => {
        expect(isSessionTokenCorruptionError(null)).toBe(false);
        expect(isSessionTokenCorruptionError(undefined)).toBe(false);
        expect(isSessionTokenCorruptionError("string error")).toBe(false);
      });
    });
  });
});

// ===========================================================================
// BACKLOG-2755 — VALUE DOMAINS
// ===========================================================================
// Before this item the two enums below were hand-written arrays inside
// `validateTransactionData`, and they had drifted from the `transactions`
// CHECK constraints in BOTH directions: the validator accepted `lease`,
// `refinance` and `cancelled` (which the CHECK rejects) and rejected
// `rejected` (which the CHECK accepts).
//
// Nothing caught it. The whole of this file was green at the time — 91 tests —
// because every existing case sampled a value that happened to be legal on
// both sides. So these tests PROBE the function over a value list that spans
// the disagreement, and assert the ACCEPTED SET, not membership samples.
//
// TWO assertions per field, and they are not redundant:
//
//  - against a HAND-WRITTEN literal. This is the tripwire. A change to the
//    column's CHECK must consciously update this line; it cannot ride in.
//  - against `Schema.options`. This one is green under any domain change by
//    construction — it compares the code with the same source the code derives
//    from. Its only job is to fail if someone re-introduces a hand-written
//    array here that DIFFERS from the schema. An identical one is invisible to
//    it, which is exactly why the literal above is also required.
describe("validateTransactionData — value domains (BACKLOG-2755)", () => {
  /** A value no CHECK list contains, to prove the domain is closed at all. */
  const DOMAIN_SENTINEL = "zzz_not_a_real_domain_value";

  /**
   * Drive the real function and report which values it ACCEPTS, by asking the
   * returned object rather than by reading the validator's source.
   */
  function acceptedSet(field: "transaction_type" | "status", candidates: string[]): string[] {
    const accepted: string[] = [];
    for (const value of candidates) {
      try {
        const validated = validateTransactionData({ [field]: value }, true);
        if (validated[field] === value) accepted.push(value);
      } catch {
        // rejected — deliberately not accepted
      }
    }
    return accepted.sort();
  }

  const TYPE_CANDIDATES = [
    // the CHECK's own list
    "purchase", "sale", "other",
    // the three the validator used to accept and the database rejects
    "lease", "refinance",
    DOMAIN_SENTINEL,
  ];

  const STATUS_CANDIDATES = [
    // the CHECK's own list
    "pending", "active", "closed", "rejected",
    // the one the validator used to accept and the database rejects
    "cancelled",
    DOMAIN_SENTINEL,
  ];

  describe("transaction_type", () => {
    it("accepts exactly the CHECK's list — pinned by hand, so a domain change cannot ride in", () => {
      expect(acceptedSet("transaction_type", TYPE_CANDIDATES)).toEqual([
        "other",
        "purchase",
        "sale",
      ]);
    });

    it("accepts exactly what the schema declares, so no hand-written list can return here", () => {
      expect(acceptedSet("transaction_type", TYPE_CANDIDATES)).toEqual(
        [...TransactionTypeSchema.options].sort(),
      );
    });

    it("names the legal values in the error, so the message cannot drift from the check", () => {
      expect(() =>
        validateTransactionData({ transaction_type: "lease" }, true),
      ).toThrow("Transaction type must be one of: purchase, sale, other");
    });
  });

  describe("status", () => {
    it("accepts exactly the CHECK's list — pinned by hand, so a domain change cannot ride in", () => {
      expect(acceptedSet("status", STATUS_CANDIDATES)).toEqual([
        "active",
        "closed",
        "pending",
        "rejected",
      ]);
    });

    it("accepts exactly what the schema declares, so no hand-written list can return here", () => {
      expect(acceptedSet("status", STATUS_CANDIDATES)).toEqual(
        [...TransactionStatusSchema.options].sort(),
      );
    });

    it("accepts 'rejected', the review-queue status it used to block outright", () => {
      // The half of the drift that was USER-VISIBLE: the database and the
      // writer both accept this status, and this validator refused it.
      expect(validateTransactionData({ status: "rejected" }, true).status).toBe(
        "rejected",
      );
    });
  });
});

// ===========================================================================
// BACKLOG-2759 — CLEARING A FIELD
// ===========================================================================
// Six guards read `!== undefined && !== null`, which collapses two opposite
// instructions — "clear this column" and "say nothing about this column" —
// into one and drops the key. The writer never saw the clear, and the caller
// was told it worked. `useAuditSubmission.ts` sends `closed_at` and
// `closing_deadline` as `|| null`, so blanking a closing date left the old
// date on the row of an audit whose window is computed from it.
//
// Every one of the six is covered here, not only the two with a known caller:
// the five others are the same line one field apart, and a per-column decision
// is the discipline this epic applies to writers.
//
// These tests assert the KEY SURVIVES and what it carries. They cannot prove
// the row is actually cleared — the writer is downstream of here — which is
// what `electron/__tests__/transactionNullClear-2759.test.ts` exists for.
describe("validateTransactionData — clearing a field (BACKLOG-2759)", () => {
  const CLEARABLE = [
    "sale_price",
    "listing_price",
    "closing_date_verified",
    "started_at",
    "closed_at",
    "closing_deadline",
  ] as const;

  describe.each(CLEARABLE)("%s", (field) => {
    it("forwards an explicit null instead of dropping the key", () => {
      const validated = validateTransactionData({ [field]: null }, true);

      expect(field in validated).toBe(true);
      expect(validated[field]).toBeNull();
    });

    it("still skips the field when it is not mentioned at all", () => {
      // The other half of the distinction: `undefined` must remain "no
      // instruction", or the fix would start writing nulls over live data.
      const validated = validateTransactionData({}, true);

      expect(field in validated).toBe(false);
    });
  });

  describe("the empty string, which is a separate decision per column", () => {
    it.each(["started_at", "closed_at", "closing_deadline"] as const)(
      "%s clears, because an empty string is what a blanked form field sends",
      (field) => {
        // The writer declares `emptyToNull: true` for these columns, but that
        // rule fires on the INSERT path only — measured against a real
        // database in `electron/__tests__/transactionNullClear-2759.test.ts`.
        // Forwarding `""` to the update path stored a literal empty string in
        // a DATETIME column, which is not NULL and still reads as "a date is
        // set", so the clear is resolved here instead.
        const validated = validateTransactionData({ [field]: "" }, true);

        expect(field in validated).toBe(true);
        expect(validated[field]).toBeNull();
      },
    );

    it.each(["sale_price", "listing_price"] as const)(
      "%s clears rather than writing 0, which is what Number('') used to produce",
      (field) => {
        // Latent, not live — no renderer writes either price today — but a
        // cleared price landing as a real $0 is wrong in kind, so it is fixed
        // with the strip it shares a line with.
        const validated = validateTransactionData({ [field]: "" }, true);

        expect(validated[field]).toBeNull();
      },
    );

    it("closing_date_verified keeps 0, deliberately", () => {
      // INTEGER DEFAULT 0, and 0 IS the column's "not verified" resting state,
      // so Number("") lands the right value here rather than a wrong one. The
      // one member of the group not changed, stated so its absence is a
      // decision and not an oversight.
      const validated = validateTransactionData(
        { closing_date_verified: "" },
        true,
      );

      expect(validated.closing_date_verified).toBe(0);
    });
  });

  it("still rejects a malformed date, so opening the guard did not open the format", () => {
    expect(() =>
      validateTransactionData({ closed_at: "15-01-2026" }, true),
    ).toThrow("Closed at date must be in YYYY-MM-DD format");
  });

  it("still rejects a negative price, so opening the guard did not open the range", () => {
    expect(() => validateTransactionData({ sale_price: -1 }, true)).toThrow(
      "Sale price must be a non-negative number",
    );
  });
});

/**
 * =============================================================================
 * BACKLOG-2707 — the contact name guard, swept at the validator boundary
 * =============================================================================
 * DOCUMENTATION, NOT EVIDENCE, and saying so is the point. Every assertion here
 * would pass on a fix that stored the literal "Unknown", because the
 * substitution that produced it lived downstream in `createContactsBatch`. The
 * claims that can actually fail live in
 * `electron/services/db/__tests__/contactDbService.namelessDisplayName-2707.test.ts`
 * (the stored value) and `electron/__tests__/contact-handlers.namelessImport-2707.test.ts`
 * (the handlers, including the `contacts:update` NOT NULL path).
 *
 * What this file DOES pin: that the four spellings of "no name" reach one
 * outcome, that the outcome is `""` and never `null`, and that the type check
 * was not relaxed along with the emptiness rule.
 */
describe("validateContactData — a missing name is not a validation failure (BACKLOG-2707)", () => {
  describe.each([
    ["create", false],
    ["update", true],
  ])("on %s", (_label, isUpdate) => {
    /**
     * SWEPT, not sampled. `""` and `"   "` were refused by DIFFERENT clauses
     * with DIFFERENT messages — `required` and `minLength: 1` — so a suite that
     * tested only one of them would have called a half-fix green.
     */
    it.each([
      ["null", null],
      ["an empty string", ""],
      ["whitespace only", "   "],
      ["a tab and a newline", "\t\n"],
    ])("resolves %s to an empty string", (_spelling, value) => {
      const validated = validateContactData({ name: value }, isUpdate);

      expect(validated.name).toBe("");
      // NEVER null: `contacts.display_name` is TEXT NOT NULL, and a null
      // survives `contacts:update` to raise a constraint error at the writer.
      expect(validated.name).not.toBeNull();
    });

    it("leaves a real name alone", () => {
      expect(validateContactData({ name: "Rosalind Vance" }, isUpdate).name).toBe(
        "Rosalind Vance",
      );
    });

    it("still trims a real name rather than storing the padding", () => {
      expect(validateContactData({ name: "  Rosalind Vance  " }, isUpdate).name).toBe(
        "Rosalind Vance",
      );
    });

    it("says nothing about a name the caller did not send", () => {
      const validated = validateContactData({ company: "Vantrees Realty" }, isUpdate);

      expect("name" in validated).toBe(false);
    });

    /**
     * The emptiness rule was relaxed; the TYPE rule was not. Turning a
     * wrong-typed name into a silent `null` would trade a ValidationError for
     * silence — the direction PR #2563 argued against when it deleted the
     * `amount` check.
     */
    it.each([
      ["a number", 42],
      ["an object", { first: "Rosalind" }],
      ["an array", ["Rosalind"]],
    ])("still throws on %s", (_spelling, value) => {
      expect(() => validateContactData({ name: value }, isUpdate)).toThrow(ValidationError);
    });

    /**
     * PRE-EXISTING, PINNED, NOT FIXED HERE — BACKLOG-3186.
     *
     * `validateString` returns early on `!value`, so a FALSY non-string is not
     * a "no name" spelling and is not a throw either: it comes back as `null`,
     * silently. BACKLOG-2707 did not cause this — the base validator does the
     * same — and did not fix it. It is pinned so that whoever does fix it sees
     * this file go red rather than discovering the change downstream, and so
     * the "non-strings throw" reading of the guard above cannot re-form.
     *
     * `null` is the value that matters: on `contacts:update` it survives the
     * handler's `undefined`-only filter and fails the NOT NULL column. The
     * create and import paths are safe from it only because of the `?? ""` at
     * their two `display_name` sites.
     */
    it.each([
      ["zero", 0],
      ["false", false],
      ["NaN", NaN],
    ])("returns null for %s rather than throwing (BACKLOG-3186)", (_spelling, value) => {
      const validated = validateContactData({ name: value }, isUpdate);

      expect(validated.name).toBeNull();
      // NOT `""` — stating the difference from the four handled spellings, so
      // this test cannot be read as endorsing the behaviour.
      expect(validated.name).not.toBe("");
    });

    it("still enforces the length ceiling", () => {
      expect(() =>
        validateContactData({ name: "R".repeat(201) }, isUpdate),
      ).toThrow(/200/);
    });
  });

  /**
   * The regression this item is named for, at the validator boundary: the two
   * messages that used to come back are gone. Both are asserted by ABSENCE of
   * a throw rather than by message text, because the messages no longer exist.
   */
  it("no longer produces either of the two refusals it used to", () => {
    expect(() =>
      validateContactData({ name: "", phone: "+14155550142" }, false),
    ).not.toThrow();
    expect(() =>
      validateContactData({ name: "   ", phone: "+14155550142" }, false),
    ).not.toThrow();
  });
});
