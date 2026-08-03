/**
 * Scoped diagnostic log store (BACKLOG-2393)
 *
 * The second of the two bounds. The window bounds *how long* we collect; this
 * bounds *how much*. Whichever is reached first stops growth, and neither
 * depends on the other — a 30-day grant on a busy machine must not be able to
 * fill the disk, and a size cap must not be reachable only because the window
 * happened to be long.
 *
 * Shape on disk, under `<baseDir>/logs/`:
 *
 *   current.log            appended to
 *   segment-<ts>-<n>.log   sealed segments, oldest deleted first
 *
 * ## Every record is encrypted, one frame at a time
 *
 * These lines contain contact names and phone numbers — PII scrubbing is
 * deferred by an explicit founder decision, so nothing removes them. Writing
 * them as plaintext JSONL meant anyone with read access to the user's home
 * directory could read a client list out of a diagnostics file.
 *
 * So each record is `[4-byte length][AES-256-GCM sealed JSON]`. Framing rather
 * than one sealed blob per file keeps appends O(1) — a whole-file re-seal per
 * line would be quadratic — and keeps the size caps meaningful, because the
 * bytes counted are still the bytes on disk. Encryption failure **drops the
 * record**; it never degrades to a plaintext write.
 *
 * ## Every record carries the grant it was collected under
 *
 * Each line begins `{"c":"<consent id>",...`, and `snapshot()` filters to a
 * single consent id. This is what stops a lapsed window's client data from
 * being shipped inside the *next* window's first report, attributed to a
 * consent the user gave months later. The store is also cleared whenever a
 * window ends, but that is hygiene — this filter is the guarantee, because it
 * holds even if the clear never ran.
 *
 * Every write is gated twice: the window must be open, and the scope must have
 * been granted. A closed window writes nothing at all — not a smaller amount.
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { SupportLogScopeId } from "./scopes";
import { frame, unframe, type SupportCipher } from "./supportCipher";

const CURRENT_FILENAME = "current.log";
const SEGMENT_PREFIX = "segment-";
const SEGMENT_SUFFIX = ".log";

/** Seal `current.log` once it passes this. */
export const DEFAULT_MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
/** Total bytes across all segments plus current. Oldest segments are dropped. */
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface SupportLogStoreDeps {
  now: () => number;
  /** Directory for support-access state; logs live in `<baseDir>/logs`. */
  baseDir: string;
  /** The window guard. Returns true only when this scope may be written. */
  isScopeActive: (scope: SupportLogScopeId) => boolean;
  /**
   * Id of the grant currently in force, stamped onto every record so a report
   * can be filtered to the consent it is attributed to. Null when closed.
   */
  currentConsentId: () => string | null;
  /** Encryption at rest. Required — there is no plaintext fallback. */
  cipher: SupportCipher;
  maxSegmentBytes?: number;
  maxTotalBytes?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SupportLogEntry {
  /** Id of the grant this was collected under. First key, so the filter is a prefix test. */
  c: string;
  /** ISO 8601 timestamp. */
  t: string;
  scope: SupportLogScopeId;
  event: string;
  [field: string]: unknown;
}

export interface SupportLogSnapshot {
  /** Concatenated log lines, oldest first, already filtered and truncated. */
  text: string;
  /** Bytes of matching content available before truncation. */
  totalBytes: number;
  /** Bytes dropped from the head to fit the budget. */
  droppedBytes: number;
  /** Number of files that contributed. */
  fileCount: number;
  /** Records that could not be decrypted, so the report can say so. */
  unreadableRecords: number;
  /** Records skipped because they belong to a different grant. */
  otherConsentRecords: number;
}

export interface SupportLogSnapshotOptions {
  /**
   * Include only records collected under this grant. Omit to include
   * everything — used by maintenance paths, never by report capture.
   */
  consentId?: string | null;
}

export class SupportLogStore {
  private deps: SupportLogStoreDeps;
  private writeChain: Promise<void> = Promise.resolve();
  private segmentCounter = 0;
  /** Tracked in memory so the common path does not stat on every line. */
  private currentBytes: number | null = null;
  /** Records lost because they could not be sealed. Never silently zero. */
  private droppedWrites = 0;

  constructor(deps: SupportLogStoreDeps) {
    this.deps = deps;
  }

  private get dir(): string {
    return path.join(this.deps.baseDir, "logs");
  }

  private get currentPath(): string {
    return path.join(this.dir, CURRENT_FILENAME);
  }

  private get maxSegmentBytes(): number {
    return this.deps.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
  }

  private get maxTotalBytes(): number {
    return this.deps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  /** Records dropped because sealing failed. Exposed so the loss is observable. */
  droppedWriteCount(): number {
    return this.droppedWrites;
  }

  /**
   * Record one event. Returns `false` when the entry was dropped because the
   * window is closed, the scope was not granted, or it could not be encrypted.
   */
  async write(
    scope: SupportLogScopeId,
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!this.deps.isScopeActive(scope)) return false;

    // No grant means no consent id to attribute the record to, so there is
    // nothing legitimate to write. isScopeActive should already have refused.
    const consentId = this.deps.currentConsentId();
    if (!consentId) return false;

    const entry: SupportLogEntry = {
      c: consentId,
      t: new Date(this.deps.now()).toISOString(),
      scope,
      event,
      ...fields,
    };
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (error) {
      // A circular or unserialisable field must not take down the caller's
      // pipeline; drop the payload but keep the fact that it happened.
      line = `${JSON.stringify({
        c: consentId,
        t: entry.t,
        scope,
        event,
        _error: `unserialisable fields: ${String(error)}`,
      })}\n`;
    }

    let wrote = false;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        wrote = await this.append(line);
      });
    await this.writeChain;
    return wrote;
  }

  private async append(line: string): Promise<boolean> {
    let record: Buffer;
    try {
      record = frame(await this.deps.cipher.seal(line));
    } catch (error) {
      // Fail closed. Writing this line in the clear would defeat the entire
      // point of the store, so the record is lost instead — loudly.
      this.droppedWrites += 1;
      this.log(
        this.droppedWrites === 1 ? "error" : "warn",
        `Support log record dropped: could not encrypt it (${String(error)})`,
      );
      return false;
    }

    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (this.currentBytes === null) {
        this.currentBytes = await this.statSize(this.currentPath);
      }

      // Seal before writing when this record would push us past the segment
      // size, so a segment never exceeds the bound it advertises.
      if (
        this.currentBytes > 0 &&
        this.currentBytes + record.length > this.maxSegmentBytes
      ) {
        await this.rotate();
      }

      await fs.appendFile(this.currentPath, record);
      this.currentBytes = (this.currentBytes ?? 0) + record.length;
      await this.enforceTotalCap();
      return true;
    } catch (error) {
      this.log("warn", `Support log write failed: ${String(error)}`);
      return false;
    }
  }

  private async statSize(target: string): Promise<number> {
    try {
      const stat = await fs.stat(target);
      return stat.size;
    } catch {
      return 0;
    }
  }

  private async rotate(): Promise<void> {
    // Counter disambiguates two rotations inside the same millisecond, which a
    // fake clock makes routine and a fast machine makes possible.
    this.segmentCounter += 1;
    const stamp = new Date(this.deps.now())
      .toISOString()
      .replace(/[:.]/g, "-");
    const target = path.join(
      this.dir,
      `${SEGMENT_PREFIX}${stamp}-${String(this.segmentCounter).padStart(4, "0")}${SEGMENT_SUFFIX}`,
    );
    try {
      await fs.rename(this.currentPath, target);
      this.currentBytes = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        this.log("warn", `Support log rotation failed: ${String(error)}`);
      }
      this.currentBytes = 0;
    }
  }

  /**
   * Drop oldest segments until the total fits. `current.log` is never deleted —
   * if it alone exceeds the cap it is rotated, and the resulting segment can
   * then be dropped on the next pass.
   */
  private async enforceTotalCap(): Promise<void> {
    const files = await this.listFiles();
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.maxTotalBytes) return;

    const segments = files
      .filter((f) => f.name !== CURRENT_FILENAME)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const segment of segments) {
      if (total <= this.maxTotalBytes) break;
      try {
        await fs.unlink(path.join(this.dir, segment.name));
        total -= segment.size;
      } catch (error) {
        this.log(
          "warn",
          `Could not drop support log segment ${segment.name}: ${String(error)}`,
        );
        break;
      }
    }

    if (total > this.maxTotalBytes) {
      // Only `current.log` is left and it is still over budget. Seal it so the
      // next pass has something it is allowed to delete.
      await this.rotate();
      await this.enforceTotalCap();
    }
  }

  private async listFiles(): Promise<Array<{ name: string; size: number }>> {
    try {
      const names = await fs.readdir(this.dir);
      const out: Array<{ name: string; size: number }> = [];
      for (const name of names) {
        if (
          name !== CURRENT_FILENAME &&
          !(name.startsWith(SEGMENT_PREFIX) && name.endsWith(SEGMENT_SUFFIX))
        ) {
          continue;
        }
        out.push({ name, size: await this.statSize(path.join(this.dir, name)) });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Total bytes currently held. Used by tests and by the Settings list. */
  async totalBytes(): Promise<number> {
    const files = await this.listFiles();
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  /**
   * Read the log for inclusion in a report, newest content preferred.
   *
   * Two filters apply before the budget does:
   *
   *  1. `options.consentId` — only records collected under the grant this
   *     report is attributed to. Without this, a report sent in August can
   *     carry contacts logged under a window that lapsed in March.
   *  2. Records that will not decrypt are skipped and counted, so a report says
   *     how much it could not read rather than presenting a hole as an absence.
   *
   * When the remainder exceeds `budgetBytes` the *oldest* records are dropped:
   * the most recent lines describe whatever the user is complaining about. The
   * cut is always between records, so the far end never parses a half-line.
   */
  async snapshot(
    budgetBytes: number,
    options: SupportLogSnapshotOptions = {},
  ): Promise<SupportLogSnapshot> {
    await this.flush();
    const files = await this.listFiles();
    const ordered = [
      ...files
        .filter((f) => f.name !== CURRENT_FILENAME)
        .sort((a, b) => a.name.localeCompare(b.name)),
      ...files.filter((f) => f.name === CURRENT_FILENAME),
    ];

    const empty: SupportLogSnapshot = {
      text: "",
      totalBytes: 0,
      droppedBytes: 0,
      fileCount: ordered.length,
      unreadableRecords: 0,
      otherConsentRecords: 0,
    };
    if (ordered.length === 0) return empty;

    const wanted =
      typeof options.consentId === "string" ? `{"c":"${options.consentId}",` : null;

    const lines: string[] = [];
    let unreadable = 0;
    let otherConsent = 0;
    let matchedBytes = 0;

    for (const file of ordered) {
      let raw: Buffer;
      try {
        raw = await fs.readFile(path.join(this.dir, file.name));
      } catch (error) {
        this.log(
          "warn",
          `Could not read support log ${file.name}: ${String(error)}`,
        );
        continue;
      }
      for (const record of unframe(raw)) {
        let line: string;
        try {
          line = (await this.deps.cipher.open(record.sealed)).toString("utf8");
        } catch {
          unreadable += 1;
          continue;
        }
        if (wanted && !line.startsWith(wanted)) {
          otherConsent += 1;
          continue;
        }
        lines.push(line);
        matchedBytes += Buffer.byteLength(line, "utf8");
      }
    }

    if (matchedBytes <= budgetBytes) {
      return {
        text: lines.join(""),
        totalBytes: matchedBytes,
        droppedBytes: 0,
        fileCount: ordered.length,
        unreadableRecords: unreadable,
        otherConsentRecords: otherConsent,
      };
    }

    // Walk backwards from the newest record, keeping whole lines only.
    const kept: string[] = [];
    let keptBytes = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const size = Buffer.byteLength(lines[i], "utf8");
      if (keptBytes + size > budgetBytes) break;
      kept.push(lines[i]);
      keptBytes += size;
    }
    kept.reverse();

    return {
      text: kept.join(""),
      totalBytes: matchedBytes,
      droppedBytes: matchedBytes - keptBytes,
      fileCount: ordered.length,
      unreadableRecords: unreadable,
      otherConsentRecords: otherConsent,
    };
  }

  /** Wait for queued writes to land. */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  /**
   * Remove everything.
   *
   * Called when a grant ends — **however it ends**. Revoke used to clear and
   * expiry did not, which left a lapsed window's contacts on disk to be swept
   * into the next grant's first report.
   */
  async clear(): Promise<void> {
    await this.flush();
    try {
      const names = await fs.readdir(this.dir);
      await Promise.all(
        names.map((name) =>
          fs.unlink(path.join(this.dir, name)).catch(() => undefined),
        ),
      );
    } catch {
      /* nothing to clear */
    }
    this.currentBytes = 0;
  }
}
