/**
 * BACKLOG-3819 — one-time scrub and 14-day retention for the electron-log files.
 *
 * The sink hook (config/logFileConfig.ts) keeps NEW lines free of customer
 * emails and phone numbers. This module deals with what is already on disk:
 *
 *  1. Retention (founder decision D7, 14 days): an archived log
 *     (`*.old.log`) whose last write is older than 14 days is deleted; lines
 *     older than 14 days at the head of any remaining log are dropped.
 *  2. Scrub (founder decision D6, scrub in place): `main.log` and
 *     `main.old.log` are rewritten through the same redactor the hook uses.
 *     Each rewrite goes to a temp file in the same directory and is renamed
 *     over the original, so a crash mid-scrub leaves the original intact.
 *
 * Safe against the live writer: electron-log appends by PATH on every line
 * (`fs.writeFileSync(path, text, { flag: "a" })`,
 * node_modules/electron-log/src/node/transports/file/File.js:131) and holds no
 * open descriptor, so a line written after the rename lands in the new file.
 * Everything here is synchronous, so no log call can interleave between the
 * read and the rename on the main thread.
 *
 * Idempotent: a file whose content the redactor leaves unchanged is not
 * rewritten, and redacted text is never re-matched (see `redactLogText`).
 * After one complete pass a marker (`.keepr-log-scrub-v1`) is written; later
 * launches then read only the first line of each file (for retention) instead
 * of re-reading up to 16 MB — measured ~150 ms per launch on an 8.5 MB log.
 *
 * ## Sealed files (BACKLOG-3819 encryption follow-up)
 *
 * Logs are now sealed at rest (atRest/sealedLog.ts, KEPRLOG). When the data key
 * is passed in:
 *   - a sealed file is decrypted, retention + redaction applied, and re-sealed
 *     under a fresh salt if anything changed (archives: deleted by mtime first,
 *     without decrypting);
 *   - a PLAINTEXT `*.log` (written before this build) is retained, redacted and
 *     SEALED — the plaintext copy is replaced;
 *   - `<name>.unsealed.log` (the redacted fallback written while the key was not
 *     open — services/sealedLogSink.ts) is merged into the sealed `<name>.log`
 *     and deleted.
 * Without the key, sealed files are left as they are (archives still expire by
 * mtime) and plaintext files get the original redact-in-place treatment.
 *
 * The job runs before the sink starts sealing (it holds lines in memory until
 * then), so no log line can be appended to a file while it is being replaced.
 *
 * Called at launch by the at-rest startup queue (atRest/startup.ts, job
 * "logs") through {@link runConfiguredLogMaintenance}. The log directory comes
 * from electron-log, which core modules may not import, so the Electron shell
 * (bootstrap/installAppDataPaths.ts) supplies it via {@link setLogDirectoryResolver}.
 */

import fs from "fs";
import path from "path";
import { redactLogText } from "../utils/redactSensitive";
import type { AtRestKey } from "./atRest/fileCrypto";
import {
  SEAL_TMP_RE,
  isSealedLogFile,
  openSealedLog,
  readFirstSealedRecord,
  replaceWithSealedLogSync,
} from "./atRest/sealedLog";
import { archivePathFor, sealedTargetFor } from "./sealedLogSink";

/** Founder decision D7. */
export const LOG_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** electron-log's default line prefix: `[2026-10-08 22:22:48.540] [info] ...` (local time). */
const LINE_TIMESTAMP_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;

/** Files this module may touch. Nothing else in the log directory is read or changed. */
const LOG_FILE_RE = /^[\w.-]+\.log$/;
const ARCHIVE_FILE_RE = /^[\w.-]+\.old\.log$/;

/** Written once every log in the directory has been through the redactor. */
export const SCRUB_MARKER = ".keepr-log-scrub-v1";

/** Timestamp of the first line of a file, reading only its first 64 bytes. */
function headTimestamp(file: string): number | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    return parseLineTimestamp(buf.subarray(0, n).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogMaintenanceResult {
  deleted: string[];
  rewritten: string[];
  /** Plaintext files converted to sealed files (including merged *.unsealed.log). */
  sealed: string[];
  /** Sealed files that could not be authenticated or are under a key not held — left untouched. */
  unreadable: string[];
  /**
   * Sealed files whose oldest entry is past retention, left for a later
   * {@link runLogMaintenance} without `deferSealedRewrites` (a full decrypt +
   * reseal, kept off the launch path).
   */
  deferred: string[];
  errors: Array<{ file: string; message: string }>;
}

export interface LogMaintenanceOptions {
  /** The open data key. null/absent = the key is not available this run. */
  key?: AtRestKey | null;
  /** Called after a file was replaced or removed, so a writer can drop cached state. */
  onReplaced?: (file: string) => void;
  /**
   * Launch path: when the scrub marker is present, a sealed file whose head entry
   * is past retention is reported in `deferred` instead of being decrypted and
   * resealed now.
   */
  deferSealedRewrites?: boolean;
}

type FileOutcome = "deleted" | "rewritten" | "unchanged" | "sealed" | "unreadable" | "deferred";

/** Parse the timestamp an electron-log line starts with, or null for a continuation line. */
export function parseLineTimestamp(line: string): number | null {
  const m = LINE_TIMESTAMP_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms ? Number(ms.padEnd(3, "0")) : 0,
  ).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Drop entries older than `cutoff` from the head of a log. An entry is a
 * timestamped line plus the continuation lines (stack traces, multi-line
 * objects) that follow it. Lines before the first timestamp are kept with the
 * first entry they precede.
 */
export function dropEntriesBefore(content: string, cutoff: number): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = parseLineTimestamp(lines[i]);
    if (t !== null && t >= cutoff) return i === 0 ? content : lines.slice(i).join("\n");
  }
  // No entry at or after the cutoff. Keep the content only if it holds no
  // timestamp at all (we cannot tell its age).
  return lines.some((l) => parseLineTimestamp(l) !== null) ? "" : content;
}

/** Atomically replace `file` with `content` (temp file in the same directory, then rename). */
function replaceFileSync(file: string, content: string): void {
  const tmp = `${file}.scrub-${process.pid}-${Date.now()}.tmp`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: mode ?? 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp never created */
    }
    throw err;
  }
}

/**
 * Apply retention and the redactor to one log file. Returns "deleted",
 * "rewritten" or "unchanged".
 */
export function maintainLogFile(
  file: string,
  now: number,
  retentionDays = LOG_RETENTION_DAYS,
  alreadyScrubbed = false,
  key: AtRestKey | null = null,
  deferSealedRewrite = false,
): FileOutcome {
  const cutoff = now - retentionDays * DAY_MS;
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return "unchanged";
  const isArchive = ARCHIVE_FILE_RE.test(path.basename(file));

  if (isArchive && stat.mtimeMs < cutoff) {
    fs.unlinkSync(file);
    return "deleted";
  }

  if (isSealedLogFile(file)) {
    // Cannot read it without the key; an archive still expires by mtime above.
    if (!key) return "unchanged";
    const keyFor = (id: string) => (id === key.keyId ? key.key : null);
    if (alreadyScrubbed) {
      // Sealed lines were redacted before they were sealed, so once the marker is
      // down only retention can require a rewrite. Decrypt the first record only
      // (not the file) for the oldest timestamp — launch cost stays flat.
      const first = readFirstSealedRecord(file, keyFor);
      const head = first === null ? null : parseLineTimestamp(first);
      if (head !== null && head >= cutoff) return "unchanged";
      if (deferSealedRewrite) return "deferred";
    }
    const read = openSealedLog(fs.readFileSync(file), keyFor);
    if (read.problems.some((p) => p.kind !== "torn")) return "unreadable";
    const torn = read.problems.length > 0;
    const next = redactLogText(dropEntriesBefore(read.text, cutoff));
    if (next === "" && isArchive) {
      fs.unlinkSync(file);
      return "deleted";
    }
    if (next === read.text && !torn) return "unchanged";
    replaceWithSealedLogSync(file, next, key);
    return "rewritten";
  }

  if (key) {
    // Plaintext written before logs were sealed: retain, redact, seal.
    const text = redactLogText(dropEntriesBefore(fs.readFileSync(file, "utf8"), cutoff));
    if (text === "" && isArchive) {
      fs.unlinkSync(file);
      return "deleted";
    }
    replaceWithSealedLogSync(file, text, key);
    return "sealed";
  }

  if (alreadyScrubbed) {
    // Content was redacted on an earlier launch and every line since went
    // through the sink hook: only retention can still require a rewrite.
    const head = headTimestamp(file);
    // A null head (e.g. electron-log's "[log cropped]" first line) falls
    // through to the full read.
    if (head !== null && head >= cutoff) return "unchanged";
  }

  const original = fs.readFileSync(file, "utf8");
  const next = redactLogText(dropEntriesBefore(original, cutoff));
  if (next === "" && ARCHIVE_FILE_RE.test(path.basename(file))) {
    fs.unlinkSync(file);
    return "deleted";
  }
  if (next === original) return "unchanged";
  replaceFileSync(file, next);
  return "rewritten";
}

/**
 * Run retention + scrub over every `*.log` file directly inside `logDir`
 * (main.log, main.old.log, and any other electron-log file). Leftover scrub
 * temp files from a crash are removed. Never throws: per-file failures are
 * collected in `errors`.
 */
export function runLogMaintenance(
  logDir: string,
  now: number = Date.now(),
  opts: LogMaintenanceOptions = {},
): LogMaintenanceResult {
  const key = opts.key ?? null;
  const result: LogMaintenanceResult = {
    deleted: [],
    rewritten: [],
    sealed: [],
    unreadable: [],
    deferred: [],
    errors: [],
  };
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.errors.push({ file: logDir, message: (err as Error).message });
    }
    return result;
  }

  const alreadyScrubbed = names.includes(SCRUB_MARKER);
  const unsealed: string[] = [];
  for (const name of names) {
    const file = path.join(logDir, name);
    try {
      if (/\.scrub-\d+-\d+\.tmp$/.test(name) || SEAL_TMP_RE.test(name)) {
        fs.unlinkSync(file);
        continue;
      }
      if (!LOG_FILE_RE.test(name)) continue;
      // With the key, fallback files are merged after their targets are settled.
      if (key && sealedTargetFor(file)) {
        unsealed.push(name);
        continue;
      }
      const outcome = maintainLogFile(
        file,
        now,
        LOG_RETENTION_DAYS,
        alreadyScrubbed,
        key,
        opts.deferSealedRewrites === true,
      );
      if (outcome === "deleted") result.deleted.push(name);
      if (outcome === "rewritten") result.rewritten.push(name);
      if (outcome === "sealed") result.sealed.push(name);
      if (outcome === "unreadable") result.unreadable.push(name);
      if (outcome === "deferred") result.deferred.push(name);
      if (outcome !== "unchanged" && outcome !== "deferred") opts.onReplaced?.(file);
    } catch (err) {
      result.errors.push({ file: name, message: (err as Error).message });
    }
  }
  for (const name of key ? unsealed : []) {
    const file = path.join(logDir, name);
    try {
      const target = mergeUnsealedLog(file, now, key as AtRestKey);
      result.sealed.push(name);
      opts.onReplaced?.(file);
      opts.onReplaced?.(target);
    } catch (err) {
      result.errors.push({ file: name, message: (err as Error).message });
    }
  }
  if (!alreadyScrubbed && result.errors.length === 0) {
    try {
      fs.writeFileSync(path.join(logDir, SCRUB_MARKER), `${new Date(now).toISOString()}\n`);
    } catch (err) {
      result.errors.push({ file: SCRUB_MARKER, message: (err as Error).message });
    }
  }
  return result;
}

/**
 * Append the redacted fallback `<name>.unsealed.log` to the sealed `<name>.log`
 * (re-sealed under a fresh salt), then delete the fallback. A target that cannot
 * be read under this key is set aside as `<name>.old.log` first. Returns the target.
 */
export function mergeUnsealedLog(file: string, now: number, key: AtRestKey): string {
  const target = sealedTargetFor(file);
  if (!target) throw new Error(`${path.basename(file)} is not an unsealed log`);
  const cutoff = now - LOG_RETENTION_DAYS * DAY_MS;
  const extra = redactLogText(dropEntriesBefore(fs.readFileSync(file, "utf8"), cutoff));
  let existing = "";
  if (fs.existsSync(target)) {
    if (isSealedLogFile(target)) {
      const read = openSealedLog(fs.readFileSync(target), (id) => (id === key.keyId ? key.key : null));
      if (read.problems.some((p) => p.kind !== "torn")) {
        fs.renameSync(target, archivePathFor(target));
      } else {
        existing = read.text;
      }
    } else {
      existing = redactLogText(fs.readFileSync(target, "utf8"));
    }
  }
  replaceWithSealedLogSync(target, existing + extra, key);
  fs.unlinkSync(file);
  return target;
}

/**
 * Dev builds write plaintext logs (BACKLOG-3819, dc27e73c). A live log that an
 * earlier build sealed must not have plaintext appended behind its KEPRLOG
 * header — that would make everything after the header unreadable. Move it
 * aside as an archive (`main.sealed-<time>.old.log`): readers still decrypt it,
 * and it expires by mtime like any archive. Returns the new path, or null when
 * the file is missing or not sealed.
 */
export function setAsideSealedLiveLog(file: string, now: number = Date.now()): string | null {
  if (!isSealedLogFile(file)) return null;
  const p = path.parse(file);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const aside = path.join(p.dir, `${p.name}.sealed-${stamp}.old${p.ext}`);
  fs.renameSync(file, aside);
  return aside;
}

let resolveLogDirectory: (() => string) | null = null;

/** Called by the Electron shell: where electron-log writes its files. */
export function setLogDirectoryResolver(resolver: (() => string) | null): void {
  resolveLogDirectory = resolver;
}

/**
 * Run {@link runLogMaintenance} on the directory the shell registered. Returns
 * null when no directory was registered (non-Electron hosts, tests).
 */
export function runConfiguredLogMaintenance(
  now: number = Date.now(),
  opts: LogMaintenanceOptions = {},
): LogMaintenanceResult | null {
  if (!resolveLogDirectory) return null;
  return runLogMaintenance(resolveLogDirectory(), now, opts);
}

/** The directory the shell registered, or null (non-Electron hosts, tests). */
export function getConfiguredLogDirectory(): string | null {
  return resolveLogDirectory ? resolveLogDirectory() : null;
}
