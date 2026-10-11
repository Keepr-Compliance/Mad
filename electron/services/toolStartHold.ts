/**
 * BACKLOG-3814: an iPhone tool held at start by the computer's security software.
 *
 * On the signed 2.40.0-rc.1 on Windows, a file scanner held idevicebackup2 on its
 * first run after an update. The PC's diagnostic log of the failed run:
 *
 *   20:19:47.167 [BackupService] Starting backup with args: [   <- just before spawn()
 *   20:20:03.768 Watchdog started (no-progress timeout: 1800s)  <- the line after spawn() returns
 *   20:20:04     first idevicebackup2 stderr
 *   20:20:08     version exchange failed, error -5 -> exit 4294967295 -> SERVICE_UNAVAILABLE
 *
 * `spawn()` itself did not return for ~16.6 s, so the start delay is measured from
 * just BEFORE `spawn()` is called. Measured from its return, this run reads as ~0.4 s.
 * A manual Try Again 16 s later succeeded.
 *
 * Why the phone's backup service then refuses the version exchange is NOT traced.
 *
 * Nothing here decides anything on its own: `backupService` records what it observed
 * and `deviceSyncOrchestrator` decides whether to try once more.
 */
import { promises as fs } from "fs";
import { app } from "electron";
import log from "electron-log";
import type { BackupResult } from "../types/backup";

/**
 * A start this slow is treated as "held by the system". Normal runs print their
 * first `-d` line within milliseconds; the observed hold was 16.6 s.
 */
export const TOOL_START_DELAYED_MS = 10_000;

/** With no output at all after this long, the user is told what is probably happening. */
export const TOOL_START_NOTICE_MS = 8_000;

/** Wait before the single automatic retry. A manual retry 16 s after the failure worked. */
export const TOOL_HOLD_RETRY_DELAY_MS = 10_000;

export const TOOL_START_HOLD_STATUS_MESSAGE =
  "Your antivirus may be checking Keepr's iPhone tools — this can take a minute on the first sync.";

export const TOOL_START_HOLD_FAILED_MESSAGE =
  "Your antivirus may be checking Keepr's iPhone tools. Wait a minute, then select Try Again.";

/** `<userData>/idevice-tool-runs.json`: `{ "<tool>": "<app version of its last run>" }`. */
export const IDEVICE_TOOL_RUNS_FILE = "idevice-tool-runs.json";

/** The running app's version, or null when it cannot be read. */
export function currentAppVersion(): string | null {
  try {
    if (typeof app?.getVersion !== "function") return null;
    const v = app.getVersion();
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * True only when the record is ABSENT or names a different version for `tool`.
 * An unreadable or unparseable record answers false: it cannot show this is a
 * first run, and a false "first run" would permit a retry the 2913 rule forbids.
 */
export async function isFirstToolRunForVersion(
  file: string,
  tool: string,
  version: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    return !!(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as Record<string, unknown>)[tool] !== version;
  } catch {
    return false;
  }
}

/** Records that `tool` has run under `version`. Never throws. */
export async function recordToolRunForVersion(
  file: string,
  tool: string,
  version: string,
): Promise<void> {
  try {
    let record: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
    } catch {
      // absent or unreadable: start a new record
    }
    record[tool] = version;
    await fs.writeFile(file, JSON.stringify(record), "utf8");
  } catch (error) {
    log.warn("[Backup] Could not record the tool's run for this version", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Counts only. */
export function logToolStartDelay(tool: string, delayMs: number): void {
  log.warn(`[Backup] tool start delayed ${delayMs}ms (possible antivirus scan)`, { tool });
}

/**
 * The single automatic retry is allowed only for the service-unavailable class AND a
 * held start (or the tool's first run under this app version). A plain service-unavailable
 * failure is NOT retried: BACKLOG-2913 found that quick repeated retries are what leave
 * the phone's backup service in that state.
 */
export function shouldRetryAfterToolStartHold(result: BackupResult): boolean {
  if (result.success) return false;
  if (result.errorCode !== "SERVICE_UNAVAILABLE") return false;
  const start = result.toolStart;
  if (!start) return false;
  return start.delayed || start.firstRunThisVersion;
}
