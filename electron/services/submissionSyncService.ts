/**
 * Submission Sync Service (BACKLOG-395)
 *
 * Uses Supabase Realtime subscriptions for instant status updates,
 * with polling as a fallback for missed events.
 *
 * Features:
 * - Realtime subscriptions for instant updates (primary)
 * - Periodic polling as fallback
 * - Status change detection
 * - Review notes sync
 * - Event emission for UI notifications
 * - Offline handling with reconnection
 */

import { BrowserWindow } from "electron";
import { RealtimeChannel } from "@supabase/supabase-js";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import databaseService from "./databaseService";
import logService from "./logService";
import type { Transaction, SubmissionStatus } from "../types/models";

// ============================================
// TYPES & INTERFACES
// ============================================

/** Result of a sync operation */
export interface SyncResult {
  updated: number;
  failed: number;
  details: StatusChangeDetail[];
}

/** Details of a status change */
export interface StatusChangeDetail {
  transactionId: string;
  propertyAddress: string;
  oldStatus: SubmissionStatus;
  newStatus: SubmissionStatus;
  reviewNotes?: string;
}

/** Cloud submission status record */
interface CloudSubmissionStatus {
  id: string;
  status: string;
  review_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;
}

/** Local transaction with submission fields */
interface LocalSubmittedTransaction {
  id: string;
  property_address: string;
  submission_id: string;
  submission_status: SubmissionStatus;
  last_review_notes?: string | null;
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_SYNC_INTERVAL_MS = 60000; // 1 minute (fallback polling)
const MIN_SYNC_INTERVAL_MS = 10000; // 10 seconds minimum
const REALTIME_ENABLED = true; // Feature flag for realtime subscriptions

// ============================================
// SERVICE CLASS
// ============================================

class SubmissionSyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private syncIntervalMs: number = DEFAULT_SYNC_INTERVAL_MS;
  private isOnline: boolean = true;
  private mainWindow: BrowserWindow | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;

  /**
   * Set the main window reference for sending events
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Start realtime subscription for status changes
   * @param userId - The user ID to filter submissions by
   */
  async startRealtimeSubscription(userId: string): Promise<void> {
    if (!REALTIME_ENABLED) {
      logService.info("[SyncService] Realtime disabled, using polling only", "SubmissionSyncService");
      return;
    }

    // Clean up existing subscription if any
    if (this.realtimeChannel) {
      await this.stopRealtimeSubscription();
    }

    this.currentUserId = userId;

    try {
      const client = supabaseService.getClient();

      this.realtimeChannel = client
        .channel(`submission-changes-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "transaction_submissions",
            filter: `submitted_by=eq.${userId}`,
          },
          async (payload) => {
            logService.info(
              "[SyncService] Realtime update received",
              "SubmissionSyncService",
              { submissionId: payload.new?.id }
            );
            await this.handleRealtimeUpdate(payload.new as CloudSubmissionStatus);
          }
        )
        .subscribe((status) => {
          logService.info(
            `[SyncService] Realtime subscription status: ${status}`,
            "SubmissionSyncService"
          );

          if (status === "SUBSCRIBED") {
            logService.info(
              "[SyncService] Realtime subscription active",
              "SubmissionSyncService"
            );
          } else if (status === "CHANNEL_ERROR") {
            logService.error(
              "[SyncService] Realtime channel error, falling back to polling",
              "SubmissionSyncService"
            );
          }
        });

      logService.info(
        `[SyncService] Started realtime subscription for user ${userId}`,
        "SubmissionSyncService"
      );
    } catch (error) {
      logService.error(
        `[SyncService] Failed to start realtime subscription: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "startRealtimeSubscription" },
      });
    }
  }

  /**
   * Stop realtime subscription
   */
  async stopRealtimeSubscription(): Promise<void> {
    if (this.realtimeChannel) {
      try {
        const client = supabaseService.getClient();
        await client.removeChannel(this.realtimeChannel);
        this.realtimeChannel = null;
        this.currentUserId = null;
        logService.info("[SyncService] Stopped realtime subscription", "SubmissionSyncService");
      } catch (error) {
        logService.error(
          `[SyncService] Error stopping realtime subscription: ${error instanceof Error ? error.message : "Unknown error"}`,
          "SubmissionSyncService"
        );
        Sentry.captureException(error, {
          tags: { service: "submission-sync", operation: "stopRealtimeSubscription" },
        });
      }
    }
  }

  /**
   * Check if database is ready for sync operations
   */
  private isDatabaseReady(): boolean {
    return databaseService.isInitialized();
  }

  /**
   * Handle realtime update from Supabase
   */
  private async handleRealtimeUpdate(cloudStatus: CloudSubmissionStatus): Promise<void> {
    if (!cloudStatus?.id) {
      logService.warn("[SyncService] Received invalid realtime update", "SubmissionSyncService");
      return;
    }

    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping realtime update - database not initialized",
        "SubmissionSyncService"
      );
      return;
    }

    try {
      // Find local transaction by submission_id
      const localTransaction = databaseService.getTransactionBySubmissionId(cloudStatus.id) as LocalSubmittedTransaction | undefined;

      if (!localTransaction) {
        logService.debug(
          `[SyncService] No local transaction for submission ${cloudStatus.id}`,
          "SubmissionSyncService"
        );
        return;
      }

      // Check if status or review notes changed
      const statusChanged = cloudStatus.status !== localTransaction.submission_status;
      const notesChanged = cloudStatus.review_notes !== localTransaction.last_review_notes;

      if (statusChanged || notesChanged) {
        await this.updateLocalTransaction(localTransaction.id, {
          submission_status: cloudStatus.status as SubmissionStatus,
          last_review_notes: cloudStatus.review_notes || null,
        });

        const detail: StatusChangeDetail = {
          transactionId: localTransaction.id,
          propertyAddress: localTransaction.property_address,
          oldStatus: localTransaction.submission_status,
          newStatus: cloudStatus.status as SubmissionStatus,
          reviewNotes: cloudStatus.review_notes,
        };

        if (statusChanged) {
          this.emitStatusChange(detail);
        }

        logService.info(
          `[SyncService] Realtime update applied: ${localTransaction.property_address}: ${localTransaction.submission_status} -> ${cloudStatus.status}`,
          "SubmissionSyncService"
        );
      }
    } catch (error) {
      logService.error(
        `[SyncService] Failed to handle realtime update: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "handleRealtimeUpdate" },
      });
    }
  }

  /**
   * Check if realtime subscription is active
   */
  isRealtimeActive(): boolean {
    return this.realtimeChannel !== null;
  }

  /**
   * Start periodic sync polling
   * @param intervalMs - Polling interval in milliseconds (default: 1 minute)
   */
  startPeriodicSync(intervalMs: number = DEFAULT_SYNC_INTERVAL_MS): void {
    if (this.syncInterval) {
      logService.info("[SyncService] Sync already running", "SubmissionSyncService");
      return;
    }

    this.syncIntervalMs = Math.max(intervalMs, MIN_SYNC_INTERVAL_MS);

    logService.info(
      `[SyncService] Starting periodic sync every ${this.syncIntervalMs / 1000}s`,
      "SubmissionSyncService"
    );

    // Start interval - guard each tick against uninitialized DB
    this.syncInterval = setInterval(async () => {
      if (!this.isDatabaseReady()) {
        logService.debug(
          "[SyncService] Skipping periodic sync tick - database not initialized",
          "SubmissionSyncService"
        );
        return;
      }
      try {
        await this.syncAllSubmissions();
      } catch (error) {
        logService.error(
          `[SyncService] Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "SubmissionSyncService"
        );
        Sentry.captureException(error, {
          tags: { service: "submission-sync", operation: "periodicSync" },
        });
      }
    }, this.syncIntervalMs);

    // Also run immediately if DB is ready
    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping initial sync - database not initialized, will retry on next interval",
        "SubmissionSyncService"
      );
      return;
    }

    this.syncAllSubmissions().catch((error) => {
      logService.error(
        `[SyncService] Initial sync failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "initialSync" },
      });
    });
  }

  /**
   * Stop periodic sync polling
   */
  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      logService.info("[SyncService] Stopped periodic sync", "SubmissionSyncService");
    }
  }

  /**
   * Stop all sync operations (both realtime and polling)
   */
  async stopAllSync(): Promise<void> {
    this.stopPeriodicSync();
    await this.stopRealtimeSubscription();
    logService.info("[SyncService] Stopped all sync operations", "SubmissionSyncService");
  }

  /**
   * Check if sync is currently running
   */
  isRunning(): boolean {
    return this.syncInterval !== null;
  }

  /**
   * Manually trigger a sync
   */
  async manualSync(): Promise<SyncResult> {
    return this.syncAllSubmissions();
  }

  /**
   * Sync all submitted transactions
   */
  async syncAllSubmissions(): Promise<SyncResult> {
    // Guard: ensure database is initialized before attempting sync
    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping sync - database not initialized",
        "SubmissionSyncService"
      );
      return { updated: 0, failed: 0, details: [] };
    }

    // Check online status (in Electron main process, we check via net module or assume online)
    // For simplicity, we'll try the request and handle errors
    const result: SyncResult = {
      updated: 0,
      failed: 0,
      details: [],
    };

    try {
      // 1. Get all local transactions with submission_id that are not in terminal states
      const submittedTransactions = await this.getLocalSubmittedTransactions();

      if (submittedTransactions.length === 0) {
        logService.debug("[SyncService] No pending submissions to sync", "SubmissionSyncService");
        return result;
      }

      logService.debug(
        `[SyncService] Syncing ${submittedTransactions.length} submissions`,
        "SubmissionSyncService"
      );

      // 2. Fetch cloud statuses
      const submissionIds = submittedTransactions.map((t) => t.submission_id);
      const cloudStatuses = await this.fetchCloudStatuses(submissionIds);

      if (!cloudStatuses || cloudStatuses.length === 0) {
        logService.debug("[SyncService] No cloud statuses returned", "SubmissionSyncService");
        return result;
      }

      // 3. Compare and update
      for (const local of submittedTransactions) {
        const cloud = cloudStatuses.find((c) => c.id === local.submission_id);
        if (!cloud) continue;

        // Check if status or review notes changed
        const statusChanged = cloud.status !== local.submission_status;
        const notesChanged = cloud.review_notes !== local.last_review_notes;

        if (statusChanged || notesChanged) {
          try {
            await this.updateLocalTransaction(local.id, {
              submission_status: cloud.status as SubmissionStatus,
              last_review_notes: cloud.review_notes || null,
            });

            result.updated++;

            const detail: StatusChangeDetail = {
              transactionId: local.id,
              propertyAddress: local.property_address,
              oldStatus: local.submission_status,
              newStatus: cloud.status as SubmissionStatus,
              reviewNotes: cloud.review_notes,
            };
            result.details.push(detail);

            // Emit event for UI notification if status changed
            if (statusChanged) {
              this.emitStatusChange(detail);
            }

            logService.info(
              `[SyncService] Updated ${local.property_address}: ${local.submission_status} -> ${cloud.status}`,
              "SubmissionSyncService"
            );
          } catch (error) {
            result.failed++;
            logService.error(
              `[SyncService] Failed to update transaction ${local.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
              "SubmissionSyncService"
            );
          }
        }
      }

      if (result.updated > 0) {
        logService.info(
          `[SyncService] Sync complete: ${result.updated} updated, ${result.failed} failed`,
          "SubmissionSyncService"
        );
      }

      return result;
    } catch (error) {
      logService.error(
        `[SyncService] Sync error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "syncAllSubmissions" },
      });
      throw error;
    }
  }

  /**
   * Sync a specific transaction's submission status
   */
  async syncSubmission(transactionId: string): Promise<boolean> {
    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping single submission sync - database not initialized",
        "SubmissionSyncService"
      );
      return false;
    }

    try {
      const transaction = databaseService.getSubmittedTransactionById(transactionId) as LocalSubmittedTransaction | undefined;

      if (!transaction) {
        return false;
      }

      const cloudStatuses = await this.fetchCloudStatuses([transaction.submission_id]);
      if (!cloudStatuses || cloudStatuses.length === 0) {
        return false;
      }

      const cloud = cloudStatuses[0];
      const statusChanged = cloud.status !== transaction.submission_status;
      const notesChanged = cloud.review_notes !== transaction.last_review_notes;

      if (statusChanged || notesChanged) {
        await this.updateLocalTransaction(transaction.id, {
          submission_status: cloud.status as SubmissionStatus,
          last_review_notes: cloud.review_notes || null,
        });

        if (statusChanged) {
          this.emitStatusChange({
            transactionId: transaction.id,
            propertyAddress: transaction.property_address,
            oldStatus: transaction.submission_status,
            newStatus: cloud.status as SubmissionStatus,
            reviewNotes: cloud.review_notes,
          });
        }

        return true;
      }

      return false;
    } catch (error) {
      logService.error(
        `[SyncService] Failed to sync single submission: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "syncSubmission" },
      });
      return false;
    }
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  /**
   * Get local transactions that are submitted but not in terminal states
   */
  private async getLocalSubmittedTransactions(): Promise<LocalSubmittedTransaction[]> {
    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping getLocalSubmittedTransactions - database not initialized",
        "SubmissionSyncService"
      );
      return [];
    }

    return databaseService.getActiveSubmittedTransactions() as LocalSubmittedTransaction[];
  }

  /**
   * Fetch submission statuses from Supabase cloud
   */
  private async fetchCloudStatuses(submissionIds: string[]): Promise<CloudSubmissionStatus[] | null> {
    try {
      const client = supabaseService.getClient();

      // TASK-2056: 15-second timeout to prevent hanging when offline
      const timeoutMs = 15000;
      const queryResult = await Promise.race([
        client
          .from("transaction_submissions")
          .select("id, status, review_notes, reviewed_by, reviewed_at")
          .in("id", submissionIds),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Cloud status fetch timed out after ${timeoutMs / 1000}s`)), timeoutMs)
        ),
      ]);

      const { data, error } = queryResult;

      if (error) {
        logService.error(
          `[SyncService] Supabase query error: ${error.message}`,
          "SubmissionSyncService"
        );
        return null;
      }

      return data;
    } catch (error) {
      logService.error(
        `[SyncService] Failed to fetch cloud statuses: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SubmissionSyncService"
      );
      Sentry.captureException(error, {
        tags: { service: "submission-sync", operation: "fetchCloudStatuses" },
      });
      return null;
    }
  }

  /**
   * Update local transaction with new submission data
   */
  private async updateLocalTransaction(
    transactionId: string,
    updates: {
      submission_status: SubmissionStatus;
      last_review_notes: string | null;
    }
  ): Promise<void> {
    if (!this.isDatabaseReady()) {
      logService.debug(
        "[SyncService] Skipping updateLocalTransaction - database not initialized",
        "SubmissionSyncService"
      );
      return;
    }

    databaseService.updateTransactionSubmissionStatus(
      transactionId,
      updates.submission_status,
      updates.last_review_notes
    );
  }

  /**
   * Emit status change event to renderer
   */
  private emitStatusChange(detail: StatusChangeDetail): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      logService.debug(
        "[SyncService] No main window to send status change event",
        "SubmissionSyncService"
      );
      return;
    }

    const notification = {
      transactionId: detail.transactionId,
      propertyAddress: detail.propertyAddress,
      oldStatus: detail.oldStatus,
      newStatus: detail.newStatus,
      reviewNotes: detail.reviewNotes,
      title: this.getNotificationTitle(detail.newStatus),
      message: this.getNotificationMessage(detail.newStatus, detail.propertyAddress, detail.reviewNotes),
    };

    this.mainWindow.webContents.send("submission-status-changed", notification);

    logService.info(
      `[SyncService] Emitted status change: ${detail.propertyAddress} -> ${detail.newStatus}`,
      "SubmissionSyncService"
    );
  }

  /**
   * Get notification title based on status
   */
  private getNotificationTitle(status: SubmissionStatus): string {
    switch (status) {
      case "under_review":
        return "Submission Under Review";
      case "needs_changes":
        return "Changes Requested";
      case "approved":
        return "Submission Approved!";
      case "rejected":
        return "Submission Rejected";
      case "submitted":
        return "Submission Received";
      case "resubmitted":
        return "Resubmission Received";
      default:
        return "Submission Status Updated";
    }
  }

  /**
   * Get notification message based on status
   */
  private getNotificationMessage(
    status: SubmissionStatus,
    propertyAddress: string,
    reviewNotes?: string
  ): string {
    const address = propertyAddress || "Transaction";

    switch (status) {
      case "under_review":
        return `${address} is now being reviewed by your broker.`;
      case "needs_changes":
        return reviewNotes
          ? `${address}: ${reviewNotes}`
          : `${address} requires changes before approval.`;
      case "approved":
        return `${address} has been approved by your broker.`;
      case "rejected":
        return reviewNotes
          ? `${address}: ${reviewNotes}`
          : `${address} was not approved.`;
      default:
        return `${address} status has been updated.`;
    }
  }
}

// Export singleton
export const submissionSyncService = new SubmissionSyncService();
export default submissionSyncService;
