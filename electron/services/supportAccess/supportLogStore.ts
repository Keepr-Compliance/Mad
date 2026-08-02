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
 *   current.log            JSONL, appended to
 *   segment-<ts>-<n>.log   sealed segments, oldest deleted first
 *
 * One line per event, `{ t, scope, event, ...fields }`. JSONL rather than prose
 * so a segment can be tail-truncated at a line boundary without producing a
 * half-parsed record, and so the funnel entries stay machine-readable at the
 * far end.
 *
 * Every write is gated twice: the window must be open, and the scope must have
 * been granted. A closed window writes nothing at all — not a smaller amount.
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { SupportLogScopeId } from "./scopes";

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
  maxSegmentBytes?: number;
  maxTotalBytes?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SupportLogEntry {
  /** ISO 8601 timestamp. */
  t: string;
  scope: SupportLogScopeId;
  event: string;
  [field: string]: unknown;
}

export interface SupportLogSnapshot {
  /** Concatenated log lines, oldest first, already truncated to the budget. */
  text: string;
  /** Total bytes available before truncation. */
  totalBytes: number;
  /** Bytes dropped from the head to fit the budget. */
  droppedBytes: number;
  /** Number of files that contributed. */
  fileCount: number;
}

export class SupportLogStore {
  private deps: SupportLogStoreDeps;
  private writeChain: Promise<void> = Promise.resolve();
  private segmentCounter = 0;
  /** Tracked in memory so the common path does not stat on every line. */
  private currentBytes: number | null = null;

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

  /**
   * Record one event. Returns `false` when the entry was dropped because the
   * window is closed or the scope was not granted — callers that want to know
   * whether tracing is on should ask `isScopeActive` rather than infer it, but
   * the return value makes the drop observable in tests.
   */
  async write(
    scope: SupportLogScopeId,
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!this.deps.isScopeActive(scope)) return false;

    const entry: SupportLogEntry = {
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
        t: entry.t,
        scope,
        event,
        _error: `unserialisable fields: ${String(error)}`,
      })}\n`;
    }

    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.append(line));
    await this.writeChain;
    return true;
  }

  private async append(line: string): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (this.currentBytes === null) {
        this.currentBytes = await this.statSize(this.currentPath);
      }
      const lineBytes = Buffer.byteLength(line, "utf8");

      // Seal before writing when this line would push us past the segment
      // size, so a segment never exceeds the bound it advertises.
      if (
        this.currentBytes > 0 &&
        this.currentBytes + lineBytes > this.maxSegmentBytes
      ) {
        await this.rotate();
      }

      await fs.appendFile(this.currentPath, line, "utf8");
      this.currentBytes = (this.currentBytes ?? 0) + lineBytes;
      await this.enforceTotalCap();
    } catch (error) {
      this.log("warn", `Support log write failed: ${String(error)}`);
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
   * When the content exceeds `budgetBytes` the *head* is dropped, not the tail:
   * the most recent lines are the ones that describe whatever the user is
   * complaining about. The number of dropped bytes is returned so the report
   * can say so rather than presenting a partial log as a whole one.
   */
  async snapshot(budgetBytes: number): Promise<SupportLogSnapshot> {
    await this.flush();
    const files = await this.listFiles();
    const ordered = [
      ...files
        .filter((f) => f.name !== CURRENT_FILENAME)
        .sort((a, b) => a.name.localeCompare(b.name)),
      ...files.filter((f) => f.name === CURRENT_FILENAME),
    ];

    if (ordered.length === 0) {
      return { text: "", totalBytes: 0, droppedBytes: 0, fileCount: 0 };
    }

    const chunks: string[] = [];
    for (const file of ordered) {
      try {
        chunks.push(await fs.readFile(path.join(this.dir, file.name), "utf8"));
      } catch (error) {
        this.log(
          "warn",
          `Could not read support log ${file.name}: ${String(error)}`,
        );
      }
    }
    const text = chunks.join("");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= budgetBytes) {
      return {
        text,
        totalBytes: bytes,
        droppedBytes: 0,
        fileCount: ordered.length,
      };
    }

    // Cut on a line boundary so the far end never has to parse a half-record.
    const tail = Buffer.from(text, "utf8").subarray(bytes - budgetBytes);
    const asText = tail.toString("utf8");
    const firstNewline = asText.indexOf("\n");
    const trimmed =
      firstNewline >= 0 ? asText.slice(firstNewline + 1) : asText;
    return {
      text: trimmed,
      totalBytes: bytes,
      droppedBytes: bytes - Buffer.byteLength(trimmed, "utf8"),
      fileCount: ordered.length,
    };
  }

  /** Wait for queued writes to land. */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  /** Remove everything. Used when a grant ends and on explicit user request. */
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
