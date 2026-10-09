/**
 * Decrypted copies for "open with the system viewer" (BACKLOG-3816 S2, R3).
 *
 * An external app (Preview, Word, Acrobat) can only open a plaintext file, so
 * `attachments:open` decrypts into `userData/at-rest-open/<runId>/<n>/<original name>`
 * and hands that path to shell.openPath. The copies are plaintext customer
 * content, so they do not outlive the run:
 *   - `clearOpenTempSync()` on will-quit removes the whole `at-rest-open` dir;
 *   - `clearOpenTemp()` at launch (handler registration) removes whatever a crash
 *     or a killed process left behind — unconditionally, not by age.
 * (S6's temp sweep also lists `at-rest-open`, but only removes entries > 24 h old.)
 *
 * Limit, stated: while the app runs, an opened copy stays on disk so the viewer
 * can keep reading it. Deleting it earlier would break viewers that re-read.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Same literal as S6's tempSweep AT_REST_OPEN_DIR. */
export const AT_REST_OPEN_DIR = "at-rest-open";

const RUN_ID = crypto.randomBytes(8).toString("hex");
let openCounter = 0;

export function openTempRoot(userData: string): string {
  return path.join(userData, AT_REST_OPEN_DIR);
}

/** Windows device names: reserved with or without an extension ("NUL.txt" opens the NUL device). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function cleanStem(n: string | null | undefined): string {
  return (
    path
      .basename((n ?? "").replace(/\\/g, "/"))
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f<>:"|?*]/g, "_")
      .replace(/^\.+/, "")
      // Windows drops trailing dots and spaces from a name, so "a. " is "a".
      .replace(/[. ]+$/, "")
      .trim()
  );
}

/**
 * A display-safe file name for a decrypted open-copy: no separators, no control
 * characters, no Windows device name, no trailing dot/space, bounded length.
 *
 * `storedExt` is the extension of the STORED file (what the writer chose); it
 * always wins over whatever extension the database name carries, so the viewer
 * opens the same type the file really is. The database name contributes only
 * its stem.
 */
export function safeOpenName(
  name: string | null | undefined,
  fallback: string,
  storedExt?: string,
): string {
  const forced = storedExt !== undefined;
  const ext = forced ? storedExt.replace(/[^A-Za-z0-9.]/g, "").replace(/^\.+/, "").slice(0, 20) : "";
  const extWithDot = ext ? `.${ext}` : "";
  const split = (n: string | null | undefined): { stem: string; own: string } => {
    const cleaned = cleanStem(n);
    const own = path.extname(cleaned);
    return { stem: own ? cleaned.slice(0, -own.length) : cleaned, own: own.slice(0, 20) };
  };
  const pick = split(name).stem ? split(name) : split(fallback);
  const useExt = forced ? extWithDot : pick.own;
  let stem = (pick.stem || "attachment").slice(0, Math.max(1, 150 - useExt.length));
  stem = stem.replace(/[. ]+$/, "") || "attachment";
  // "CON" and "con.tar" are devices on Windows: only the part before the first dot counts.
  if (WINDOWS_RESERVED.test(stem.split(".")[0])) stem = `_${stem}`;
  return `${stem}${useExt}`;
}

/** Destination for one decrypted copy. Each open gets its own sub-directory so names never collide. */
export async function nextOpenPath(userData: string, displayName: string): Promise<string> {
  const dir = path.join(openTempRoot(userData), RUN_ID, String(++openCounter));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, displayName);
}

/** Launch cleanup: remove every decrypted copy left by an earlier run. */
export async function clearOpenTemp(userData: string): Promise<void> {
  await fs.promises.rm(openTempRoot(userData), { recursive: true, force: true, maxRetries: 3 });
}

/** Quit cleanup: synchronous so it completes inside will-quit. Never throws. */
export function clearOpenTempSync(userData: string): void {
  try {
    fs.rmSync(openTempRoot(userData), { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a viewer may still hold a file open on Windows; next launch removes it */
  }
}
