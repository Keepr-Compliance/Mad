/**
 * Diagnostic report queue (BACKLOG-2393)
 *
 * Captures a report, compresses it, encrypts it, and parks it on disk with
 * metadata the Settings list can render without opening anything.
 *
 * ## Why a visible queue rather than a direct send
 *
 * A report sits here before it leaves. That is the difference between "you
 * agreed to a blanket grant" and "you can see what is about to go and remove
 * it first", and it costs one directory.
 *
 * ## Encrypted, not just compressed
 *
 * The payload used to be gzip alone. `gunzipSync` with no key recovered a
 * client's name and phone number straight off disk. Gzip is compression; it is
 * not, and never was, protection. So the body is gzipped for the upload cap and
 * then sealed with the machine's key (see `supportCipher`). What travels is the
 * gzip; what rests is the sealed form.
 *
 * The metadata sidecar stays plaintext, deliberately. It holds no contact data —
 * sizes, timestamps, scope labels — and it is what renders the row that carries
 * the Delete button. Sealing it would mean that a machine which lost its key
 * showed the user an empty list while their reports sat on Keepr's server: the
 * exact "you cannot delete what you cannot see" failure this feature is being
 * fixed for.
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
import type { SupportCipher } from "./supportCipher";
import { SUPPORT_REPORT_RETENTION_DAYS } from "./disclosure";
import type {
  SupportConsentRecord,
  SupportReportListItem,
  SupportReportMeta,
  SupportReportReason,
  SupportRemoteRef,
} from "./types";

const gzip = promisify(gzipCb);

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Sealed on disk — the suffix says so, rather than claiming to be a gzip. */
const PAYLOAD_SUFFIX = ".report.enc";
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
    /** Records that would not decrypt, stated rather than presented as absence. */
    unreadableRecords: number;
    /**
     * Records excluded because they belong to a different grant. Non-zero is
     * the system working: a previous window's data is not this consent's to send.
     */
    otherConsentRecords: number;
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
  /** Encryption at rest. Required — there is no plaintext fallback. */
  cipher: SupportCipher;
  /**
   * Days a report may sit here before it is dropped, whether or not it was ever
   * uploaded. Matches the retention the consent screen promises.
   */
  retentionDays?: number;
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

  private get retentionDays(): number {
    return this.deps.retentionDays ?? SUPPORT_REPORT_RETENTION_DAYS;
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
      // Scoped to *this* consent. A report attributed to this grant must not
      // carry records collected under an earlier one that has since lapsed.
      const snapshot = await this.deps.logStore.snapshot(budget, {
        consentId: consent.id,
      });
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
          unreadableRecords: snapshot.unreadableRecords,
          otherConsentRecords: snapshot.otherConsentRecords,
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

    // Seal before anything touches the disk. If this machine cannot protect the
    // data at rest, the capture fails — it does not fall back to writing a
    // client list in the clear.
    const sealed = await this.deps.cipher.seal(body);

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
      // The retention clock starts at capture, not at upload. A report that
      // never uploads — offline, signed out, a failing transport — used to sit
      // here forever holding client names, because only *sent* reports had any
      // deadline at all.
      localExpiresAt: new Date(
        this.deps.now() + this.retentionDays * DAY_MS,
      ).toISOString(),
    };

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.payloadPath(id), sealed, { mode: 0o600 });
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

  /** The gzipped body, as it will be uploaded. Opens the sealed file to get it. */
  async readBody(id: string): Promise<Buffer> {
    return this.deps.cipher.open(await fs.readFile(this.payloadPath(id)));
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
   * List with both retention countdowns resolved. A deadline a user cannot see
   * is not something they can act on, and there are two of them: how long the
   * server keeps a sent report, and how long this machine keeps an unsent one.
   */
  async listForDisplay(): Promise<SupportReportListItem[]> {
    const now = this.deps.now();
    const inDays = (iso: string): number =>
      Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY_MS));
    return (await this.list()).map((meta) => {
      const item: SupportReportListItem = { ...meta };
      if (meta.serverExpiresAt) {
        item.serverDeleteInDays = inDays(meta.serverExpiresAt);
      }
      if (meta.localExpiresAt && !meta.remote) {
        item.localDeleteInDays = inDays(meta.localExpiresAt);
      }
      return item;
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
   * Reports whose *local* retention has run out and which have no server copy —
   * captured but never uploaded. Safe to drop outright: there is nothing left
   * for the user to reach, so removing the row removes the last copy.
   */
  async purgeLocallyExpired(): Promise<string[]> {
    const now = this.deps.now();
    const removed: string[] = [];
    for (const meta of await this.list()) {
      if (meta.remote) continue;
      if (!meta.localExpiresAt) continue;
      if (Date.parse(meta.localExpiresAt) > now) continue;
      await this.removeLocal(meta.id);
      removed.push(meta.id);
      this.log(
        "info",
        `Support report ${meta.id} dropped: ${this.retentionDays}-day local retention reached, never uploaded`,
      );
    }
    return removed;
  }

  /**
   * Reports past their server retention deadline that still have a remote copy.
   *
   * This deliberately does **not** delete anything. Dropping the local row here
   * is what used to remove the Delete button from Settings while the copy on
   * Keepr's server carried on existing — the user was shown "gone" for
   * something still held. Deletion runs through the scheduler, server first, and
   * the row survives a failure so it stays deletable by hand.
   */
  async dueForServerPurge(): Promise<SupportReportMeta[]> {
    const now = this.deps.now();
    return (await this.list()).filter(
      (meta) =>
        Boolean(meta.remote) &&
        Boolean(meta.serverExpiresAt) &&
        Date.parse(meta.serverExpiresAt as string) <= now,
    );
  }
}
