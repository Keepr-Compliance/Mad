// ============================================
// SHADOW DELTA SYNC SERVICE (BACKLOG-1831)
//
// The first, deliberately cheap increment of the full delta engine (BACKLOG-1775).
// It runs in SHADOW mode: it warms the local email cache in the background using
// Microsoft Graph per-folder message delta, but changes NOTHING about the T2
// transaction sync (windows, triggers, throttles, precache). It is flag-gated and
// default OFF (see preferenceHelper.isShadowDeltaSyncEnabled).
//
// Hard constraints (BACKLOG-1831):
//   - ADDITIVE-ONLY: @removed delta entries are skipped entirely (counted only for
//     the log line). No deletions, no updates to existing rows, no evidence
//     retention (that is BACKLOG-1775, out of scope here).
//   - Storage goes through the SAME insert/dedup/counting path T2 uses
//     (storeParsedEmailsForAccount → fetchStoreAndDedup), so per-account UNIQUE
//     indexes make duplicate rows impossible even if T2 runs concurrently.
//   - Per-folder crash-safety: the folder's delta cursor is persisted only AFTER
//     that folder's emails are fully stored.
// ============================================

import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import outlookFetchService, { DeltaTokenExpiredError } from "./outlookFetchService";
import { storeParsedEmailsForAccount } from "./emailSyncService";
import {
  resolveMailboxAccountId,
  ensureSyncStateRow,
  getSyncState,
  getCursor,
  setCursor,
  recordSyncSuccess,
  recordSyncFailure,
} from "./db/emailSyncStateService";

/**
 * failure_count backoff threshold. failure_count is already maintained by
 * recordSyncSuccess/recordSyncFailure; once it reaches this the account is treated
 * as unhealthy and shadow runs are skipped until the next app start (cheap backoff
 * — a fresh process re-arms the poller and the count only resets on a success).
 */
const FAILURE_BACKOFF_THRESHOLD = 5;

/** First run ~2 minutes after login (let the app settle / precache start first). */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/** Poll every 15 minutes thereafter. */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/** Per-account delta cursor: a map of { [folderId]: @odata.deltaLink }. */
type CursorMap = Record<string, string>;

class ShadowDeltaSyncService {
  /** Single-flight guard so overlapping poller ticks never run concurrently. */
  private isRunning = false;
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** The shadow service owns (de)serialization; the state service stores the raw string. */
  private parseCursorMap(raw: string | null): CursorMap {
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as CursorMap;
      }
    } catch {
      // Corrupt cursor → start fresh (additive-only, so re-enumeration is safe).
    }
    return {};
  }

  /**
   * Run one shadow delta pass for the user's Microsoft mailbox. Idempotent and
   * safe to call repeatedly; the single-flight guard drops overlapping ticks.
   */
  async runOnce(userId: string): Promise<void> {
    if (this.isRunning) {
      logService.debug("[SHADOW-DELTA] run already in progress, skipping tick", "ShadowDelta");
      return;
    }
    this.isRunning = true;
    const startedAt = Date.now();

    let folderCount = 0;
    let newCount = 0;
    let dupes = 0;
    let removedSkipped = 0;
    let accountId: string | null = null;

    try {
      accountId = resolveMailboxAccountId(userId, "microsoft");
      if (!accountId) {
        logService.debug("[SHADOW-DELTA] no Microsoft mailbox account, skipping", "ShadowDelta");
        return;
      }

      // Respect the Clear contract + health backoff BEFORE touching the network.
      const state = getSyncState(userId, accountId);
      if (state && state.phase !== "active") {
        logService.debug(`[SHADOW-DELTA] account phase='${state.phase}', skipping`, "ShadowDelta");
        return;
      }
      if (state && state.failure_count >= FAILURE_BACKOFF_THRESHOLD) {
        logService.warn(
          `[SHADOW-DELTA] skipping: failure_count=${state.failure_count} >= ${FAILURE_BACKOFF_THRESHOLD} (backoff until next app start)`,
          "ShadowDelta",
        );
        return;
      }

      // Guarantee the row exists so per-folder setCursor (provider-free UPDATE) lands.
      ensureSyncStateRow(userId, accountId, "microsoft");

      const ready = await outlookFetchService.initialize(userId);
      if (!ready) throw new Error("Outlook initialize() returned false");

      // Reuse T2's folder discovery (same system-folder exclusions).
      const folders = await outlookFetchService.discoverFolders();
      const cursorMap = this.parseCursorMap(getCursor(userId, accountId));

      for (const folder of folders) {
        folderCount++;
        try {
          const storedDeltaLink = cursorMap[folder.id] ?? null;
          const { emails, deltaLink, removedSkipped: rs } =
            await outlookFetchService.fetchDeltaEmails(folder.id, storedDeltaLink);
          removedSkipped += rs;

          if (emails.length > 0) {
            const result = await storeParsedEmailsForAccount({
              userId,
              provider: "outlook",
              emails,
            });
            newCount += result.stored;
            dupes += result.duplicates;
          }

          // Persist the new cursor AFTER the folder is fully stored (crash-safe per folder).
          if (deltaLink) {
            cursorMap[folder.id] = deltaLink;
            setCursor(userId, accountId, JSON.stringify(cursorMap));
          }
        } catch (folderError) {
          if (folderError instanceof DeltaTokenExpiredError) {
            // 410 Gone → clear this folder's cursor; fresh enumeration next cycle.
            delete cursorMap[folder.id];
            setCursor(userId, accountId, JSON.stringify(cursorMap));
            logService.warn(
              `[SHADOW-DELTA] delta token expired for folder ${folder.id}; cursor cleared`,
              "ShadowDelta",
            );
          } else {
            // Per-folder error isolation: skip this folder, continue with the rest.
            logService.warn(`[SHADOW-DELTA] folder ${folder.id} failed, skipping`, "ShadowDelta", {
              error: folderError instanceof Error ? folderError.message : "Unknown",
            });
          }
        }
      }

      recordSyncSuccess(userId, accountId, "microsoft");
    } catch (error) {
      if (accountId) recordSyncFailure(userId, accountId, "microsoft", error);
      logService.warn("[SHADOW-DELTA] run failed", "ShadowDelta", {
        error: error instanceof Error ? error.message : "Unknown",
      });
      Sentry.captureException(error, {
        tags: { service: "shadow-delta-sync", operation: "runOnce" },
        level: "warning",
      });
    } finally {
      this.isRunning = false;
    }

    const ms = Date.now() - startedAt;
    logService.info(
      `[SHADOW-DELTA] account=${accountId ?? "none"} folders=${folderCount} new=${newCount} dupes=${dupes} removedSkipped=${removedSkipped} ms=${ms}`,
      "ShadowDelta",
    );
    Sentry.addBreadcrumb({
      category: "email_sync.shadow_delta",
      message: `Shadow delta run: ${newCount} new, ${dupes} dupes, ${removedSkipped} removed-skipped across ${folderCount} folder(s)`,
      level: "info",
      data: { accountId, folders: folderCount, new: newCount, dupes, removedSkipped, ms },
    });
  }

  /**
   * Schedule the shadow poller: first run ~2 min after login, then every 15 min.
   * Idempotent — a second call while already scheduled is a no-op (prevents
   * duplicate intervals if the post-auth path fires more than once).
   */
  start(userId: string): void {
    if (this.firstRunTimer || this.pollTimer) {
      logService.debug("[SHADOW-DELTA] already scheduled, ignoring start()", "ShadowDelta");
      return;
    }
    logService.info(
      `[SHADOW-DELTA] scheduling: first run in ${FIRST_RUN_DELAY_MS / 1000}s, then every ${POLL_INTERVAL_MS / 60000}m`,
      "ShadowDelta",
    );

    this.firstRunTimer = setTimeout(() => {
      void this.runOnce(userId);
    }, FIRST_RUN_DELAY_MS);

    this.pollTimer = setInterval(() => {
      void this.runOnce(userId);
    }, POLL_INTERVAL_MS);
  }

  /** Clear the scheduled timers (called on app quit — interval hygiene). */
  stop(): void {
    if (this.firstRunTimer) {
      clearTimeout(this.firstRunTimer);
      this.firstRunTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// Export singleton instance (mirrors the other electron/services singletons).
const shadowDeltaSyncService = new ShadowDeltaSyncService();
export default shadowDeltaSyncService;
