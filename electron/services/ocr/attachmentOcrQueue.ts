/**
 * BACKLOG-3943 — the OCR queue: in-process, FIFO, one file at a time.
 *
 * Fed by two callers only:
 *   1. the text-layer pass, when a PDF came back "empty" (attachmentTextExtractionService);
 *   2. the post-sync drain (requestOcrDrainAfterSync), which queues up to OCR_DRAIN_BATCH
 *      older OCR-pending files after each email sync and is skipped on battery power
 *      (founder ruling 3, 2026-10-31).
 *
 * Bounds (SR plan review R7): at most OCR_QUEUE_CAP ids are held in memory; overflow is
 * counted and logged and stays OCR-pending in the database for a later drain. One OCR job
 * runs at a time, so at most one page child (~250 MB) is alive.
 *
 * Lifecycle: the queue does nothing until startAttachmentOcr() is called from main.ts at
 * app start (tests never start the shared queue, so no test can spawn a child by
 * accident). stopAttachmentOcr() is called on before-quit: it clears the queue, stops the
 * live child, and the running job writes nothing (the row stays OCR-pending).
 */
import * as Sentry from "@sentry/electron/main";
import databaseService from "../databaseService";
import logService from "../logService";
import { prepareOcrPendingPage } from "../db/attachmentTextExtractionSql";
import {
  OCR_DRAIN_BATCH,
  OCR_MAX_ATTEMPTS,
  OCR_MIME_TYPES,
  OCR_QUEUE_CAP,
  isOcrEligibleMime,
} from "./ocrConfig";
import { isOcrSupportedPlatform, stopLiveOcrChild } from "./ocrChild";
import { ocrAttachmentText, type OcrOutcome, type OcrRunOptions } from "./attachmentOcrService";

export { isOcrEligibleMime };

const SERVICE_NAME = "AttachmentOcr";

export type EnqueueResult = "queued" | "duplicate" | "overflow" | "stopped" | "not-started" | "unsupported";

export type DrainResult =
  | { queued: number; skipped?: undefined }
  | { queued: 0; skipped: "battery" | "busy" | "stopped" | "not-started" | "unsupported" | "error" };

export interface OcrQueueDeps {
  run: (id: string, options: OcrRunOptions) => Promise<OcrOutcome>;
  isSupported: () => boolean;
  isOnBatteryPower: () => boolean;
  selectPendingIds: (limit: number) => string[];
  stopChild: () => void;
  cap: number;
  drainBatch: number;
}

/** Default: the newest OCR-pending ids, bound values only (db/attachmentTextExtractionSql). */
function selectPendingIdsFromDb(limit: number): string[] {
  const db = databaseService.getRawDatabase();
  const rows = prepareOcrPendingPage(db, OCR_MIME_TYPES).all(
    ...OCR_MIME_TYPES,
    OCR_MAX_ATTEMPTS,
    limit,
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export class AttachmentOcrQueue {
  private readonly pending: string[] = [];
  private readonly known = new Set<string>();
  private running: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private overflowCount = 0;

  constructor(private deps: OcrQueueDeps) {}

  /** Allow jobs to run. Called once from main.ts at app start. */
  start(overrides: Partial<OcrQueueDeps> = {}): void {
    this.deps = { ...this.deps, ...overrides };
    this.started = true;
    this.stopped = false;
  }

  /** App quit: clear the queue, stop the live child; the running job writes nothing. */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.known.clear();
    try {
      this.deps.stopChild();
    } catch {
      /* nothing to stop */
    }
  }

  get size(): number {
    return this.pending.length;
  }

  get overflowed(): number {
    return this.overflowCount;
  }

  get busy(): boolean {
    return this.running !== null || this.pending.length > 0;
  }

  enqueue(id: string): EnqueueResult {
    if (this.stopped) return "stopped";
    if (!this.started) return "not-started";
    if (!this.deps.isSupported()) return "unsupported";
    if (this.known.has(id)) return "duplicate";
    if (this.pending.length >= this.deps.cap) {
      this.overflowCount++;
      logService.info("OCR queue full; attachment left pending for a later drain", SERVICE_NAME, {
        cap: this.deps.cap,
        overflowed: this.overflowCount,
      });
      return "overflow";
    }
    this.pending.push(id);
    this.known.add(id);
    this.pump();
    return "queued";
  }

  /**
   * After a sync: queue up to drainBatch older OCR-pending files. A no-op while the
   * queue is busy (a deal sync runs several windows back to back; one drain is enough)
   * and while the machine is on battery.
   */
  requestDrainAfterSync(): DrainResult {
    if (this.stopped) return { queued: 0, skipped: "stopped" };
    if (!this.started) return { queued: 0, skipped: "not-started" };
    if (!this.deps.isSupported()) return { queued: 0, skipped: "unsupported" };
    if (this.busy) return { queued: 0, skipped: "busy" };
    let onBattery = false;
    try {
      onBattery = this.deps.isOnBatteryPower();
    } catch {
      onBattery = false;
    }
    if (onBattery) {
      logService.info("OCR drain skipped: on battery power", SERVICE_NAME);
      return { queued: 0, skipped: "battery" };
    }
    let ids: string[];
    try {
      ids = this.deps.selectPendingIds(this.deps.drainBatch);
    } catch (err) {
      logService.warn("OCR drain: pending query failed", SERVICE_NAME, {
        error: err instanceof Error ? err.message : "Unknown",
      });
      return { queued: 0, skipped: "error" };
    }
    let queued = 0;
    for (const id of ids) if (this.enqueue(id) === "queued") queued++;
    if (queued > 0) logService.info("OCR drain queued older attachments", SERVICE_NAME, { queued });
    return { queued };
  }

  /** Resolves when the queue is empty and no job is running. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    this.running = this.work().finally(() => {
      this.running = null;
    });
  }

  private async work(): Promise<void> {
    while (!this.stopped && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      try {
        await this.deps.run(id, { isStopped: () => this.stopped });
      } catch (err) {
        // ocrAttachmentText never throws; this is a backstop so the queue keeps going.
        logService.warn("OCR job failed", SERVICE_NAME, {
          id,
          error: err instanceof Error ? err.message : "Unknown",
        });
        Sentry.captureException(err, { tags: { service: "attachment-ocr", operation: "queue" } });
      } finally {
        this.known.delete(id);
      }
    }
  }
}

const sharedQueue = new AttachmentOcrQueue({
  run: ocrAttachmentText,
  isSupported: () => isOcrSupportedPlatform(),
  isOnBatteryPower: () => false,
  selectPendingIds: selectPendingIdsFromDb,
  stopChild: () => {
    stopLiveOcrChild();
  },
  cap: OCR_QUEUE_CAP,
  drainBatch: OCR_DRAIN_BATCH,
});

/** main.ts, at app start. `isOnBatteryPower` comes from Electron's powerMonitor. */
export function startAttachmentOcr(deps: { isOnBatteryPower: () => boolean }): void {
  sharedQueue.start({ isOnBatteryPower: deps.isOnBatteryPower });
}

/** main.ts, before-quit. */
export function stopAttachmentOcr(): void {
  sharedQueue.stop();
}

/** The text-layer pass, for a PDF that came back "empty". */
export function enqueueAttachmentOcr(id: string): EnqueueResult {
  return sharedQueue.enqueue(id);
}

/** After each email sync (emailSyncService). */
export function requestOcrDrainAfterSync(): DrainResult {
  return sharedQueue.requestDrainAfterSync();
}
