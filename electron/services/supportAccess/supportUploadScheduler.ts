/**
 * Support report scheduling, upload and deletion (BACKLOG-2393)
 *
 * ## Batched, not streamed
 *
 * Streaming would need a receiving endpoint, its own auth, a queue and offline
 * handling, and it would flow constantly whether or not anything was wrong.
 * Uploading on a schedule (hourly) and on error, inside a bounded window, does
 * the same job for a fraction of the surface.
 *
 * ## The guard
 *
 * `isActive()` is re-checked immediately before *every* transport call, not
 * once per tick. A tick that begins inside the window and reaches its third
 * queued report after the window closed must stop at the boundary. Anything
 * coarser leaves a gap whose width is however long the batch takes.
 *
 * Deletion is deliberately *not* guarded. Removing your own data is not an
 * upload, and a user who let the window lapse must still be able to clear what
 * was already sent.
 */

import type { SupportAccessService } from "./supportAccessService";
import type { SupportReportQueue } from "./supportReportQueue";
import type {
  SupportReportListItem,
  SupportReportMeta,
  SupportReportReason,
  SupportUploadTransport,
} from "./types";
import { SUPPORT_REPORT_RETENTION_DAYS } from "./disclosure";

/** Hourly, per the batched-upload decision. */
export const DEFAULT_UPLOAD_INTERVAL_MS = 60 * 60 * 1000;
/** Floor between error-triggered captures, so a crash loop is not a fire hose. */
export const DEFAULT_ERROR_DEBOUNCE_MS = 5 * 60 * 1000;

export interface SupportUploadSchedulerDeps {
  now: () => number;
  access: SupportAccessService;
  queue: SupportReportQueue;
  transport: SupportUploadTransport;
  intervalMs?: number;
  errorDebounceMs?: number;
  retentionDays?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * The last capture that failed, kept so the user can be told (BACKLOG-2430).
 *
 * Without this a scheduled capture that fails is a log line and nothing else.
 * The window stays open, the Settings panel keeps counting down, and the report
 * list stays empty — which reads as "this Mac had nothing to report" rather
 * than "this Mac recorded nothing". Someone could grant access for seven days,
 * believe support was receiving reports the whole time, and send nothing at
 * all. That is exactly what happened when the keychain gate was locked.
 */
export interface SupportCaptureFailure {
  reason: SupportReportReason;
  /** ISO 8601, from the injected clock. */
  at: string;
  message: string;
}

export interface DeleteReportResult {
  deleted: boolean;
  /** Present when the server could not be reached. Never paired with deleted. */
  error?: string;
  /** True when a remote copy is known to still exist. */
  remoteRemains?: boolean;
}

export interface FlushResult {
  sent: string[];
  failed: Array<{ id: string; error: string }>;
  /** Reports left untouched because the window was closed. */
  skippedWindowClosed: string[];
}

export interface PurgeResult {
  /** Never uploaded, local retention reached — the last copy is now gone. */
  droppedNeverSent: string[];
  /** Server copy confirmed removed, then the local row. */
  deletedFromServer: string[];
  /** Server delete failed. The row is still listed and still deletable by hand. */
  stillRemote: Array<{ id: string; error: string }>;
}

export class SupportUploadScheduler {
  private deps: SupportUploadSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastErrorCaptureAt = 0;
  private running = false;
  /** Last capture failure, or null once a capture has succeeded. */
  private captureFailure: SupportCaptureFailure | null = null;

  constructor(deps: SupportUploadSchedulerDeps) {
    this.deps = deps;
  }

  private get intervalMs(): number {
    return this.deps.intervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS;
  }

  private get errorDebounceMs(): number {
    return this.deps.errorDebounceMs ?? DEFAULT_ERROR_DEBOUNCE_MS;
  }

  private get retentionDays(): number {
    return this.deps.retentionDays ?? SUPPORT_REPORT_RETENTION_DAYS;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not hold the process open for a diagnostics timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One scheduled pass: close the window if the clock has passed it, drop
   * locally-held reports whose server retention has lapsed, then capture and
   * send — but only while the window is open.
   */
  async tick(): Promise<FlushResult> {
    if (this.running) {
      return { sent: [], failed: [], skippedWindowClosed: [] };
    }
    this.running = true;
    try {
      const ended = await this.deps.access.reconcile();
      if (ended) {
        this.log("info", "Support access window closed; uploads stopped");
        this.stop();
      }
      await this.purgeExpiredReports();

      if (!this.deps.access.isActive()) {
        const pending = await this.deps.queue.list();
        return {
          sent: [],
          failed: [],
          skippedWindowClosed: pending
            .filter((m) => m.state !== "sent")
            .map((m) => m.id),
        };
      }

      await this.captureQuietly("scheduled");
      return await this.flush();
    } finally {
      this.running = false;
    }
  }

  /**
   * Enforce retention on both sides.
   *
   * The consent checkbox a user must tick says reports are deleted after 30
   * days. Keeping that promise has two halves, and the previous implementation
   * had neither:
   *
   *  - A report that was **never sent** had no deadline at all, because the only
   *    expiry keyed on the server's. It sat here holding client names forever.
   *    Those are dropped outright: no other copy exists.
   *
   *  - A report that **was** sent had its *local* row deleted at the deadline
   *    while the server copy carried on existing. The row is what carries the
   *    Delete button, so the user was shown "gone" for something still held and
   *    simultaneously lost the only way to remove it. Now the server copy goes
   *    first, and the row survives a failed delete so it stays actionable.
   *
   * A server-side purge job (`support_purge_expired_attachments`, scheduled in
   * the migration) is the backstop. This is the client half; neither alone is
   * enough, because the client may be offline at the deadline and the server
   * cannot know the user pressed Delete.
   */
  async purgeExpiredReports(): Promise<PurgeResult> {
    const result: PurgeResult = {
      droppedNeverSent: [],
      deletedFromServer: [],
      stillRemote: [],
    };

    result.droppedNeverSent = await this.deps.queue.purgeLocallyExpired();

    for (const meta of await this.deps.queue.dueForServerPurge()) {
      // Reuses the honest delete path: server first, local only on success.
      const outcome = await this.deleteReport(meta.id);
      if (outcome.deleted) {
        result.deletedFromServer.push(meta.id);
      } else {
        result.stillRemote.push({
          id: meta.id,
          error: outcome.error ?? "unknown error",
        });
        this.log(
          "warn",
          `Support report ${meta.id} is past its retention deadline but the server copy could not be removed; keeping the row so it stays deletable`,
        );
      }
    }

    return result;
  }

  /**
   * Called when something goes wrong elsewhere in the app. Debounced, and a
   * no-op outside the window.
   */
  async notifyError(): Promise<void> {
    if (!this.deps.access.isActive()) return;
    const now = this.deps.now();
    if (now - this.lastErrorCaptureAt < this.errorDebounceMs) return;
    this.lastErrorCaptureAt = now;
    await this.captureQuietly("error");
    await this.flush();
  }

  /**
   * The last capture failure, or null if the most recent capture succeeded.
   *
   * Read by `support-access:get-state`, so the Settings panel can say that
   * nothing is reaching support instead of showing an empty list under a
   * healthy-looking countdown.
   */
  getCaptureFailure(): SupportCaptureFailure | null {
    return this.captureFailure ? { ...this.captureFailure } : null;
  }

  private recordCaptureFailure(
    reason: SupportReportReason,
    error: unknown,
  ): void {
    this.captureFailure = {
      reason,
      at: new Date(this.deps.now()).toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async captureQuietly(reason: SupportReportReason): Promise<void> {
    try {
      await this.deps.queue.capture(reason);
      // A success clears the flag. Otherwise a single transient failure would
      // keep warning the user about a problem that has since gone away.
      this.captureFailure = null;
    } catch (error) {
      // Not thrown — this runs on a timer, and there is nobody to throw at.
      // Logged *and* recorded: the log is for us, the record is for the user,
      // and before BACKLOG-2430 only the first of those existed.
      this.recordCaptureFailure(reason, error);
      this.log(
        "error",
        `Support report capture (${reason}) failed: ${String(error)}`,
      );
    }
  }

  /** Capture on demand. Rejects outside the window. */
  async captureNow(
    reason: SupportReportReason = "manual",
  ): Promise<SupportReportMeta> {
    if (!this.deps.access.isActive()) {
      throw new Error("Support access is not active");
    }
    try {
      const meta = await this.deps.queue.capture(reason);
      this.captureFailure = null;
      return meta;
    } catch (error) {
      // Recorded as well as rethrown. The throw reaches whoever pressed the
      // button; the record is what still says "nothing is reaching support"
      // when they come back to the panel later, or open it on another screen.
      this.recordCaptureFailure(reason, error);
      throw error;
    }
  }

  /**
   * Send everything queued. Each report re-checks the window immediately before
   * its own upload, so a window that closes mid-batch stops the batch.
   */
  async flush(): Promise<FlushResult> {
    const result: FlushResult = {
      sent: [],
      failed: [],
      skippedWindowClosed: [],
    };
    const pending = (await this.deps.queue.list()).filter(
      (meta) => meta.state !== "sent",
    );

    for (const meta of pending) {
      // The guard, per report. Not per tick.
      if (!this.deps.access.isActive()) {
        result.skippedWindowClosed.push(meta.id);
        continue;
      }
      try {
        await this.send(meta);
        result.sent.push(meta.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.queue.markFailed(meta.id, message);
        result.failed.push({ id: meta.id, error: message });
        this.log("warn", `Support report ${meta.id} upload failed: ${message}`);
      }
    }
    return result;
  }

  /** Send a single queued report on the user's explicit instruction. */
  async sendNow(id: string): Promise<SupportReportMeta> {
    if (!this.deps.access.isActive()) {
      throw new Error("Support access is not active");
    }
    const meta = await this.deps.queue.getMeta(id);
    if (!meta) throw new Error(`No queued report with id ${id}`);
    if (meta.state === "sent") return meta;
    try {
      return await this.send(meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.queue.markFailed(id, message);
      throw error;
    }
  }

  private async send(meta: SupportReportMeta): Promise<SupportReportMeta> {
    // Last line of defence. `flush` and `sendNow` both check, but this is the
    // only check that is impossible to route around, because it sits between
    // the caller and the transport.
    if (!this.deps.access.isActive()) {
      throw new Error("Support access is not active");
    }
    const body = await this.deps.queue.readBody(meta.id);
    const result = await this.deps.transport.upload({
      meta,
      body,
      fileName: `keepr-support-report-${meta.capturedAt.replace(/[:.]/g, "-")}.json.gz`,
      contentType: "application/gzip",
      retentionDays: this.retentionDays,
    });
    const updated = await this.deps.queue.markSent(
      meta.id,
      result.remote,
      result.expiresAt,
    );
    this.log("info", `Support report ${meta.id} uploaded`);
    return updated ?? meta;
  }

  /**
   * Remove a report locally *and* on the server.
   *
   * The server goes first. If it fails, the local copy stays and the caller is
   * told it failed — a button that reports "deleted" while a copy sits in
   * Keepr storage is worse than one that reports an error, because the user
   * stops looking.
   */
  async deleteReport(id: string): Promise<DeleteReportResult> {
    const meta = await this.deps.queue.getMeta(id);
    if (!meta) return { deleted: true };

    if (meta.remote) {
      try {
        await this.deps.transport.deleteRemote(meta.remote);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.queue.markFailed(
          id,
          `Could not delete from Keepr support: ${message}`,
        );
        this.log("warn", `Support report ${id} remote delete failed: ${message}`);
        return { deleted: false, error: message, remoteRemains: true };
      }
    }

    await this.deps.queue.removeLocal(id);
    this.log("info", `Support report ${id} deleted`);
    return { deleted: true };
  }

  async listReports(): Promise<SupportReportListItem[]> {
    return this.deps.queue.listForDisplay();
  }
}
