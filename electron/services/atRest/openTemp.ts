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

/** A display-safe file name: no separators, no control characters, bounded length. */
export function safeOpenName(name: string | null | undefined, fallback: string): string {
  const pick = (n: string | null | undefined) =>
    (path.basename((n ?? "").replace(/\\/g, "/")))
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f<>:"|?*]/g, "_")
      .replace(/^\.+/, "")
      .trim();
  let out = pick(name) || pick(fallback) || "attachment";
  if (out.length > 150) {
    const ext = path.extname(out).slice(0, 20);
    out = out.slice(0, 150 - ext.length) + ext;
  }
  return out;
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
