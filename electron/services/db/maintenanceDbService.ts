/**
 * Maintenance Database Service
 * Handles database maintenance operations (reindex, analyze, etc.)
 */

import { hostErrorReporter } from "../../capabilities/errorReporterProvider";
import { ensureDb } from "./core/dbConnection";
import logService from "../logService";

// ============================================
// DATABASE MAINTENANCE OPERATIONS
// ============================================

/**
 * Reindex all performance indexes
 * Recreates indexes that optimize query performance for contacts, communications, and messages.
 * This can help resolve slowness caused by fragmented or outdated indexes.
 *
 * @returns Object with reindex results including index count and duration
 */
export async function reindexDatabase(): Promise<{
  success: boolean;
  indexesRebuilt: number;
  durationMs: number;
  error?: string;
}> {
  const db = ensureDb();
  const startTime = Date.now();
  let indexesRebuilt = 0;

  try {
    await logService.info("Starting database reindex operation", "maintenanceDbService");

    // Performance indexes -- drop and recreate to ensure fresh, optimized indexes
    const performanceIndexes = [
      // Contact indexes
      { name: "idx_contacts_user_id", sql: "CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id)" },
      { name: "idx_contact_emails_contact_id", sql: "CREATE INDEX IF NOT EXISTS idx_contact_emails_contact_id ON contact_emails(contact_id)" },
      { name: "idx_contact_emails_email", sql: "CREATE INDEX IF NOT EXISTS idx_contact_emails_email ON contact_emails(email)" },
      { name: "idx_contact_phones_contact_id", sql: "CREATE INDEX IF NOT EXISTS idx_contact_phones_contact_id ON contact_phones(contact_id)" },
      // Communication indexes (pure junction table -- no sender/sent_at columns)
      { name: "idx_communications_user_id", sql: "CREATE INDEX IF NOT EXISTS idx_communications_user_id ON communications(user_id)" },
      { name: "idx_communications_transaction", sql: "CREATE INDEX IF NOT EXISTS idx_communications_transaction ON communications(transaction_id)" },
      // Message indexes
      { name: "idx_messages_user_id", sql: "CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)" },
      { name: "idx_messages_sent_at", sql: "CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)" },
      { name: "idx_messages_thread_id", sql: "CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)" },
      { name: "idx_messages_user_sent", sql: "CREATE INDEX IF NOT EXISTS idx_messages_user_sent ON messages(user_id, sent_at)" },
      { name: "idx_messages_channel", sql: "CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel)" },
    ];

    // Use a transaction for consistency
    const runReindex = db.transaction(() => {
      for (const index of performanceIndexes) {
        // Drop the existing index if it exists
        db.prepare(`DROP INDEX IF EXISTS ${index.name}`).run();
        // Recreate the index
        db.prepare(index.sql).run();
        indexesRebuilt++;
      }

      // Run ANALYZE to update statistics used by the query planner
      db.prepare("ANALYZE").run();
    });
    runReindex();

    const durationMs = Date.now() - startTime;
    await logService.info(
      `Database reindex completed: ${indexesRebuilt} indexes rebuilt in ${durationMs}ms`,
      "maintenanceDbService"
    );

    return {
      success: true,
      indexesRebuilt,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logService.error("Database reindex failed", "maintenanceDbService", {
      error: errorMessage,
      indexesRebuilt,
      durationMs,
    });
    hostErrorReporter.captureException(error, {
      tags: { service: "maintenance-db-service", operation: "reindexDatabase" },
    });

    return {
      success: false,
      indexesRebuilt,
      durationMs,
      error: errorMessage,
    };
  }
}
