/**
 * CCPA Data Export Service
 * TASK-2053: Exports all personal data stored in the local SQLite database
 * as structured JSON for CCPA "right to know" compliance.
 *
 * Data categories exported:
 * - Identifiers (user profile)
 * - Commercial Information (transactions)
 * - Contacts
 * - Electronic Network Activity (messages, emails)
 * - Inferences (AI feedback/analysis)
 * - User Preferences
 * - Audit Trail
 * - Authentication (provider + scope only, NO token values)
 * - External Contacts
 */

import fs from "fs";
import { app } from "electron";
import { getUserById } from "./db/userDbService";
import { getTransactions } from "./db/transactionDbService";
import { getContacts } from "./db/contactDbService";
import { getEmailsByUser } from "./db/emailDbService";
import { getAuditLogs } from "./db/auditLogDbService";
import { getAllForUser as getExternalContacts } from "./db/externalContactDbService";
import { dbAll } from "./db/core/dbConnection";
import logService from "./logService";

// ============================================
// TYPE DEFINITIONS
// ============================================

/** Metadata included in every export */
export interface CcpaExportMetadata {
  exportDate: string;
  appVersion: string;
  userId: string;
  dataCategories: string[];
}

/** A single data category section */
export interface CcpaDataCategory<T = unknown> {
  description: string;
  count?: number;
  records?: T[];
  [key: string]: unknown;
}

/** The full CCPA export structure */
export interface CcpaExportData {
  metadata: CcpaExportMetadata;
  identifiers: CcpaDataCategory;
  commercial_information: CcpaDataCategory;
  contacts: CcpaDataCategory;
  electronic_activity: {
    description: string;
    messages: {
      count: number;
      records: unknown[];
    };
    emails: {
      count: number;
      records: unknown[];
    };
  };
  inferences: {
    description: string;
    feedback: unknown[];
    feedback_learning: unknown[];
  };
  preferences: CcpaDataCategory;
  audit_trail: CcpaDataCategory;
  authentication: {
    description: string;
    connected_providers: Array<{
      provider: string;
      scope: string | null;
      purpose: string | null;
      created_at: string | null;
    }>;
  };
  external_contacts: CcpaDataCategory;
}

/** Progress callback for UI updates */
export type ExportProgressCallback = (category: string, progress: number) => void;

// ============================================
// CATEGORY NAMES
// ============================================

const ALL_CATEGORIES = [
  "identifiers",
  "commercial_information",
  "contacts",
  "electronic_activity",
  "inferences",
  "preferences",
  "audit_trail",
  "authentication",
  "external_contacts",
] as const;

// ============================================
// SERVICE
// ============================================

/**
 * Export all personal data for a user in CCPA-compliant format.
 *
 * @param userId - The user whose data to export
 * @param onProgress - Optional callback for progress updates (category name, 0-100)
 * @returns Structured export data object
 */
export async function exportUserData(
  userId: string,
  onProgress?: ExportProgressCallback,
): Promise<CcpaExportData> {
  const totalCategories = ALL_CATEGORIES.length;
  let completed = 0;

  const reportProgress = (category: string): void => {
    completed++;
    const percent = Math.round((completed / totalCategories) * 100);
    if (onProgress) {
      onProgress(category, percent);
    }
  };

  logService.info(
    `[CcpaExport] Starting data export for user ${userId}`,
    "CcpaExportService",
  );

  // 1. Identifiers (user profile)
  const user = await getUserById(userId);
  const identifiersRecords = user ? [user] : [];
  reportProgress("identifiers");

  // 2. Commercial Information (transactions)
  const transactions = await getTransactions({ user_id: userId });
  reportProgress("commercial_information");

  // 3. Contacts
  // BACKLOG-2365: include_removed. A removed contact is tombstoned, not erased —
  // the row still holds that person's name, company and title. This is the
  // "all personal information we hold about you" export, so omitting tombstoned
  // rows would make it a false statement. Every other caller takes the filtered
  // default.
  const contacts = await getContacts({ user_id: userId, include_removed: true });
  reportProgress("contacts");

  // 4. Electronic Activity (messages + emails)
  const messages = dbAll<unknown>(
    "SELECT * FROM messages WHERE user_id = ? ORDER BY sent_at DESC",
    [userId],
  );
  const emails = await getEmailsByUser(userId);
  reportProgress("electronic_activity");

  // 5. Inferences (feedback + feedback_learning)
  const feedback = dbAll<unknown>(
    "SELECT * FROM classification_feedback WHERE user_id = ?",
    [userId],
  );
  // feedback_learning table may not exist; wrap safely
  let feedbackLearningRecords: unknown[] = [];
  try {
    feedbackLearningRecords = dbAll<unknown>(
      "SELECT * FROM feedback_learning WHERE user_id = ?",
      [userId],
    );
  } catch {
    // Table may not exist - that's OK, return empty
    feedbackLearningRecords = [];
  }
  reportProgress("inferences");

  // 6. User Preferences
  let preferencesRecords: unknown[] = [];
  try {
    preferencesRecords = dbAll<unknown>(
      "SELECT * FROM user_preferences WHERE user_id = ?",
      [userId],
    );
  } catch {
    // Table may not exist or may have different schema
    preferencesRecords = [];
  }
  reportProgress("preferences");

  // 7. Audit Trail
  const auditLogs = await getAuditLogs({ userId, limit: 50000 });
  reportProgress("audit_trail");

  // 8. Authentication (OAuth tokens - EXCLUDE actual token values)
  const oauthTokens = sanitizeOAuthTokens(
    dbAll<Record<string, unknown>>(
      "SELECT provider, purpose, scopes_granted, connected_email_address, permissions_granted_at, created_at FROM oauth_tokens WHERE user_id = ? AND is_active = 1",
      [userId],
    ),
  );
  reportProgress("authentication");

  // 9. External Contacts
  const externalContacts = getExternalContacts(userId);
  reportProgress("external_contacts");

  logService.info(
    `[CcpaExport] Export complete for user ${userId}`,
    "CcpaExportService",
  );

  return {
    metadata: {
      exportDate: new Date().toISOString(),
      appVersion: app.getVersion(),
      userId,
      dataCategories: [...ALL_CATEGORIES],
    },
    identifiers: {
      description: "Personal identification information",
      count: identifiersRecords.length,
      records: identifiersRecords,
    },
    commercial_information: {
      description: "Real estate transaction records",
      count: transactions.length,
      records: transactions,
    },
    contacts: {
      description: "Contacts associated with your transactions",
      count: contacts.length,
      records: contacts,
    },
    electronic_activity: {
      description: "Email and text message records",
      messages: {
        count: messages.length,
        records: messages,
      },
      emails: {
        count: emails.length,
        records: emails,
      },
    },
    inferences: {
      description: "AI-generated analysis and feedback",
      feedback,
      feedback_learning: feedbackLearningRecords,
    },
    preferences: {
      description: "Your application settings and preferences",
      count: preferencesRecords.length,
      records: preferencesRecords,
    },
    audit_trail: {
      description: "Log of your actions in the application",
      count: auditLogs.length,
      records: auditLogs,
    },
    authentication: {
      description: "Connected accounts (token values excluded for security)",
      connected_providers: oauthTokens,
    },
    external_contacts: {
      description: "Contacts imported from external providers",
      count: externalContacts.length,
      records: externalContacts,
    },
  };
}

/**
 * Write export data to a JSON file with readable formatting.
 *
 * @param data - The export data to write
 * @param filePath - Destination file path
 */
export async function writeExportFile(
  data: CcpaExportData,
  filePath: string,
): Promise<void> {
  const jsonString = JSON.stringify(data, null, 2);
  // Use exclusive create (wx) and restrictive permissions to prevent symlink attacks in temp dirs
  await fs.promises.writeFile(filePath, jsonString, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  logService.info(
    `[CcpaExport] Export file written to: ${filePath}`,
    "CcpaExportService",
  );
}

// ============================================
// HELPERS
// ============================================

/**
 * Sanitize OAuth token records - remove actual token values,
 * keep only provider, scope, and timestamps.
 */
function sanitizeOAuthTokens(
  tokens: Record<string, unknown>[],
): Array<{
  provider: string;
  scope: string | null;
  purpose: string | null;
  created_at: string | null;
}> {
  return tokens.map((token) => ({
    provider: String(token.provider || "unknown"),
    scope: token.scopes_granted ? String(token.scopes_granted) : null,
    purpose: token.purpose ? String(token.purpose) : null,
    created_at: token.created_at ? String(token.created_at) : null,
  }));
}
