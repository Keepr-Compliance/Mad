/**
 * Settings Service
 *
 * Service abstraction for user preferences and settings-related API calls.
 * Centralizes all window.api.preferences and window.api.user calls.
 */

import { type ApiResult, getErrorMessage } from "./index";

/**
 * Phone type for mobile device preference
 */
export type PhoneType = "iphone" | "android";

/**
 * Import source preference (TASK-1742, BACKLOG-1447)
 * - 'macos-native': Import from macOS Messages.app and Contacts (default)
 * - 'iphone-sync': Import from connected iPhone via backup
 * - 'android-companion': Import from Android phone via WiFi companion app
 */
export type ImportSource = "macos-native" | "iphone-sync" | "android-companion";

/**
 * Messages-related preferences
 */
export interface MessagesPreferences {
  source?: ImportSource;
}

/**
 * Audit-related preferences (TASK-1980)
 */
export interface AuditPreferences {
  startDateDefault?: "auto" | "manual";
}

/**
 * Contact source preferences for direct (non-email) contact import (TASK-2098)
 */
export interface ContactSourceDirectPreferences {
  macosContacts?: boolean;
  outlookContacts?: boolean;
  googleContacts?: boolean;
}

/**
 * Contact source preferences (TASK-2098)
 */
export interface ContactSourcePreferences {
  direct?: ContactSourceDirectPreferences;
}

/**
 * Contact auto-role preferences (TASK-1397)
 */
export interface ContactAutoRolePreferences {
  enabled?: boolean;
}

/**
 * Export preferences (BACKLOG-1551)
 */
export interface ExportPreferences {
  defaultFormat?: string;
  emailExportMode?: "thread" | "individual";
  contentType?: "both" | "emails" | "texts";
  attachmentType?: "all" | "email" | "text" | "none";
}

/**
 * Integrations preferences (BACKLOG-1706)
 *
 * Gates optional device-integration features that should be opt-in on some
 * platforms. `iphoneSyncEnabled` controls whether the iPhone cable-sync panel
 * renders and whether device detection/polling runs. When unset, the effective
 * value is resolved per-platform + import-source (see resolveIphoneSyncEnabled).
 */
export interface IntegrationsPreferences {
  /** Whether iPhone-over-USB detection/sync is enabled. Unset = platform default. */
  iphoneSyncEnabled?: boolean;
}

/**
 * User preferences object
 */
export interface UserPreferences {
  messages?: MessagesPreferences;
  audit?: AuditPreferences;
  contactSources?: ContactSourcePreferences;
  contactAutoRole?: ContactAutoRolePreferences;
  export?: ExportPreferences;
  integrations?: IntegrationsPreferences;
  [key: string]: unknown;
}

/**
 * Settings Service
 * Provides a clean abstraction over window.api.preferences and window.api.user
 */
export const settingsService = {
  // ============================================
  // PREFERENCES METHODS
  // ============================================

  /**
   * Get all user preferences
   */
  async getPreferences(userId: string): Promise<ApiResult<UserPreferences>> {
    try {
      const result = await window.api.preferences.get(userId);
      if (result.success) {
        return { success: true, data: result.preferences || {} };
      }
      return { success: false, error: "Failed to get preferences" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Save all user preferences (full replace)
   */
  async savePreferences(
    userId: string,
    preferences: UserPreferences
  ): Promise<ApiResult> {
    try {
      const result = await window.api.preferences.save(userId, preferences);
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Update user preferences (partial update)
   */
  async updatePreferences(
    userId: string,
    partialPreferences: UserPreferences
  ): Promise<ApiResult> {
    try {
      const result = await window.api.preferences.update(userId, partialPreferences);
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // USER SETTINGS METHODS
  // ============================================

  /**
   * Get user's phone type preference
   */
  async getPhoneType(userId: string): Promise<ApiResult<PhoneType | null>> {
    try {
      const result = await window.api.user.getPhoneType(userId);
      if (result.success) {
        return { success: true, data: result.phoneType };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Set user's phone type preference (local DB)
   */
  async setPhoneType(userId: string, phoneType: PhoneType): Promise<ApiResult> {
    try {
      const result = await window.api.user.setPhoneType(userId, phoneType);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // CONTACT AUTO-ROLE METHODS (TASK-1397)
  // ============================================

  /**
   * Get whether contact auto-role is enabled (defaults to false)
   */
  async getContactAutoRoleEnabled(userId: string): Promise<boolean> {
    try {
      const result = await this.getPreferences(userId);
      if (result.success && result.data) {
        return result.data.contactAutoRole?.enabled === true;
      }
      return false;
    } catch {
      return false;
    }
  },

  /**
   * Set contact auto-role enabled/disabled
   */
  async setContactAutoRoleEnabled(
    userId: string,
    enabled: boolean
  ): Promise<ApiResult<void>> {
    try {
      const result = await this.updatePreferences(userId, {
        contactAutoRole: { enabled },
      });
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // IPHONE SYNC INTEGRATION METHODS (BACKLOG-1706)
  // ============================================

  /**
   * Get the raw `integrations.iphoneSyncEnabled` preference.
   * Returns `undefined` when the user has never set it explicitly, so callers
   * can apply a platform/import-source default (see resolveIphoneSyncEnabled).
   */
  async getIphoneSyncEnabledPref(userId: string): Promise<boolean | undefined> {
    try {
      const result = await this.getPreferences(userId);
      if (result.success && result.data) {
        const val = result.data.integrations?.iphoneSyncEnabled;
        return typeof val === "boolean" ? val : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  },

  /**
   * Persist the explicit iPhone-sync opt-in preference.
   */
  async setIphoneSyncEnabled(
    userId: string,
    enabled: boolean
  ): Promise<ApiResult<void>> {
    try {
      const result = await this.updatePreferences(userId, {
        integrations: { iphoneSyncEnabled: enabled },
      });
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Set user's phone type preference to Supabase cloud.
   * Used during onboarding before local DB is initialized.
   * This ensures phone type is persisted even before keychain setup.
   */
  async setPhoneTypeCloud(userId: string, phoneType: PhoneType): Promise<ApiResult> {
    try {
      const userApi = window.api.user as typeof window.api.user & {
        setPhoneTypeCloud: (
          userId: string,
          phoneType: PhoneType
        ) => Promise<{ success: boolean; error?: string }>;
      };
      const result = await userApi.setPhoneTypeCloud(userId, phoneType);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },
};

export default settingsService;
