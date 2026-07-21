/**
 * Audit Service
 * Centralized audit logging system that tracks all security-relevant user actions
 * with "who, what, when, where" attribution.
 *
 * Key features:
 * - Append-only local logging (immutable)
 * - Cloud sync to Supabase when online
 * - Queue mechanism for offline operation
 */

import crypto from "crypto";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";

// ============================================
// TYPES
// ============================================

/**
 * Audit actions representing security-relevant user operations
 */
export type AuditAction =
  | "LOGIN"
  | "LOGOUT"
  | "LOGIN_FAILED"
  | "DATA_ACCESS"
  | "DATA_EXPORT"
  | "DATA_DELETE"
  | "TRANSACTION_CREATE"
  | "TRANSACTION_UPDATE"
  | "TRANSACTION_DELETE"
  | "TRANSACTION_SUBMIT"
  | "CONTACT_CREATE"
  | "CONTACT_UPDATE"
  | "CONTACT_DELETE"
  | "SETTINGS_CHANGE"
  | "MAILBOX_CONNECT"
  | "MAILBOX_DISCONNECT";

/**
 * Resource types that can be audited
 */
export type ResourceType =
  | "USER"
  | "SESSION"
  | "TRANSACTION"
  | "CONTACT"
  | "COMMUNICATION"
  | "EXPORT"
  | "SUBMISSION"
  | "MAILBOX"
  | "SETTINGS";

/**
 * Complete audit log entry with all fields
 */
export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  userId: string;
  sessionId?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMessage?: string;
  syncedAt?: Date;
}

/**
 * Input for creating a new audit log entry (excludes auto-generated fields)
 */
export type NewAuditLogEntry = Omit<
  AuditLogEntry,
  "id" | "timestamp" | "syncedAt"
>;

/**
 * Database representation of audit log entry
 */
export interface AuditLogDbRow {
  id: string;
  timestamp: string;
  user_id: string;
  session_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: string | null;
  ip_address: string | null;
  user_agent: string | null;
  success: number;
  error_message: string | null;
  synced_at: string | null;
}

// ============================================
// DATABASE SERVICE INTERFACE
// ============================================

/**
 * Interface for database operations that AuditService needs
 * This allows for dependency injection and testing
 */
interface IDatabaseService {
  insertAuditLog(entry: AuditLogEntry): Promise<void>;
  getUnsyncedAuditLogs(limit?: number): Promise<AuditLogEntry[]>;
  markAuditLogsSynced(ids: string[]): Promise<void>;
  // BACKLOG-2149: audit writes race DB init on the deep-link path — gate on this.
  isInitialized(): boolean;
}

/**
 * Interface for Supabase operations that AuditService needs
 */
interface ISupabaseService {
  batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void>;
}

// ============================================
// AUDIT SERVICE CLASS
// ============================================

class AuditService {
  private pendingSyncQueue: AuditLogEntry[] = [];
  private syncInProgress = false;
  private syncIntervalId: NodeJS.Timeout | null = null;
  private databaseService: IDatabaseService | null = null;
  private supabaseService: ISupabaseService | null = null;
  private initialized = false;

  // BACKLOG-2149: On the deep-link auth path, audit writes can fire BEFORE
  // DatabaseService.initialize() completes (memory pressure slows init). Rather
  // than throwing "Database is not initialized" and LOSING the entry, we buffer
  // entries here and flush them once the DB is queryable. Bounded so a DB that
  // never comes up can't grow this without limit.
  private pendingLocalWrites: AuditLogEntry[] = [];
  private flushingPendingWrites = false;

  private readonly SYNC_INTERVAL_MS = 60000; // 1 minute
  private readonly SYNC_BATCH_SIZE = 100;
  // Max audit entries buffered while the DB is initializing. Oldest are dropped
  // past this to bound memory; audit is append-only best-effort, not critical path.
  private readonly MAX_PENDING_LOCAL_WRITES = 500;
  // Short bound (ms) to wait for the DB before buffering a write. Keeps log()
  // responsive; if the DB isn't ready quickly we defer and flush later.
  private readonly DB_READY_WAIT_MS = 5000;

  /**
   * Initialize the audit service with required dependencies
   */
  initialize(
    databaseService: IDatabaseService,
    supabaseService: ISupabaseService,
  ): void {
    if (this.initialized) {
      return;
    }

    this.databaseService = databaseService;
    this.supabaseService = supabaseService;
    this.initialized = true;

    // Start periodic sync
    this.startSyncInterval();

    logService.debug("Audit service initialized", "AuditService");
  }

  /**
   * Start periodic sync interval
   */
  private startSyncInterval(): void {
    if (this.syncIntervalId) {
      return;
    }

    this.syncIntervalId = setInterval(() => {
      this.syncToCloud().catch((error) => {
        logService.warn("Periodic sync failed", "AuditService", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    }, this.SYNC_INTERVAL_MS);
  }

  /**
   * Stop periodic sync interval
   */
  stopSyncInterval(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Log an audit event - this is append-only
   * @param entry - Audit entry data (id and timestamp will be auto-generated)
   */
  async log(entry: NewAuditLogEntry): Promise<void> {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    // Never log sensitive data in metadata
    if (fullEntry.metadata) {
      fullEntry.metadata = this.sanitizeMetadata(fullEntry.metadata);
    }

    try {
      // Write to local database (append-only table)
      await this.writeToLocal(fullEntry);

      // Queue for cloud sync
      this.pendingSyncQueue.push(fullEntry);

      // Attempt cloud sync (non-blocking)
      this.syncToCloud().catch(() => {
        // Silent catch - will retry on next log or interval
      });
    } catch (error) {
      // Log the failure but don't throw - audit failures shouldn't break the app
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logService.error("Failed to write audit log", "AuditService", {
        action: entry.action,
        resourceType: entry.resourceType,
        error: errorMsg,
      });

      // Sentry breadcrumb for audit log write failure (BACKLOG-1347)
      Sentry.addBreadcrumb({
        category: "audit",
        message: `Audit log INSERT failed for action=${entry.action}`,
        level: "error",
        data: {
          action: entry.action,
          resourceType: entry.resourceType,
          error: errorMsg,
          userId: entry.userId ? entry.userId.substring(0, 8) + "..." : "unknown",
        },
      });
    }
  }

  /**
   * Audit wrapper for handlers - logs success or failure
   * @param params - Audit parameters
   * @param operation - The operation to wrap
   * @returns The result of the operation
   */
  async withAudit<T>(
    params: {
      userId: string;
      sessionId?: string;
      action: AuditAction;
      resourceType: ResourceType;
      resourceId?: string;
      metadata?: Record<string, unknown>;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    const { userId, sessionId, action, resourceType, resourceId, metadata } =
      params;

    try {
      const result = await operation();

      await this.log({
        userId,
        sessionId,
        action,
        resourceType,
        resourceId,
        metadata,
        success: true,
      });

      return result;
    } catch (error) {
      await this.log({
        userId,
        sessionId,
        action,
        resourceType,
        resourceId,
        metadata,
        success: false,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    }
  }

  /**
   * Write audit entry to local database.
   *
   * BACKLOG-2149: The DB may not be initialized yet on the deep-link auth path.
   * Instead of throwing (and losing the entry + spamming Sentry), wait briefly
   * for the db-ready signal, and if it's still not ready, buffer the entry and
   * flush it once the DB comes up.
   */
  private async writeToLocal(entry: AuditLogEntry): Promise<void> {
    if (!this.databaseService) {
      throw new Error("AuditService not initialized - call initialize() first");
    }

    if (!this.databaseService.isInitialized()) {
      // Give a slow init a short window to finish before we defer.
      const { initializationBroadcaster } = await import(
        "./initializationBroadcaster"
      );
      const result = await initializationBroadcaster.whenDbReady(
        this.DB_READY_WAIT_MS,
      );
      if (!result.ready) {
        this.bufferPendingWrite(entry);
        return;
      }
    }

    await this.databaseService.insertAuditLog(entry);
    // A successful write means the DB is up — drain anything we buffered earlier.
    void this.flushPendingLocalWrites();
  }

  /**
   * BACKLOG-2149: Buffer an audit entry that could not be written because the DB
   * was not ready. Bounded — drops the oldest entry past the cap. Arms a
   * one-shot flush for when the DB becomes queryable.
   */
  private bufferPendingWrite(entry: AuditLogEntry): void {
    this.pendingLocalWrites.push(entry);
    if (this.pendingLocalWrites.length > this.MAX_PENDING_LOCAL_WRITES) {
      const dropped = this.pendingLocalWrites.shift();
      logService.warn(
        "Audit pending-write buffer full, dropped oldest entry",
        "AuditService",
        { action: dropped?.action, resourceType: dropped?.resourceType },
      );
    }
    // Flush when the DB is ready (best-effort; never throws).
    void import("./initializationBroadcaster").then(
      ({ initializationBroadcaster }) => {
        void initializationBroadcaster.whenDbReady().then((result) => {
          if (result.ready) void this.flushPendingLocalWrites();
        });
      },
    );
  }

  /**
   * BACKLOG-2149: Drain buffered audit entries into the local DB once it's ready.
   * Re-buffers on transient failure. Guarded against re-entrancy.
   */
  private async flushPendingLocalWrites(): Promise<void> {
    if (this.flushingPendingWrites) return;
    if (this.pendingLocalWrites.length === 0) return;
    if (!this.databaseService || !this.databaseService.isInitialized()) return;

    this.flushingPendingWrites = true;
    try {
      // Snapshot and clear so new writes during the flush aren't lost/duplicated.
      const toFlush = this.pendingLocalWrites;
      this.pendingLocalWrites = [];

      for (let i = 0; i < toFlush.length; i++) {
        const entry = toFlush[i];
        try {
          await this.databaseService.insertAuditLog(entry);
          // Queue for cloud sync like a normal write.
          this.pendingSyncQueue.push(entry);
        } catch (err) {
          // DB went away mid-flush — re-buffer the remainder and stop.
          this.pendingLocalWrites.unshift(...toFlush.slice(i));
          logService.warn(
            "Audit pending-write flush interrupted, re-buffered remainder",
            "AuditService",
            {
              remaining: toFlush.length - i,
              error: err instanceof Error ? err.message : "Unknown error",
            },
          );
          break;
        }
      }

      logService.info("Flushed buffered audit entries", "AuditService", {
        flushed: toFlush.length - this.pendingLocalWrites.length,
      });

      // Kick a cloud sync for anything we just wrote.
      this.syncToCloud().catch(() => {
        // Silent — retried on next interval.
      });
    } finally {
      this.flushingPendingWrites = false;
    }
  }

  /**
   * Sync pending audit logs to cloud
   */
  async syncToCloud(): Promise<void> {
    if (this.syncInProgress || this.pendingSyncQueue.length === 0) {
      return;
    }

    if (!this.supabaseService || !this.databaseService) {
      return;
    }

    this.syncInProgress = true;

    try {
      // Get entries to sync (from queue or database)
      let entriesToSync: AuditLogEntry[] = [];

      if (this.pendingSyncQueue.length > 0) {
        entriesToSync = this.pendingSyncQueue.slice(0, this.SYNC_BATCH_SIZE);
      } else {
        // Check database for any unsynced entries
        entriesToSync = await this.databaseService.getUnsyncedAuditLogs(
          this.SYNC_BATCH_SIZE,
        );
      }

      if (entriesToSync.length === 0) {
        return;
      }

      // Sync to cloud
      await this.supabaseService.batchInsertAuditLogs(entriesToSync);

      // Mark as synced in local database
      const ids = entriesToSync.map((e) => e.id);
      await this.databaseService.markAuditLogsSynced(ids);

      // Remove from queue
      this.pendingSyncQueue = this.pendingSyncQueue.filter(
        (e) => !ids.includes(e.id),
      );

      logService.info(
        `Synced ${entriesToSync.length} audit logs to cloud`,
        "AuditService",
      );
    } catch (error) {
      // Will retry on next sync attempt
      logService.warn("Failed to sync audit logs to cloud", "AuditService", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Force sync all pending logs (useful before app shutdown)
   */
  async flushPendingLogs(): Promise<void> {
    while (this.pendingSyncQueue.length > 0) {
      await this.syncToCloud();
    }
  }

  /**
   * Sanitize metadata to remove sensitive information
   */
  private sanitizeMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitized = { ...metadata };

    // List of sensitive keys that should never be logged
    const sensitiveKeys = [
      "password",
      "token",
      "access_token",
      "refresh_token",
      "secret",
      "key",
      "api_key",
      "apiKey",
      "authorization",
      "credential",
      "credentials",
    ];

    for (const key of Object.keys(sanitized)) {
      const lowerKey = key.toLowerCase();
      if (
        sensitiveKeys.some((sensitiveKey) => lowerKey.includes(sensitiveKey))
      ) {
        sanitized[key] = "[REDACTED]";
      }
    }

    return sanitized;
  }

  /**
   * Get pending sync count (for monitoring)
   */
  getPendingSyncCount(): number {
    return this.pendingSyncQueue.length;
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Export singleton instance
export const auditService = new AuditService();
export default auditService;
