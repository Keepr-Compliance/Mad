/**
 * Outlook Service
 *
 * Service abstraction for Outlook-related API calls.
 * Centralizes all window.api.outlook calls and provides type-safe wrappers.
 *
 * Type signatures match window.d.ts MainAPI.outlook exactly.
 */

import { getErrorMessage } from "./index";

/**
 * Outlook service - wraps window.api.outlook methods
 */
export const outlookService = {
  /**
   * Initialize the Outlook integration
   */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!window.api.outlook) {
        return { success: false, error: "Outlook API not available" };
      }
      return await window.api.outlook.initialize();
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Authenticate with Microsoft/Outlook.
   * Returns userInfo on success.
   */
  async authenticate(): Promise<{
    success: boolean;
    error?: string;
    userInfo?: { username?: string };
  }> {
    try {
      if (!window.api.outlook) {
        return { success: false, error: "Outlook API not available" };
      }
      return await window.api.outlook.authenticate();
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if currently authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      if (!window.api.outlook) return false;
      return await window.api.outlook.isAuthenticated();
    } catch {
      return false;
    }
  },

  /**
   * Get the connected user's email address
   */
  async getUserEmail(): Promise<string | null> {
    try {
      if (!window.api.outlook) return null;
      return await window.api.outlook.getUserEmail();
    } catch {
      return null;
    }
  },

  /**
   * Sign out from Outlook
   */
  async signout(): Promise<{ success: boolean }> {
    try {
      if (!window.api.outlook) {
        return { success: false };
      }
      return await window.api.outlook.signout();
    } catch {
      return { success: false };
    }
  },

  /**
   * Register callback for device code flow (Outlook OAuth).
   * Callback receives raw info (unknown) from the main process.
   */
  onDeviceCode(callback: (info: unknown) => void): (() => void) | undefined {
    if (!window.api.outlook) return undefined;
    return window.api.outlook.onDeviceCode(callback);
  },

  /**
   * Register callback for export progress.
   * Callback receives raw progress (unknown) from the main process.
   */
  onExportProgress(callback: (progress: unknown) => void): (() => void) | undefined {
    if (!window.api.outlook) return undefined;
    return window.api.outlook.onExportProgress(callback);
  },
};
