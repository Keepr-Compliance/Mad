/**
 * Unit tests for Preference Handlers
 * Tests preference IPC handlers including:
 * - Getting preferences
 * - Saving preferences
 * - Partial preference updates with deep merge
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

// Mock electron module
const mockIpcHandle = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
}));

// Mock supabaseService - mocks must be inline since jest.mock is hoisted
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getPreferences: jest.fn(),
    syncPreferences: jest.fn(),
  },
}));

// Import after mocks are set up
import { registerPreferenceHandlers } from "../handlers/preferenceHandlers";
import supabaseService from "../services/supabaseService";

// Get reference to mocked service
const mockSupabaseService = supabaseService as jest.Mocked<
  typeof supabaseService
>;

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Preference Handlers", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    registerPreferenceHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("preferences:get", () => {
    it("should return user preferences", async () => {
      const mockPreferences = {
        theme: "dark",
        notifications: { email: true, push: false },
        displaySettings: { fontSize: 14, showGrid: true },
      };
      mockSupabaseService.getPreferences.mockResolvedValue(mockPreferences);

      const handler = registeredHandlers.get("preferences:get");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(mockPreferences);
    });

    it("should return empty object when no preferences exist", async () => {
      // BACKLOG-2414: `getPreferences` is typed (and implemented) to always
      // resolve a `Record<string, any>` — it ends in `data?.preferences || {}` and
      // cannot return null/undefined. These stubs deliberately hand the handler
      // the value the service cannot produce, to pin the handler's own
      // defensiveness, so they are cast rather than corrected.
      mockSupabaseService.getPreferences.mockResolvedValue(
        null as unknown as Record<string, unknown>,
      );

      const handler = registeredHandlers.get("preferences:get");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual({});
    });

    it("should handle undefined preferences", async () => {
      // BACKLOG-2414: cast — see the note on "no preferences exist" above.
      mockSupabaseService.getPreferences.mockResolvedValue(
        undefined as unknown as Record<string, unknown>,
      );

      const handler = registeredHandlers.get("preferences:get");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual({});
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("preferences:get");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle service failure", async () => {
      mockSupabaseService.getPreferences.mockRejectedValue(
        new Error("Service error"),
      );

      const handler = registeredHandlers.get("preferences:get");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Service error");
    });
  });

  describe("preferences:save", () => {
    it("should save preferences successfully", async () => {
      const newPreferences = {
        theme: "light",
        language: "en",
      };
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, newPreferences);

      expect(result.success).toBe(true);
      expect(mockSupabaseService.syncPreferences).toHaveBeenCalledWith(
        TEST_USER_ID,
        newPreferences,
      );
    });

    it("should handle nested preferences", async () => {
      const nestedPreferences = {
        display: {
          theme: "dark",
          fontSize: 16,
          sidebar: {
            collapsed: false,
            width: 250,
          },
        },
      };
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, nestedPreferences);

      expect(result.success).toBe(true);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, "", { theme: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle null preferences", async () => {
      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle non-object preferences", async () => {
      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, "not-an-object");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle array preferences", async () => {
      // Note: Arrays pass the typeof object check, so they are accepted by the handler
      // The sanitizeObject function will convert them to an empty object
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, ["item1", "item2"]);

      // Arrays are technically objects and pass validation
      expect(result.success).toBe(true);
    });

    it("should handle service failure", async () => {
      mockSupabaseService.syncPreferences.mockRejectedValue(
        new Error("Sync failed"),
      );

      const handler = registeredHandlers.get("preferences:save");
      const result = await handler(mockEvent, TEST_USER_ID, { theme: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Sync failed");
    });
  });

  describe("preferences:update", () => {
    it("should perform deep merge of preferences", async () => {
      const existingPreferences = {
        theme: "dark",
        notifications: { email: true, push: true },
        display: { fontSize: 14 },
      };
      const partialUpdate = {
        notifications: { push: false },
        language: "es",
      };
      const expectedMerged = {
        theme: "dark",
        notifications: { email: true, push: false },
        display: { fontSize: 14 },
        language: "es",
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
      expect(mockSupabaseService.syncPreferences).toHaveBeenCalledWith(
        TEST_USER_ID,
        expectedMerged,
      );
    });

    it("should handle update when no existing preferences", async () => {
      const partialUpdate = {
        theme: "light",
      };
      // BACKLOG-2414: cast — see the note on "no preferences exist" above.
      mockSupabaseService.getPreferences.mockResolvedValue(
        null as unknown as Record<string, unknown>,
      );
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(partialUpdate);
    });

    it("should deeply merge nested objects", async () => {
      const existingPreferences = {
        display: {
          theme: "dark",
          sidebar: {
            width: 250,
            collapsed: false,
          },
        },
      };
      const partialUpdate = {
        display: {
          sidebar: {
            collapsed: true,
          },
        },
      };
      const expectedMerged = {
        display: {
          theme: "dark",
          sidebar: {
            width: 250,
            collapsed: true,
          },
        },
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, "", { theme: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle null partial preferences", async () => {
      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle non-object partial preferences", async () => {
      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, "not-an-object");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle get preferences failure", async () => {
      mockSupabaseService.getPreferences.mockRejectedValue(
        new Error("Get failed"),
      );

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, { theme: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Get failed");
    });

    it("should handle sync preferences failure", async () => {
      mockSupabaseService.getPreferences.mockResolvedValue({});
      mockSupabaseService.syncPreferences.mockRejectedValue(
        new Error("Sync failed"),
      );

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, { theme: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Sync failed");
    });

    it("should replace non-object values", async () => {
      const existingPreferences = {
        theme: "dark",
        fontSize: 14,
      };
      const partialUpdate = {
        fontSize: 18,
      };
      const expectedMerged = {
        theme: "dark",
        fontSize: 18,
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
    });

    it("should add new keys to existing object", async () => {
      const existingPreferences = {
        theme: "dark",
      };
      const partialUpdate = {
        language: "fr",
        notifications: { email: true },
      };
      const expectedMerged = {
        theme: "dark",
        language: "fr",
        notifications: { email: true },
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
    });

    it("should merge scan.lookbackMonths into existing preferences", async () => {
      const existingPreferences = {
        export: { format: "pdf" },
      };
      const partialUpdate = {
        scan: { lookbackMonths: 3 },
      };
      const expectedMerged = {
        export: { format: "pdf" },
        scan: { lookbackMonths: 3 },
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
      expect(mockSupabaseService.syncPreferences).toHaveBeenCalledWith(
        TEST_USER_ID,
        expectedMerged,
      );
    });

    it("should update existing scan.lookbackMonths value", async () => {
      const existingPreferences = {
        scan: { lookbackMonths: 9 },
      };
      const partialUpdate = {
        scan: { lookbackMonths: 3 },
      };
      const expectedMerged = {
        scan: { lookbackMonths: 3 },
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
      expect(mockSupabaseService.syncPreferences).toHaveBeenCalledWith(
        TEST_USER_ID,
        expectedMerged,
      );
    });

    it("should add scan.lookbackMonths to empty preferences", async () => {
      const existingPreferences = {};
      const partialUpdate = {
        scan: { lookbackMonths: 6 },
      };
      const expectedMerged = {
        scan: { lookbackMonths: 6 },
      };

      mockSupabaseService.getPreferences.mockResolvedValue(existingPreferences);
      mockSupabaseService.syncPreferences.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("preferences:update");
      const result = await handler(mockEvent, TEST_USER_ID, partialUpdate);

      expect(result.success).toBe(true);
      expect(result.preferences).toEqual(expectedMerged);
      expect(mockSupabaseService.syncPreferences).toHaveBeenCalledWith(
        TEST_USER_ID,
        expectedMerged,
      );
    });
  });
});
