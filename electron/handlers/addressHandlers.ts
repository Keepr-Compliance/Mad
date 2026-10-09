// ============================================
// ADDRESS VERIFICATION IPC HANDLERS
// This file contains address verification handlers for Google Places API
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

// Services
import logService from "../services/logService";
const addressVerificationService =
  require("../services/addressVerificationService").default;

// Import validation utilities
import {
  ValidationError,
  validateString,
  validateSessionToken,
} from "../utils/validation";

// Type definitions
interface AddressResponse {
  success: boolean;
  error?: string;
  message?: string;
  suggestions?: unknown[];
  address?: unknown;
  valid?: boolean;
}

/**
 * Register all address verification IPC handlers
 */
export const registerAddressHandlers = (): void => {
  // Initialize address verification service with API key
  ipcMain.handle(
    "address:initialize",
    async (
      event: IpcMainInvokeEvent,
      apiKey?: string,
    ): Promise<AddressResponse> => {
      try {
        // BACKLOG-3834: the app holds no Maps key. A renderer-supplied key is
        // still validated for shape (IPC contract) but never used.
        validateString(apiKey, "apiKey", {
          required: false,
          maxLength: 500,
        });

        const initialized = addressVerificationService.initialize();

        return {
          success: initialized,
          message: initialized
            ? "Address verification initialized"
            : "Address verification unavailable",
        };
      } catch (error) {
        logService.error("[Main] Address initialization failed:", "AddressHandlers", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get address autocomplete suggestions
  ipcMain.handle(
    "address:get-suggestions",
    async (
      event: IpcMainInvokeEvent,
      input: string,
      sessionToken?: string,
    ): Promise<AddressResponse> => {
      try {
        // Validate input
        const validatedInput = validateString(input, "input", {
          required: true,
          minLength: 1,
          maxLength: 500,
        });

        // Validate session token (optional)
        const validatedSessionToken = sessionToken
          ? validateSessionToken(sessionToken)
          : null;

        const suggestions =
          await addressVerificationService.getAddressSuggestions(
            validatedInput,
            validatedSessionToken,
          );

        return {
          success: true,
          suggestions,
        };
      } catch (error) {
        logService.error("[Main] Get address suggestions failed:", "AddressHandlers", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
            suggestions: [],
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          suggestions: [],
        };
      }
    },
  );

  // Get detailed address information
  ipcMain.handle(
    "address:get-details",
    async (
      event: IpcMainInvokeEvent,
      placeId: string,
    ): Promise<AddressResponse> => {
      try {
        // Validate place ID
        const validatedPlaceId = validateString(placeId, "placeId", {
          required: true,
          minLength: 10,
          maxLength: 200,
        });

        const details =
          await addressVerificationService.getAddressDetails(validatedPlaceId);

        return {
          success: true,
          address: details,
        };
      } catch (error) {
        logService.error("[Main] Get address details failed:", "AddressHandlers", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Geocode an address
  ipcMain.handle(
    "address:geocode",
    async (
      event: IpcMainInvokeEvent,
      address: string,
    ): Promise<AddressResponse> => {
      try {
        // Validate address
        const validatedAddress = validateString(address, "address", {
          required: true,
          minLength: 5,
          maxLength: 500,
        });

        const result =
          await addressVerificationService.geocodeAddress(validatedAddress);

        return {
          success: true,
          address: result,
        };
      } catch (error) {
        logService.error("[Main] Geocode address failed:", "AddressHandlers", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Validate an address
  ipcMain.handle(
    "address:validate",
    async (
      event: IpcMainInvokeEvent,
      address: string,
    ): Promise<AddressResponse> => {
      try {
        // Validate address
        const validatedAddress = validateString(address, "address", {
          required: true,
          minLength: 5,
          maxLength: 500,
        });

        const isValid =
          await addressVerificationService.validateAddress(validatedAddress);

        return {
          success: true,
          valid: isValid,
        };
      } catch (error) {
        logService.error("[Main] Validate address failed:", "AddressHandlers", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
};
