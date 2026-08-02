/**
 * Diagnostic report queue (BACKLOG-2393)
 *
 * Captures a report, compresses it, and parks it on disk with metadata the
 * Settings list can render without decompressing anything.
 *
 * ## Why a visible queue rather than a direct send
 *
 * A report sits here before it leaves. That is the difference between "you
 * agreed to a blanket grant" and "you can see what is about to go and remove
 * it first", and it costs one directory.
 *
 * ## The 10 MB cap is real
 *
 * The `support-attachments` bucket rejects anything over 10485760 bytes, and
 * one log observed in the field was 15 MB. So we gzip, and if the result is
 * still too large we drop log *history* — oldest first — and say by how much
 * in the payload itself.
 *
 * What we do not do is quietly ship a truncated file that looks complete. A
 * report that cannot be made to fit is marked failed with a reason, because a
 * misleading report is worse than a missing one: it would send someone looking
 * for a bug in the wrong place.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { gzip as gzipCb } from "zlib";
import { promisify } from "util";
import { describeScopes, type SupportLogScopeId } from "./scopes";
import type { SupportLogStore } from "./supportLogStore";
import type {
  SupportConsentRecord,
  SupportReportListItem,
  SupportReportMeta,
  SupportReportReason,
  SupportRemoteRef,
} from "./types";

const gzip = promisify(gzipCb);

/**
 * Bucket hard limit is 10485760. We aim below it: gzip output varies by a few
 * percent between zlib builds, and being rejected at the far end after a
 * successful local capture is the least debuggable failure available.
 */
export const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;

/** First attempt's log budget, uncompressed. JSONL compresses ~8-15x. */
const INITIAL_LOG_BUDGET_BYTES = 64 * 1024 * 1024;
/** Give up rather than loop forever; each attempt quarters the budget. */
const MAX_FIT_ATTEMPTS = 8;

const PAYLOAD_SUFFIX = ".json.gz";
const META_SUFFIX = ".meta.json";

export interface SupportReportPayload {
  schema: "keepr.support-report.v1";
  capturedAt: string;
  reason: SupportReportReason;
  /** The grant this was captured under, travelling with the data it authorised. */
  consent: SupportConsentRecord;
  /** Output of the existing diagnostics collector, already sanitised. */
  diagnostics: unknown;
  logs: {
    scopes: SupportLogScopeId[];
    text: string;
    /** Bytes available before truncation. */
    totalBytes: number;
    /** Bytes dropped from the head. Non-zero means this is a partial log. */
    droppedBytes: number;
    truncated: boolean;
  };
}

export interface SupportReportQueueDeps {
  now: () => number;
  baseDir: string;
  logStore: SupportLogStore;
  /** Injected so tests need not construct the whole diagnostics graph. */
  collectDiagnostics: () => Promise<unknown>;
  /** Current consent, or null when the window is closed. */
  getConsent: () => SupportConsentRecord | null;
  maxUploadBytes?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class SupportReportQueue {
  private deps: SupportReportQueueDeps;

  constructor(deps: SupportReportQueueDeps) {
    this.deps = deps;
  }

  private get dir(): string {
    return path.join(this.deps.baseDir, "queue");
  }

  private get maxUploadBytes(): number {
    return this.deps.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  }

  private payloadPath(id: string): string {
    return path.join(this.dir, `${id}${PAYLOAD_SUFFIX}`);
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}${META_SUFFIX}`);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  /**
   * Capture a report under the current grant.
   *
   * Throws when the window is closed. That is deliberate: capture is the step
   * that reads a user's contacts, and it should be impossible to reach it
   * without an open grant even by mistake.
   */
  async capture(reason: SupportReportReason): Promise<SupportReportMeta> {
    const consent = this.deps.getConsent();
    if (!consent) {
      throw new Error("Cannot capture a support report without an active grant");
    }

    const diagnostics = await this.deps.collectDiagnostics();
    const capturedAt = new Date(this.deps.now()).toISOString();

    let budget = INITIAL_LOG_BUDGET_BYTES;
    let attempt = 0;
    let body: Buffer | null = null;
    let payload: SupportReportPayload | null = null;
    let rawBytes = 0;

    while (attempt < MAX_FIT_ATTEMPTS) {
      const snapshot = await this.deps.logStore.snapshot(budget);
      payload = {
        schema: "keepr.support-report.v1",
        capturedAt,
        reason,
        consent,
        diagnostics,
        logs: {
          scopes: consent.scopes,
          text: snapshot.text,
          totalBytes: snapshot.totalBytes,
          droppedBytes: snapshot.droppedBytes,
          truncated: snapshot.droppedBytes > 0,
        },
      };
      const json = JSON.stringify(payload);
      rawBytes = Buffer.byteLength(json, "utf8");
      const candidate = await gzip(json);
      if (candidate.length <= this.maxUploadBytes) {
        body = candidate;
        break;
      }
      attempt += 1;
      if (budget === 0) break;
      budget = Math.floor(budget / 4);
      this.log(
        "info",
        `Support report over cap (${candidate.length} bytes gzipped); retrying with a ${budget} byte log budget`,
      );
    }

    if (!body || !payload) {
      // Diagnostics alone will not fit. Fail loudly and keep nothing: shipping
      // a report whose logs were silently emptied would look like a machine
      // with nothing to report.
      const message =
        "Diagnostic report exceeds the 10 MB upload limit even with all log history removed";
      this.log("error", message);
      throw new Error(message);
    }

    const id = randomUUID();
    const meta: SupportReportMeta = {
      id,
      capturedAt,
      reason,
      byteSize: body.length,
      rawByteSize: rawBytes,
      scopes: consent.scopes,
      covers: describeScopes(consent.scopes),
      state: "queued",
      truncated: payload.logs.truncated,
      truncatedBytes: payload.logs.droppedBytes,
      consentId: consent.id,
    };

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.payloadPath(id), body);
    await this.writeMeta(meta);
    this.log(
      "info",
      `Support report ${id} queued (${body.length} bytes, reason=${reason}${
        meta.truncated ? `, ${meta.truncatedBytes} log bytes dropped` : ""
      })`,
    );
    return meta;
  }

  private async writeMeta(meta: SupportReportMeta): Promise<void> {
    const target = this.metaPath(meta.id);
    const tmp = `${target}.tmp`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  async readBody(id: string): Promise<Buffer> {
    return fs.readFile(this.payloadPath(id));
  }

  async getMeta(id: string): Promise<SupportReportMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(id), "utf8");
      return JSON.parse(raw) as SupportReportMeta;
    } catch {
      return null;
    }
  }

  /** Newest first — the order the list renders in. */
  async list(): Promise<SupportReportMeta[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SupportReportMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const id = name.slice(0, -META_SUFFIX.length);
      const meta = await this.getMeta(id);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /**
   * List with the retention countdown resolved. `serverDeleteInDays` is what
   * turns a retention policy into something a user can act on.
   */
  async listForDisplay(): Promise<SupportReportListItem[]> {
    const now = this.deps.now();
    return (await this.list()).map((meta) => {
      if (!meta.serverExpiresAt) return { ...meta };
      const ms = Date.parse(meta.serverExpiresAt) - now;
      return {
        ...meta,
        serverDeleteInDays: Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000))),
      };
    });
  }

  async markSent(
    id: string,
    remote: SupportRemoteRef,
    serverExpiresAt: string,
  ): Promise<SupportReportMeta | null> {
    const meta = await this.getMeta(id);
    if (!meta) return null;
    const next: SupportReportMeta = {
      ...meta,
      state: "sent",
      sentAt: new Date(this.deps.now()).toISOString(),
      remote,
      serverExpiresAt,
      lastError: undefined,
    };
    await this.writeMeta(next);
    return next;
  }

  async markFailed(
    id: string,
    error: string,
  ): Promise<SupportReportMeta | null> {
    const meta = await this.getMeta(id);
    if (!meta) return null;
    // A previously sent report that fails a later operation stays "sent" — its
    // remote copy still exists, and downgrading it would tell the user the
    // opposite of the truth.
    const next: SupportReportMeta = { ...meta, lastError: error };
    if (meta.state !== "sent") next.state = "failed";
    await this.writeMeta(next);
    return next;
  }

  /** Remove the local payload and metadata. Server-side deletion is separate. */
  async removeLocal(id: string): Promise<void> {
    await fs.unlink(this.payloadPath(id)).catch(() => undefined);
    await fs.unlink(this.metaPath(id)).catch(() => undefined);
  }

  /**
   * Drop local copies of reports whose server-side retention has passed.
   * The row disappears rather than lingering as a tombstone.
   */
  async purgeExpired(): Promise<string[]> {
    const now = this.deps.now();
    const removed: string[] = [];
    for (const meta of await this.list()) {
      if (!meta.serverExpiresAt) continue;
      if (Date.parse(meta.serverExpiresAt) > now) continue;
      await this.removeLocal(meta.id);
      removed.push(meta.id);
    }
    return removed;
  }
}
