/**
 * Settings Bridge
 * Manages user preferences and settings
 */

import { ipcRenderer } from "electron";

export const preferencesBridge = {
  /**
   * Gets all preferences for a user
   * @param userId - User ID
   * @returns User preferences
   */
  get: (userId: string) => ipcRenderer.invoke("preferences:get", userId),

  /**
   * Saves all user preferences (overwrites existing)
   * @param userId - User ID
   * @param preferences - Complete preferences object
   * @returns Save result
   */
  save: (userId: string, preferences: unknown) =>
    ipcRenderer.invoke("preferences:save", userId, preferences),

  /**
   * Updates specific preference fields (merges with existing)
   * @param userId - User ID
   * @param partialPreferences - Preferences to update
   * @returns Update result
   */
  update: (userId: string, partialPreferences: unknown) =>
    ipcRenderer.invoke("preferences:update", userId, partialPreferences),
};

/**
 * User Bridge
 * User-specific preferences stored in local database
 */
export const userBridge = {
  /**
   * Gets user's mobile phone type preference
   * @param userId - User ID to get phone type for
   * @returns Phone type result
   */
  getPhoneType: (userId: string) =>
    ipcRenderer.invoke("user:get-phone-type", userId),

  /**
   * Sets user's mobile phone type preference
   * @param userId - User ID to set phone type for
   * @param phoneType - Phone type ('iphone' | 'android')
   * @returns Set result
   */
  setPhoneType: (userId: string, phoneType: "iphone" | "android") =>
    ipcRenderer.invoke("user:set-phone-type", userId, phoneType),

  /**
   * Gets user's phone type from Supabase cloud storage
   * TASK-1600: Pre-DB phone type retrieval
   * @param userId - User ID to get phone type for
   * @returns Phone type result from Supabase user_preferences
   */
  getPhoneTypeCloud: (
    userId: string
  ): Promise<{
    success: boolean;
    phoneType?: "iphone" | "android";
    error?: string;
  }> => ipcRenderer.invoke("user:get-phone-type-cloud", userId),

  /**
   * Sets user's phone type in Supabase cloud storage
   * TASK-1600: Pre-DB phone type storage (always available after auth)
   * @param userId - User ID to set phone type for
   * @param phoneType - Phone type ('iphone' | 'android')
   * @returns Set result
   */
  setPhoneTypeCloud: (
    userId: string,
    phoneType: "iphone" | "android"
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("user:set-phone-type-cloud", userId, phoneType),

  /**
   * Syncs user's phone type from Supabase cloud to local database
   * Used by DataSyncStep to ensure local DB has phone_type before FDA step
   * @param userId - User ID to sync phone type for
   * @returns Sync result
   */
  syncPhoneTypeFromCloud: (
    userId: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("user:sync-phone-type-from-cloud", userId),

  /**
   * BACKLOG-3673: the per-account "setup finished" record for the session user.
   * Takes no user id on purpose: main reads the signed-in session's id.
   */
  getAccountSetup: (): Promise<{
    success: boolean;
    setup: "finished" | "not-finished" | "unknown";
    emailStepAnswered: boolean;
    contactSourceAnswered: boolean;
    error?: string;
  }> => ipcRenderer.invoke("user:get-account-setup"),

  /**
   * BACKLOG-3673: record that setup finished (write-once) for the session user.
   */
  completeAccountSetup: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("user:complete-account-setup"),

  /**
   * BACKLOG-3674: has the session user's account dismissed the dashboard tour?
   * Takes no user id on purpose: main reads the signed-in session's id.
   */
  getTourState: (): Promise<{
    success: boolean;
    tour: "dismissed" | "not-dismissed" | "unknown";
    error?: string;
  }> => ipcRenderer.invoke("user:get-tour-state"),

  /**
   * BACKLOG-3674: record that the session user's account dismissed the tour.
   */
  dismissTour: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("user:dismiss-tour"),
};

/**
 * Notification Bridge
 * Send OS-level notifications
 */
export const notificationBridge = {
  /**
   * Check if notifications are supported
   * @returns Whether notifications are supported on this platform
   */
  isSupported: (): Promise<{ success: boolean; supported: boolean }> =>
    ipcRenderer.invoke("notification:is-supported"),

  /**
   * Send an OS notification
   * @param title - Notification title
   * @param body - Notification body text
   * @returns Send result
   */
  send: (
    title: string,
    body: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("notification:send", title, body),
};

/**
 * Renderer Log Bridge
 * Relays renderer logs to main process log file for debugging
 */
export const logBridge = {
  send: (level: string, message: string): void => {
    ipcRenderer.send("log:renderer", level, message);
  },
};

/**
 * Shell Bridge
 * Interaction with system shell and external applications
 */
export const shellBridge = {
  /**
   * Opens a URL in the default external browser
   * @param url - URL to open
   * @returns Open result
   */
  openExternal: (url: string) =>
    ipcRenderer.invoke("shell:open-external", url),

  /**
   * Opens a URL in a popup window (stays in-app)
   * @param url - URL to open
   * @param title - Optional window title
   * @returns Open result
   */
  openPopup: (url: string, title?: string) =>
    ipcRenderer.invoke("shell:open-popup", url, title),

  /**
   * Opens a folder in Finder/Explorer
   * @param folderPath - Path to folder to open
   * @returns Open result
   */
  openFolder: (folderPath: string) =>
    ipcRenderer.invoke("open-folder", folderPath),

  /**
   * Opens the bundled third-party notices file (BACKLOG-3803).
   * No arguments: the main process decides which file to open.
   * @returns Open result
   */
  openThirdPartyNotices: () =>
    ipcRenderer.invoke("shell:open-third-party-notices"),
};
