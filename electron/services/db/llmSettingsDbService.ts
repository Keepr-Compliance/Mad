/**
 * LLM Settings Database Service
 * Handles all LLM settings-related database operations
 *
 * SECURITY: API keys are stored encrypted. Encryption/decryption
 * happens in the config service (TASK-311), not here.
 */

import crypto from "crypto";
import type { LLMSettings } from "../../types/models";
import { DatabaseError } from "../../types";
import { dbGet, dbRun } from "./core/dbConnection";

/**
 * Get LLM settings for a user
 */
export function getLLMSettingsByUserId(userId: string): LLMSettings | null {
  const sql = `SELECT * FROM llm_settings WHERE user_id = ?`;
  const row = dbGet<Record<string, unknown>>(sql, [userId]);
  return row ? mapRowToLLMSettings(row) : null;
}

/**
 * Create default LLM settings for a user
 */
export function createLLMSettings(userId: string): LLMSettings {
  const id = crypto.randomUUID();

  const sql = `
    INSERT INTO llm_settings (id, user_id)
    VALUES (?, ?)
  `;

  dbRun(sql, [id, userId]);

  // Return the created settings
  const settings = getLLMSettingsByUserId(userId);
  if (!settings) {
    throw new Error(`Failed to create LLM settings for user ${userId}`);
  }
  return settings;
}

/**
 * Get or create LLM settings for a user
 */
export function getOrCreateLLMSettings(userId: string): LLMSettings {
  const existing = getLLMSettingsByUserId(userId);
  if (existing) {
    return existing;
  }
  return createLLMSettings(userId);
}

/**
 * Update LLM settings for a user
 */
export function updateLLMSettings(
  userId: string,
  updates: Partial<Omit<LLMSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): LLMSettings {
  const allowedFields = [
    'openai_api_key_encrypted',
    'anthropic_api_key_encrypted',
    'preferred_provider',
    'openai_model',
    'anthropic_model',
    'tokens_used_this_month',
    'budget_limit_tokens',
    'budget_reset_date',
    'platform_allowance_tokens',
    'platform_allowance_used',
    'use_platform_allowance',
    'enable_auto_detect',
    'enable_role_extraction',
    'llm_data_consent',
    'llm_data_consent_at',
  ];

  // Filter to only allowed fields that are present in updates
  const fieldsToUpdate = Object.keys(updates).filter(
    (key) => allowedFields.includes(key) && updates[key as keyof typeof updates] !== undefined
  );

  // BACKLOG-2560: this used to return the CURRENT settings as a success value
  // without ever calling `dbRun`. Every caller then reported success for a write
  // that never happened — BACKLOG-2932 is what that cost: Settings > AI > Remove
  // said the API key was gone while the row still held it. Throwing here matches
  // `updateUser`, `updateCommunication` and the rest of `db/`.
  //
  // Reachability was checked before this landed: `removeApiKey` now uses
  // `clearLLMSettingsField` below, and all five `handlePreferenceUpdate` call
  // sites in `LLMSettings.tsx` (:697, :718, :738, :750, :759) pass exactly one
  // defined key, so `updatePreferences` cannot arrive here empty.
  if (fieldsToUpdate.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Convert boolean fields to integers for SQLite
  const booleanFields = ['use_platform_allowance', 'enable_auto_detect', 'enable_role_extraction', 'llm_data_consent'];
  const values = fieldsToUpdate.map((field) => {
    const value = updates[field as keyof typeof updates];
    if (booleanFields.includes(field) && typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value;
  });

  const setClause = fieldsToUpdate.map((f) => `${f} = ?`).join(', ');

  const sql = `
    UPDATE llm_settings
    SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

  dbRun(sql, [...values, userId]);

  const settings = getLLMSettingsByUserId(userId);
  if (!settings) {
    throw new Error(`LLM settings not found for user ${userId}`);
  }
  return settings;
}

/**
 * The columns a caller may set back to NULL.
 *
 * ONE definition: the `as const` array is the runtime guard AND the source of
 * the literal union, so a name can never be accepted by one and rejected by the
 * other. Same shape as `TABLE_FIELDS` after BACKLOG-2739 (PR #2322).
 */
const CLEARABLE_LLM_SETTINGS_COLUMNS = [
  "openai_api_key_encrypted",
  "anthropic_api_key_encrypted",
] as const;

export type ClearableLLMSettingsColumn =
  (typeof CLEARABLE_LLM_SETTINGS_COLUMNS)[number];

/**
 * Clear one column back to NULL.
 *
 * BACKLOG-2932. `updateLLMSettings` takes `Partial<LLMSettings>` and skips every
 * `undefined` value, so "remove this key" was inexpressible through it: passing
 * `{ openai_api_key_encrypted: undefined }` dropped the only field and wrote
 * nothing. A separate verb makes clearing a real operation instead of a value
 * the update path has to guess at, and keeps `undefined` meaning "not supplied"
 * everywhere.
 */
export function clearLLMSettingsField(
  userId: string,
  column: ClearableLLMSettingsColumn
): LLMSettings {
  // The union makes a bad column a compile error; this guards the JS callers and
  // any `as` cast that gets past it, and is what keeps the interpolation below
  // safe.
  if (!(CLEARABLE_LLM_SETTINGS_COLUMNS as readonly string[]).includes(column)) {
    throw new DatabaseError(`Column is not clearable: ${column}`);
  }

  const sql = `
    UPDATE llm_settings
    SET ${column} = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

  dbRun(sql, [userId]);

  const settings = getLLMSettingsByUserId(userId);
  if (!settings) {
    throw new DatabaseError(`LLM settings not found for user ${userId}`);
  }
  return settings;
}

/**
 * Increment token usage for a user
 */
export function incrementTokenUsage(userId: string, tokens: number): void {
  const sql = `
    UPDATE llm_settings
    SET tokens_used_this_month = tokens_used_this_month + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(sql, [tokens, userId]);
}

/**
 * Increment platform allowance usage for a user
 */
export function incrementPlatformAllowanceUsage(userId: string, tokens: number): void {
  const sql = `
    UPDATE llm_settings
    SET platform_allowance_used = platform_allowance_used + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(sql, [tokens, userId]);
}

/**
 * Reset monthly token usage for a user
 */
export function resetMonthlyUsage(userId: string): void {
  const sql = `
    UPDATE llm_settings
    SET tokens_used_this_month = 0,
        budget_reset_date = DATE('now'),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(sql, [userId]);
}

/**
 * Set LLM data consent for a user
 */
export function setLLMDataConsent(userId: string, consent: boolean): LLMSettings {
  const sql = `
    UPDATE llm_settings
    SET llm_data_consent = ?,
        llm_data_consent_at = ${consent ? "CURRENT_TIMESTAMP" : "NULL"},
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(sql, [consent ? 1 : 0, userId]);

  const settings = getLLMSettingsByUserId(userId);
  if (!settings) {
    throw new Error(`LLM settings not found for user ${userId}`);
  }
  return settings;
}

/**
 * Delete LLM settings for a user
 */
export function deleteLLMSettings(userId: string): void {
  const sql = `DELETE FROM llm_settings WHERE user_id = ?`;
  dbRun(sql, [userId]);
}

/**
 * Map database row to LLMSettings type
 * Converts SQLite INTEGER (0/1) to boolean for boolean fields
 */
function mapRowToLLMSettings(row: Record<string, unknown>): LLMSettings {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    openai_api_key_encrypted: row.openai_api_key_encrypted as string | undefined,
    anthropic_api_key_encrypted: row.anthropic_api_key_encrypted as string | undefined,
    preferred_provider: row.preferred_provider as 'openai' | 'anthropic',
    openai_model: row.openai_model as string,
    anthropic_model: row.anthropic_model as string,
    tokens_used_this_month: row.tokens_used_this_month as number,
    budget_limit_tokens: row.budget_limit_tokens as number | undefined,
    budget_reset_date: row.budget_reset_date as string | undefined,
    platform_allowance_tokens: row.platform_allowance_tokens as number,
    platform_allowance_used: row.platform_allowance_used as number,
    use_platform_allowance: Boolean(row.use_platform_allowance),
    enable_auto_detect: Boolean(row.enable_auto_detect),
    enable_role_extraction: Boolean(row.enable_role_extraction),
    llm_data_consent: Boolean(row.llm_data_consent),
    llm_data_consent_at: row.llm_data_consent_at as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
