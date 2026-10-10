/**
 * BACKLOG-3816: the last measured size of each phone's kept iPhone backup.
 *
 * Measuring a backup means one `stat` per file. A 576k-file backup took ~135 s on the
 * founder's PC, and every sync did it twice: in the pre-flight (checkBackupStatus) and
 * again after the backup. Between two syncs nothing changes the backup's size except
 * the seal (a few bytes of header per file), so the pre-flight uses the figure the
 * previous measurement recorded and walks only when there is none.
 *
 * Stored as `<userData>/backup-sizes.json`, one entry per phone, keyed by a SHA-256 of
 * the UDID (never the UDID itself): `{ "<key>": { "bytes": n, "recordedAt": ms } }`.
 * A missing, unreadable or malformed file, or a malformed entry, reads as "no record",
 * which makes the caller measure. Writes are best-effort and atomic (temp + rename).
 */
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import log from "electron-log";

export const BACKUP_SIZE_RECORD_FILE = "backup-sizes.json";

interface Entry {
  bytes: number;
  recordedAt: number;
}

export function backupSizeRecordKey(udid: string): string {
  return crypto.createHash("sha256").update(udid).digest("hex").slice(0, 32);
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.bytes === "number" &&
    Number.isFinite(e.bytes) &&
    e.bytes > 0 &&
    typeof e.recordedAt === "number" &&
    Number.isFinite(e.recordedAt)
  );
}

async function readAll(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") log.warn("[BackupSizeRecord] could not read the record; measuring instead", { code });
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  log.warn("[BackupSizeRecord] the record is not valid JSON; measuring instead");
  return {};
}

async function writeAll(file: string, all: Record<string, unknown>): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(all), "utf8");
    await fs.rename(tmp, file);
  } catch (error) {
    log.warn("[BackupSizeRecord] could not write the record", { code: (error as NodeJS.ErrnoException)?.code });
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// Writes are serialised so two updates cannot interleave read-modify-write.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** The recorded size in bytes, or null when there is no usable record. */
export async function readRecordedBackupSize(file: string, udid: string): Promise<number | null> {
  const all = await readAll(file);
  const entry = all[backupSizeRecordKey(udid)];
  return validEntry(entry) ? entry.bytes : null;
}

export function recordBackupSize(file: string, udid: string, bytes: number, now: number = Date.now()): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return forgetBackupSize(file, udid);
  return serial(async () => {
    const all = await readAll(file);
    all[backupSizeRecordKey(udid)] = { bytes: Math.round(bytes), recordedAt: now };
    await writeAll(file, all);
  });
}

export function forgetBackupSize(file: string, udid: string): Promise<void> {
  return serial(async () => {
    const all = await readAll(file);
    const key = backupSizeRecordKey(udid);
    if (!(key in all)) return;
    delete all[key];
    await writeAll(file, all);
  });
}
