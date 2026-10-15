/**
 * Where every desktop log line goes (BACKLOG-3819 — logs encrypted at rest).
 *
 * The electron-log file transport hands each formatted, already-REDACTED line to
 * {@link SealedLogSink.write}. What happens to it depends on whether the file-data
 * key is open yet:
 *
 *   pending    The key is not open. Lines are held IN MEMORY (bounded, 1 MB).
 *              Nothing reaches disk.
 *   sealed     The key is open. Each line is appended as one sealed record
 *              (atRest/sealedLog.ts). No plaintext reaches disk.
 *   plaintext  The key could not be opened this run, or more than 1 MB was
 *              logged before it opened. Lines are appended, redacted, to
 *              `<name>.unsealed<ext>` (e.g. main.unsealed.log) — founder decision:
 *              redacted plaintext rather than a logging gap. The at-rest "logs"
 *              job seals that file into main.log and deletes it at the next
 *              point the key opens (this run or a later one).
 *
 * ## When the key opens, and the plaintext window
 *
 * The data key is opened by the at-rest startup queue, which waits for the local
 * database to open so that the keychain is never asked before the user has been
 * told why (atRest/startup.ts). So the in-memory window is "process start until
 * the database opens". Redacted plaintext can reach disk only when:
 *   (a) more than 1 MB is logged before the database opens,
 *   (b) the app exits before the database opens (for example a signed-out
 *       session) — the buffer is flushed at exit, and
 *   (c) secure storage cannot open the key for the whole run.
 * In each case the file is sealed and removed at the next launch where the key opens.
 *
 * This module never opens secure storage and never imports electron-log.
 */
import fs from "fs";
import path from "path";

import type { AtRestKey } from "./atRest/fileCrypto";
import { SealedLogAppender } from "./atRest/sealedLog";
import { redactLogText } from "../utils/redactSensitive";

/** In-memory budget before the key opens. Overflow spills to the unsealed file — never dropped. */
export const PRE_KEY_BUFFER_BYTES = 1024 * 1024;

export type SealedLogSinkState = "pending" | "sealed" | "plaintext";

/** `main.log` -> `main.unsealed.log` (same directory). */
export function unsealedPathFor(file: string): string {
  const p = path.parse(file);
  return path.join(p.dir, `${p.name}.unsealed${p.ext}`);
}

/** Inverse of {@link unsealedPathFor}; null when `file` is not an unsealed file. */
export function sealedTargetFor(file: string): string | null {
  const p = path.parse(file);
  if (!p.name.endsWith(".unsealed")) return null;
  return path.join(p.dir, `${p.name.slice(0, -".unsealed".length)}${p.ext}`);
}

/** `main.log` -> `main.old.log`, electron-log's own archive name. */
export function archivePathFor(file: string): string {
  const p = path.parse(file);
  return path.join(p.dir, `${p.name}.old${p.ext}`);
}

export interface SealedLogSinkOptions {
  bufferCapBytes?: number;
  /** Reports sink failures. Must not log through electron-log (it would recurse). */
  report?: (message: string) => void;
}

export class SealedLogSink {
  private mode: SealedLogSinkState = "pending";
  /** Sealed mode, writes held in memory while a deferred trim replaces files. */
  private paused = false;
  /** Paused and over the memory cap: later lines go straight to the unsealed file. */
  private pausedSpill = false;
  /** Set by {@link flushAtExit}: a trim in flight must leave the original file alone. */
  private closing = false;
  private buffer: Array<{ file: string; text: string; maxSize: number }> = [];
  private bufferedBytes = 0;
  private appender: SealedLogAppender | null = null;
  private readonly keys = new Map<string, Buffer>();
  private readonly cap: number;
  private readonly report: (message: string) => void;

  constructor(opts: SealedLogSinkOptions = {}) {
    this.cap = opts.bufferCapBytes ?? PRE_KEY_BUFFER_BYTES;
    // eslint-disable-next-line no-console
    this.report = opts.report ?? ((m) => console.error(m));
  }

  /** True once the process is exiting; a file replacement in flight must abort. */
  get isClosing(): boolean {
    return this.closing;
  }

  get state(): SealedLogSinkState {
    return this.mode;
  }

  /** Lines held in memory, not yet on disk. */
  get pendingLines(): ReadonlyArray<{ file: string; text: string }> {
    return this.buffer;
  }

  /** A data key this sink holds, for synchronous decryption of its own files. */
  keyFor(keyId: string): Buffer | null {
    return this.keys.get(keyId) ?? null;
  }

  /** The key new records are sealed with, once open. */
  get currentKey(): AtRestKey | null {
    if (!this.appender) return null;
    const key = this.keys.get(this.appender.keyId);
    return key ? { keyId: this.appender.keyId, key } : null;
  }

  /** One formatted line, including its line ending. */
  write(file: string, text: string, maxSize = 0): void {
    try {
      if (this.mode === "sealed" && this.paused) {
        if (this.pausedSpill) return this.writePlain(file, text, maxSize);
        this.buffer.push({ file, text, maxSize });
        this.bufferedBytes += Buffer.byteLength(text, "utf8");
        if (this.bufferedBytes > this.cap) {
          // Bounded memory without losing lines: the held lines (and the rest of
          // the pause) go to the redacted unsealed file, which the trim never
          // touches; the at-rest "logs" job seals it at the next launch.
          this.pausedSpill = true;
          this.spillBuffer();
        }
        return;
      }
      if (this.mode === "sealed") return this.writeSealed(file, text, maxSize);
      if (this.mode === "plaintext") return this.writePlain(file, text, maxSize);
      this.buffer.push({ file, text, maxSize });
      this.bufferedBytes += Buffer.byteLength(text, "utf8");
      if (this.bufferedBytes > this.cap) {
        // Never drop: move to the redacted plaintext fallback until the key opens.
        this.mode = "plaintext";
        this.spillBuffer();
      }
    } catch (err) {
      this.report(`[SealedLogSink] write failed: ${(err as Error).message}`);
    }
  }

  /**
   * The key is open: flush anything held in memory as sealed records and seal
   * every later line. Unsealed files on disk are merged by the at-rest "logs"
   * job, which runs immediately before this.
   */
  activate(key: AtRestKey): void {
    this.keys.set(key.keyId, key.key);
    this.appender = new SealedLogAppender({
      key,
      migratePlaintext: (t) => redactLogText(t),
      notice: (m) => this.report(m),
    });
    this.mode = "sealed";
    const held = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    for (const item of held) this.write(item.file, item.text, item.maxSize);
  }

  /** The key cannot be opened this run: redacted plaintext until the next launch. */
  fallbackToPlaintext(reason: string): void {
    if (this.mode === "sealed") return;
    this.report(`[SealedLogSink] data key unavailable — writing redacted plaintext until it opens: ${reason}`);
    this.mode = "plaintext";
    this.spillBuffer();
  }

  /**
   * Hold sealed writes in memory while log files are replaced asynchronously
   * (the deferred trim in atRest/startup.ts). Held lines are visible in
   * {@link pendingLines} and written, in order, by {@link resume} or at exit.
   */
  pause(): void {
    if (this.mode === "sealed") this.paused = true;
  }

  /** End {@link pause}: append everything held, in order. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pausedSpill = false;
    const held = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    for (const item of held) this.write(item.file, item.text, item.maxSize);
  }

  /** Exit (or startup failure) before the key opened: put held lines on disk, redacted. */
  flushAtExit(): void {
    if (this.paused) {
      this.closing = true;
      return this.resume();
    }
    if (this.mode !== "pending" || this.buffer.length === 0) return;
    try {
      this.spillBuffer();
    } catch (err) {
      this.report(`[SealedLogSink] exit flush failed: ${(err as Error).message}`);
    }
  }

  /** After the logs job replaced or removed a file this sink may have open. */
  forget(file: string): void {
    this.appender?.forget(file);
  }

  private spillBuffer(): void {
    const held = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    for (const item of held) this.writePlain(item.file, item.text, item.maxSize);
  }

  private writeSealed(file: string, text: string, maxSize: number): void {
    const appender = this.appender;
    if (!appender) throw new Error("sealed mode without an appender");
    if (maxSize > 0 && appender.size(file) > maxSize) {
      try {
        fs.renameSync(file, archivePathFor(file));
      } catch (err) {
        this.report(`[SealedLogSink] could not rotate ${path.basename(file)}: ${(err as Error).message}; starting it over`);
        fs.rmSync(file, { force: true });
      }
      appender.forget(file);
    }
    appender.append(file, text);
  }

  private writePlain(file: string, text: string, maxSize: number): void {
    const target = unsealedPathFor(file);
    if (maxSize > 0) {
      let size = 0;
      try {
        size = fs.statSync(target).size;
      } catch {
        size = 0;
      }
      if (size > maxSize) {
        // Same bound as the sealed file: keep the newest quarter.
        const keep = fs.readFileSync(target).subarray(-Math.floor(maxSize / 4));
        fs.writeFileSync(target, Buffer.concat([Buffer.from("[log cropped]\n"), keep]), { mode: 0o600 });
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, redactLogText(text), { mode: 0o600 });
  }
}

let sink: SealedLogSink | null = null;
let sealingEnabled = true;

/**
 * Whether this process seals its logs at rest. Set once, first thing, by
 * bootstrap/installAppDataPaths.ts from `logsSealedAtRest` (packaged = sealed,
 * dev = redacted plaintext). The at-rest "logs" job reads it, so the file
 * transport and the job can never disagree.
 */
export function setLogSealingEnabled(enabled: boolean): void {
  sealingEnabled = enabled;
}

export function isLogSealingEnabled(): boolean {
  return sealingEnabled;
}

/** The process-wide sink the electron-log transport writes through. */
export function getLogSink(): SealedLogSink {
  if (!sink) sink = new SealedLogSink();
  return sink;
}

/** Tests only. */
export function resetLogSinkForTests(next: SealedLogSink | null = null): void {
  sink = next;
  sealingEnabled = true;
}
