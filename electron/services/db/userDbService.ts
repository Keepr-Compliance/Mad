/**
 * User Database Service
 * Handles all user-related database operations
 */

import crypto from "crypto";
import type { User, NewUser, OAuthProvider } from "../../types";
import { DatabaseError, NotFoundError } from "../../types";
import { dbGet, dbRun, ensureDb } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import {
  validateFields,
  type ColumnOf,
  type FieldExpression,
} from "../../utils/sqlFieldWhitelist";
import { UserSchema, validateResponse } from "../../schemas";
import logService from "../logService";
import { assignmentList } from "./core/columnSql";

/**
 * Create a new user
 *
 * TASK-1507G: Accept optional ID parameter to unify user IDs across local SQLite and Supabase.
 * When creating users via OAuth or deep link auth, pass the Supabase Auth UUID as the ID
 * to ensure consistent IDs for FK constraints (licenses, devices, etc.)
 *
 * @param userData - User data including optional ID (Supabase Auth UUID when available)
 */
export async function createUser(userData: NewUser & { id?: string }): Promise<User> {
  const id = userData.id || crypto.randomUUID();
  const statement = sql`
    INSERT INTO users_local (
      id, email, first_name, last_name, display_name, avatar_url,
      oauth_provider, oauth_id, subscription_tier, subscription_status,
      trial_ends_at, timezone, theme, company, job_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    userData.email,
    userData.first_name || null,
    userData.last_name || null,
    userData.display_name || null,
    userData.avatar_url || null,
    userData.oauth_provider,
    userData.oauth_id,
    userData.subscription_tier || "free",
    userData.subscription_status || "trial",
    userData.trial_ends_at || null,
    userData.timezone || "America/Los_Angeles",
    userData.theme || "light",
    userData.company || null,
    userData.job_title || null,
  ];

  dbRun(statement, params);
  const user = await getUserById(id);
  if (!user) {
    throw new DatabaseError("Failed to create user");
  }
  return user;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const statement = sql`SELECT * FROM users_local WHERE id = ?`;
  const user = dbGet<User>(statement, [userId]);
  if (!user) return null;
  return validateResponse(UserSchema, user, 'userDbService.getUserById') as User;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const statement = sql`SELECT * FROM users_local WHERE email = ?`;
  const user = dbGet<User>(statement, [email]);
  return user || null;
}

/**
 * Get user by OAuth provider and ID
 */
export async function getUserByOAuthId(
  provider: OAuthProvider,
  oauthId: string,
): Promise<User | null> {
  const statement =
    sql`SELECT * FROM users_local WHERE oauth_provider = ? AND oauth_id = ?`;
  const user = dbGet<User>(statement, [provider, oauthId]);
  return user || null;
}

/**
 * Update user data
 */
export async function updateUser(
  userId: string,
  updates: Partial<User>,
): Promise<void> {
  const allowedFields: readonly ColumnOf<"users_local">[] = [
    "email",
    "first_name",
    "last_name",
    "display_name",
    "avatar_url",
    "subscription_tier",
    "subscription_status",
    "trial_ends_at",
    "timezone",
    "theme",
    "notification_preferences",
    "company",
    "job_title",
    "last_cloud_sync_at",
    "terms_accepted_at",
    "privacy_policy_accepted_at",
    "terms_version_accepted",
    "privacy_policy_version_accepted",
    "email_onboarding_completed_at",
    "mobile_phone_type",
    // License fields (BACKLOG-426)
    "license_type",
    "ai_detection_enabled",
    "organization_id",
  ];

  const columns: ColumnOf<"users_local">[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    const column = allowedFields.find((allowed) => allowed === key);
    if (column) {
      columns.push(column);
      values.push((updates as Record<string, unknown>)[key]);
    }
  });

  if (columns.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate column names against the whitelist before SQL construction.
  //
  // BACKLOG-3085 retires the BACKLOG-2739 Phase 1 seam cast that used to sit
  // here. `columns` is now the column UNION rather than `string[]`, because the
  // SET clause is built by `assignmentList` from the enumerated column
  // fragments — so there is nothing left to cast. The runtime check stays: it
  // is for names that arrive from outside the type system, which the types
  // cannot see. See `sqlFieldWhitelist.ts`'s own header.
  validateFields("users_local", columns);

  values.push(userId);

  const statement = sql`UPDATE users_local SET ${assignmentList(columns)} WHERE id = ?`;
  dbRun(statement, values);
}

/**
 * Delete user
 */
export async function deleteUser(userId: string): Promise<void> {
  const statement = sql`DELETE FROM users_local WHERE id = ?`;
  dbRun(statement, [userId]);
}

/**
 * Update last login timestamp
 */
export async function updateLastLogin(userId: string): Promise<void> {
  const statement = sql`
    UPDATE users_local
    SET last_login_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  dbRun(statement, [userId]);
}

/**
 * Accept terms and conditions for a user
 */
export async function acceptTerms(
  userId: string,
  termsVersion: string,
  privacyVersion: string,
): Promise<User> {
  const statement = sql`
    UPDATE users_local
    SET terms_accepted_at = CURRENT_TIMESTAMP,
        terms_version_accepted = ?,
        privacy_policy_accepted_at = CURRENT_TIMESTAMP,
        privacy_policy_version_accepted = ?
    WHERE id = ?
  `;
  dbRun(statement, [termsVersion, privacyVersion, userId]);
  const user = await getUserById(userId);
  if (!user) {
    throw new NotFoundError("User not found after accepting terms", "User", userId);
  }
  return user;
}

/**
 * Mark email onboarding as completed for a user
 */
export async function completeEmailOnboarding(userId: string): Promise<void> {
  const statement = sql`
    UPDATE users_local
    SET email_onboarding_completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  dbRun(statement, [userId]);
}

/**
 * Check if user has completed email onboarding
 */
export async function hasCompletedEmailOnboarding(
  userId: string,
): Promise<boolean> {
  const statement = sql`
    SELECT email_onboarding_completed_at
    FROM users_local
    WHERE id = ?
  `;
  const result = dbGet<{ email_onboarding_completed_at: string | null }>(statement, [
    userId,
  ]);
  return (
    result?.email_onboarding_completed_at !== null &&
    result?.email_onboarding_completed_at !== undefined
  );
}

/**
 * Migrate a local user's ID to match Supabase auth.uid()
 * BACKLOG-600: This handles users created before TASK-1507G (user ID unification)
 *
 * Updates all FK references across tables:
 * - users_local (primary)
 * - messages, contacts, transactions, emails, etc.
 * - sessions, oauth_tokens, email_accounts
 *
 * @param oldUserId - The current local user ID
 * @param newUserId - The Supabase auth.uid() to migrate to
 */
export async function migrateUserIdForUnification(oldUserId: string, newUserId: string): Promise<void> {
  const db = ensureDb();

  try {
    // CRITICAL: Disable FK checks during migration to avoid circular dependency issues
    // The old ID is referenced by child tables, and we need to update both parent and children
    db.pragma("foreign_keys = OFF");

    // Use a transaction to ensure atomicity
    const migrate = db.transaction(() => {
      // Update the users_local table FIRST (the primary record)
      // With FK checks off, this won't cause issues
      db.prepare("UPDATE users_local SET id = ? WHERE id = ?").run(newUserId, oldUserId);
      logService.info("[DB Migration] Updated users_local primary record", "userDbService");

      // Tables with user_id FK that need to be updated
      const tablesToUpdate = [
        "messages",
        "contacts",
        "contact_phones",
        "contact_emails",
        "transactions",
        "emails",
        "communications",
        "sessions",
        "oauth_tokens",
        "email_accounts",
        "user_preferences",
        "external_contacts",
        "attachments",
        "audit_logs_local",
      ];

      for (const table of tablesToUpdate) {
        try {
          // Check if table exists and has user_id column
          const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          const hasUserId = tableInfo.some((col) => col.name === "user_id");

          if (hasUserId) {
            const result = db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(newUserId, oldUserId);
            if (result.changes > 0) {
              logService.info(`[DB Migration] Updated ${result.changes} rows in ${table}`, "userDbService");
            }
          }
        } catch (tableError) {
          // Table might not exist, skip it
          logService.debug(`[DB Migration] Skipping table ${table}: ${tableError}`, "userDbService");
        }
      }
    });

    try {
      migrate();
      logService.info("[DB Migration] User ID migration completed successfully", "userDbService", {
        oldId: oldUserId.substring(0, 8) + "...",
        newId: newUserId.substring(0, 8) + "...",
      });
    } catch (error) {
      logService.error("[DB Migration] User ID migration failed, rolled back", "userDbService", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    // CRITICAL: Re-enable FK checks
    db.pragma("foreign_keys = ON");
  }
}
