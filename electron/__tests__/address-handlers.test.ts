/**
 * Unit tests for Address Handlers
 * Tests address verification IPC handlers including:
 * - Service initialization
 * - Address autocomplete suggestions
 * - Address details retrieval
 * - Geocoding
 * - Address validation
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

// Mock services
const mockAddressVerificationService = {
  initialize: jest.fn(),
  getAddressSuggestions: jest.fn(),
  getAddressDetails: jest.fn(),
  geocodeAddress: jest.fn(),
  validateAddress: jest.fn(),
};

jest.mock("../services/addressVerificationService", () => ({
  default: mockAddressVerificationService,
}));

// Import after mocks are set up
import { registerAddressHandlers } from "../handlers/addressHandlers";

// Test session tokens (needs to be 20+ chars)
const TEST_SESSION_TOKEN = "550e8400-e29b-41d4-a716-446655440001";

describe("Address Handlers", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    registerAddressHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("address:initialize", () => {
    it("should initialize with API key successfully", async () => {
      mockAddressVerificationService.initialize.mockReturnValue(true);

      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, "valid-api-key-1234567890");

      expect(result.success).toBe(true);
      expect(result.message).toContain("initialized");
      expect(mockAddressVerificationService.initialize).toHaveBeenCalledWith(
        "valid-api-key-1234567890",
      );
    });

    it("should handle initialization without API key", async () => {
      mockAddressVerificationService.initialize.mockReturnValue(false);

      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, undefined);

      expect(result.success).toBe(false);
      expect(result.message).toContain("No API key");
    });

    it("should handle empty API key", async () => {
      mockAddressVerificationService.initialize.mockReturnValue(false);

      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
    });

    it("should reject API key that is too short", async () => {
      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, "short");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should reject API key that is too long", async () => {
      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, "a".repeat(600));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle initialization failure", async () => {
      mockAddressVerificationService.initialize.mockImplementation(() => {
        throw new Error("Initialization failed");
      });

      const handler = registeredHandlers.get("address:initialize");
      const result = await handler(mockEvent, "valid-api-key-1234567890");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Initialization failed");
    });
  });

  describe("address:get-suggestions", () => {
    it("should return address suggestions", async () => {
      const mockSuggestions = [
        { placeId: "place-1", description: "123 Main St, City, State" },
        { placeId: "place-2", description: "123 Main Ave, City, State" },
      ];
      mockAddressVerificationService.getAddressSuggestions.mockResolvedValue(
        mockSuggestions,
      );

      const handler = registeredHandlers.get("address:get-suggestions");
      const result = await handler(mockEvent, "123 Main", TEST_SESSION_TOKEN);

      expect(result.success).toBe(true);
      expect(result.suggestions).toHaveLength(2);
      expect(
        mockAddressVerificationService.getAddressSuggestions,
      ).toHaveBeenCalledWith("123 Main", TEST_SESSION_TOKEN);
    });

    it("should work without session token", async () => {
      mockAddressVerificationService.getAddressSuggestions.mockResolvedValue(
        [],
      );

      const handler = registeredHandlers.get("address:get-suggestions");
      const result = await handler(mockEvent, "123 Main", undefined);

      expect(result.success).toBe(true);
      expect(
        mockAddressVerificationService.getAddressSuggestions,
      ).toHaveBeenCalledWith("123 Main", null);
    });

    it("should handle empty input", async () => {
      const handler = registeredHandlers.get("address:get-suggestions");
      const result = await handler(mockEvent, "", TEST_SESSION_TOKEN);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
      expect(result.suggestions).toEqual([]);
    });

    it("should handle input that is too long", async () => {
      const handler = registeredHandlers.get("address:get-suggestions");
      const result = await handler(
        mockEvent,
        "a".repeat(600),
        TEST_SESSION_TOKEN,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle service failure", async () => {
      mockAddressVerificationService.getAddressSuggestions.mockRejectedValue(
        new Error("API error"),
      );

      const handler = registeredHandlers.get("address:get-suggestions");
      const result = await handler(mockEvent, "123 Main", TEST_SESSION_TOKEN);

      expect(result.success).toBe(false);
      expect(result.error).toContain("API error");
      expect(result.suggestions).toEqual([]);
    });

    it("should handle invalid session token format", async () => {
      const handler = registeredHandlers.get("address:get-suggestions");
      // Session token must be 20+ chars, so 'short' triggers validation error
      const result = await handler(mockEvent, "123 Main", "short");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("address:get-details", () => {
    it("should return address details for valid place ID", async () => {
      const mockDetails = {
        formattedAddress: "123 Main Street, City, State 12345",
        streetNumber: "123",
        route: "Main Street",
        city: "City",
        state: "State",
        postalCode: "12345",
        country: "USA",
        location: { lat: 40.7128, lng: -74.006 },
      };
      mockAddressVerificationService.getAddressDetails.mockResolvedValue(
        mockDetails,
      );

      const handler = registeredHandlers.get("address:get-details");
      const result = await handler(mockEvent, "ChIJN1t_tDeuEmsRUsoyG83frY4");

      expect(result.success).toBe(true);
      expect(result.address).toEqual(mockDetails);
    });

    it("should handle invalid place ID (too short)", async () => {
      const handler = registeredHandlers.get("address:get-details");
      const result = await handler(mockEvent, "short");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle place ID that is too long", async () => {
      const handler = registeredHandlers.get("address:get-details");
      const result = await handler(mockEvent, "a".repeat(250));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle empty place ID", async () => {
      const handler = registeredHandlers.get("address:get-details");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle place not found", async () => {
      mockAddressVerificationService.getAddressDetails.mockRejectedValue(
        new Error("Place not found"),
      );

      const handler = registeredHandlers.get("address:get-details");
      const result = await handler(mockEvent, "ChIJN1t_tDeuEmsRUsoyG83frY4");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Place not found");
    });
  });

  describe("address:geocode", () => {
    it("should geocode address successfully", async () => {
      const mockResult = {
        formattedAddress: "123 Main Street, City, State 12345",
        location: { lat: 40.7128, lng: -74.006 },
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      };
      mockAddressVerificationService.geocodeAddress.mockResolvedValue(
        mockResult,
      );

      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "123 Main Street, City, State");

      expect(result.success).toBe(true);
      expect(result.address).toEqual(mockResult);
    });

    it("should handle address that is too short", async () => {
      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "abc");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle address that is too long", async () => {
      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "a".repeat(600));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle empty address", async () => {
      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle geocoding failure", async () => {
      mockAddressVerificationService.geocodeAddress.mockRejectedValue(
        new Error("Geocoding failed"),
      );

      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "123 Main Street, City, State");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Geocoding failed");
    });

    it("should handle address not found", async () => {
      mockAddressVerificationService.geocodeAddress.mockRejectedValue(
        new Error("No results found"),
      );

      const handler = registeredHandlers.get("address:geocode");
      const result = await handler(mockEvent, "Nonexistent Address, Nowhere");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No results found");
    });
  });

  describe("address:validate", () => {
    it("should validate valid address", async () => {
      mockAddressVerificationService.validateAddress.mockResolvedValue(true);

      const handler = registeredHandlers.get("address:validate");
      const result = await handler(
        mockEvent,
        "123 Main Street, City, State 12345",
      );

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
    });

    it("should invalidate invalid address", async () => {
      mockAddressVerificationService.validateAddress.mockResolvedValue(false);

      const handler = registeredHandlers.get("address:validate");
      const result = await handler(mockEvent, "This is not a real address");

      expect(result.success).toBe(true);
      expect(result.valid).toBe(false);
    });

    it("should handle address that is too short", async () => {
      const handler = registeredHandlers.get("address:validate");
      const result = await handler(mockEvent, "abc");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle address that is too long", async () => {
      const handler = registeredHandlers.get("address:validate");
      const result = await handler(mockEvent, "a".repeat(600));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle empty address", async () => {
      const handler = registeredHandlers.get("address:validate");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle validation service failure", async () => {
      mockAddressVerificationService.validateAddress.mockRejectedValue(
        new Error("Validation service error"),
      );

      const handler = registeredHandlers.get("address:validate");
      const result = await handler(mockEvent, "123 Main Street, City, State");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation service error");
    });
  });
});
