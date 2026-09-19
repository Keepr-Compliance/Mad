/**
 * LLM Settings Database Service
 * Handles all LLM settings-related database operations
 *
 * SECURITY: API keys are stored encrypted. Encryption/decryption
 * happens in the config service (TASK-311), not here.
 *
 * BACKLOG-2960 (export seam, wave 1 lane A) — every export below returns a
 * PROMISE, and every one of them is a PLAIN function, never `async`.
 *
 * That is not a style choice. `better-sqlite3` commits a transaction when the
 * callback RETURNS. Under an `async` wrapper a failed write resolves the
 * wrapper's promise, the enclosing transaction commits over the error, and the
 * failure arrives later as an unhandled rejection — the BACKLOG-2545 class of
 * defect (SR ruling 79c3aa69 §2a, executed). A plain wrapper lets the throw
 * propagate synchronously, so the driver rolls back.
 *
 * State the failure mode precisely, because the obvious fear is the wrong one:
 * a floated call to one of these from inside a synchronous transaction body
 * does NOT let writes escape the transaction — the synchronous work, the throw
 * included, runs to completion before any microtask. What a floated call loses
 * is the RESOLVED VALUE and nothing else: the settings row, or the `void` a
 * writer resolves with. It cannot lose an error path, because none of these
 * wrappers can reject — every one returns `Promise.resolve(...)`, and every
 * throw happens before that promise is constructed, so it propagates out of the
 * transaction body and the driver rolls back.
 *
 * What DOES lose the error path is making one of these `async`. The throw then
 * arrives after the frame that could have rolled back: the transaction commits
 * over it and the failure surfaces later as a rejection.
 *
 * Both halves were measured on the real driver in the SR review of PR #2544. A
 * plain wrapper floated inside a synchronous `dbTransaction` body: the throw
 * propagated and the body's own write was rolled back. The same call with the
 * wrapper made `async`: the transaction saw no error and COMMITTED, while the
 * failure arrived later as a rejection.
 *
 * The driver conduits (`dbGet`, `dbRun`) stay synchronous and are the only
 * thing under this file that touches SQLite. `readLLMSettings` below is the
 * shared synchronous read-back; it is deliberately NOT exported and NOT named
 * `*Sync`, because this module has no transaction body and therefore needs no
 * twin (syncTwin.guard.test.ts).
 */

import crypto from "crypto";
import type { LLMSettings } from "../../types/models";
import { DatabaseError } from "../../types";
import { dbGet, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { joinFragments } from "./core/sqlFragments";

/**
 * The `llm_settings` columns this module writes, as SQL text — BACKLOG-3085.
 *
 * `llm_settings` is not one of `sqlFieldWhitelist`'s tables, so it enumerates its
 * own writable columns here. This object is now the SINGLE definition: the runtime
 * allow-list, the literal union, and the SQL text are all read off it, so a column
 * can no longer be accepted by one and missing from another — which is the same
 * shape `CLEARABLE_LLM_SETTINGS_COLUMNS` below already uses, and the reason a
 * column name can be spliced into a statement without the tag having to trust it.
 */
const LLM_SETTINGS_COLUMN_SQL = {
  openai_api_key_encrypted: sql`openai_api_key_encrypted`,
  anthropic_api_key_encrypted: sql`anthropic_api_key_encrypted`,
  preferred_provider: sql`preferred_provider`,
  openai_model: sql`openai_model`,
  anthropic_model: sql`anthropic_model`,
  tokens_used_this_month: sql`tokens_used_this_month`,
  budget_limit_tokens: sql`budget_limit_tokens`,
  budget_reset_date: sql`budget_reset_date`,
  platform_allowance_tokens: sql`platform_allowance_tokens`,
  platform_allowance_used: sql`platform_allowance_used`,
  use_platform_allowance: sql`use_platform_allowance`,
  enable_auto_detect: sql`enable_auto_detect`,
  enable_role_extraction: sql`enable_role_extraction`,
  llm_data_consent: sql`llm_data_consent`,
  llm_data_consent_at: sql`llm_data_consent_at`,
};

type LLMSettingsColumn = keyof typeof LLM_SETTINGS_COLUMN_SQL;


/**
 * The synchronous read every writer below uses for its read-back.
 *
 * Private on purpose. The exported reader is the promise-returning wrapper over
 * it; keeping the primitive synchronous is what lets the writers compose
 * without any of them becoming `async`.
 */
function readLLMSettings(userId: string): LLMSettings | null {
  const statement = sql`SELECT * FROM llm_settings WHERE user_id = ?`;
  const row = dbGet<Record<string, unknown>>(statement, [userId]);
  return row ? mapRowToLLMSettings(row) : null;
}

/**
 * Get LLM settings for a user
 */
export function getLLMSettingsByUserId(
  userId: string,
): Promise<LLMSettings | null> {
  return Promise.resolve(readLLMSettings(userId));
}

/**
 * Create default LLM settings for a user
 */
export function createLLMSettings(userId: string): Promise<LLMSettings> {
  const id = crypto.randomUUID();

  const statement = sql`
    INSERT INTO llm_settings (id, user_id)
    VALUES (?, ?)
  `;

  dbRun(statement, [id, userId]);

  // Return the created settings
  const settings = readLLMSettings(userId);
  if (!settings) {
    throw new Error(`Failed to create LLM settings for user ${userId}`);
  }
  return Promise.resolve(settings);
}

/**
 * Get or create LLM settings for a user
 */
export function getOrCreateLLMSettings(userId: string): Promise<LLMSettings> {
  const existing = readLLMSettings(userId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return createLLMSettings(userId);
}

/**
 * Update LLM settings for a user
 */
export function updateLLMSettings(
  userId: string,
  updates: Partial<Omit<LLMSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): Promise<LLMSettings> {
  const allowedFields = Object.keys(LLM_SETTINGS_COLUMN_SQL) as LLMSettingsColumn[];

  // Filter to only allowed fields that are present in updates
  const fieldsToUpdate = allowedFields.filter(
    (key) => key in updates && updates[key as keyof typeof updates] !== undefined
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

  const setClause = joinFragments(
    fieldsToUpdate.map((f) => sql`${LLM_SETTINGS_COLUMN_SQL[f]} = ?`),
    sql`, `,
  );

  const statement = sql`
    UPDATE llm_settings
    SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

  dbRun(statement, [...values, userId]);

  const settings = readLLMSettings(userId);
  if (!settings) {
    throw new Error(`LLM settings not found for user ${userId}`);
  }
  return Promise.resolve(settings);
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
): Promise<LLMSettings> {
  // The union makes a bad column a compile error; this guards the JS callers and
  // any `as` cast that gets past it, and is what keeps the interpolation below
  // safe.
  if (!(CLEARABLE_LLM_SETTINGS_COLUMNS as readonly string[]).includes(column)) {
    throw new DatabaseError(`Column is not clearable: ${column}`);
  }

  const statement = sql`
    UPDATE llm_settings
    SET ${LLM_SETTINGS_COLUMN_SQL[column]} = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

  dbRun(statement, [userId]);

  const settings = readLLMSettings(userId);
  if (!settings) {
    throw new DatabaseError(`LLM settings not found for user ${userId}`);
  }
  return Promise.resolve(settings);
}

/**
 * Increment token usage for a user
 */
export function incrementTokenUsage(userId: string, tokens: number): Promise<void> {
  const statement = sql`
    UPDATE llm_settings
    SET tokens_used_this_month = tokens_used_this_month + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(statement, [tokens, userId])
  return Promise.resolve();
}

/**
 * Increment platform allowance usage for a user
 */
export function incrementPlatformAllowanceUsage(userId: string, tokens: number): Promise<void> {
  const statement = sql`
    UPDATE llm_settings
    SET platform_allowance_used = platform_allowance_used + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(statement, [tokens, userId])
  return Promise.resolve();
}

/**
 * Reset monthly token usage for a user
 */
export function resetMonthlyUsage(userId: string): Promise<void> {
  const statement = sql`
    UPDATE llm_settings
    SET tokens_used_this_month = 0,
        budget_reset_date = DATE('now'),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(statement, [userId])
  return Promise.resolve();
}

/**
 * Set LLM data consent for a user
 */
export function setLLMDataConsent(userId: string, consent: boolean): Promise<LLMSettings> {
  const statement = sql`
    UPDATE llm_settings
    SET llm_data_consent = ?,
        llm_data_consent_at = ${consent ? sql`CURRENT_TIMESTAMP` : sql`NULL`},
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;
  dbRun(statement, [consent ? 1 : 0, userId]);

  const settings = readLLMSettings(userId);
  if (!settings) {
    throw new Error(`LLM settings not found for user ${userId}`);
  }
  return Promise.resolve(settings);
}

/**
 * Delete LLM settings for a user
 */
export function deleteLLMSettings(userId: string): Promise<void> {
  const statement = sql`DELETE FROM llm_settings WHERE user_id = ?`;
  dbRun(statement, [userId])
  return Promise.resolve();
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
