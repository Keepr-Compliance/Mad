/**
 * BACKLOG-3953: did security software keep an iPhone tool from starting? (Windows only)
 *
 * THE RULE: only a tool that NEVER STARTED counts. Every harmless look-alike — no phone,
 * Apple Mobile Device Support not answering, a locked phone, Trust not tapped — needs
 * the tool to run and print something, so a tool that never started cannot be one of
 * them. Two signals qualify:
 *
 *   1. A required file is missing (or empty) from a tools folder that exists.
 *   2. Windows refused to launch the file: spawn failed with EPERM, EACCES or UNKNOWN.
 *
 * What does NOT count, on purpose:
 *   - any non-zero exit or signal after a normal start, however fast. A security tool
 *     killing a process after it started is MECHANISM UNTRACED, and an early exit
 *     overlaps "ERROR: Unable to retrieve device list!" (exit -1).
 *   - the Windows "DLL not found" exit status on its own. It counts only with a stat
 *     miss on a required file.
 *   - spawn ENOENT with every file present (nothing to name), and EMFILE / ENFILE /
 *     EAGAIN (this computer is out of handles or processes, not blocked).
 *   - a tools folder that is absent altogether: a broken install, which keeps the
 *     existing tools-missing path.
 *
 * Error shapes (Node 22, which Electron 38 ships). NOT run on Windows; from source:
 *   - libuv src/win/error.c: ERROR_FILE_NOT_FOUND -> UV_ENOENT, ERROR_ACCESS_DENIED ->
 *     UV_EPERM, ERROR_ELEVATION_REQUIRED -> UV_EACCES, anything unmapped (including
 *     ERROR_VIRUS_INFECTED 225 and ERROR_VIRUS_DELETED 226) -> UV_UNKNOWN.
 *   - Node lib/internal/child_process.js (ChildProcess.prototype.spawn): EACCES, EAGAIN,
 *     EMFILE, ENFILE and ENOENT are emitted as an async 'error' event; every other code
 *     is THROWN from spawn() as ErrnoException(err, 'spawn') ("spawn EPERM").
 *   - STATUS_DLL_NOT_FOUND is 0xC0000135: 3221225781 unsigned, -1073741515 signed. Which
 *     form Node reports on Windows is unverified, so both are accepted.
 *
 * Every function here returns null rather than throwing: it runs on failure paths that
 * already have a result to deliver.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import {
  getLibimobiledevicePath,
  REQUIRED_IPHONE_TOOL_FILES,
  REQUIRED_IPHONE_TOOL_DLLS,
} from "./libimobiledeviceService";
import type { ToolBlock, ToolBlockKind } from "../types/backup";

/** Windows STATUS_DLL_NOT_FOUND, in both the unsigned and the signed 32-bit form. */
export const DLL_NOT_FOUND_EXIT_CODES: readonly number[] = [3221225781, -1073741515];

/** Spawn error codes that mean Windows refused to start the file. */
const REFUSED_SPAWN_CODES: Readonly<Record<string, ToolBlockKind>> = {
  EPERM: "spawn-eperm",
  EACCES: "spawn-eacces",
  UNKNOWN: "spawn-unknown",
};

export interface ToolFileCheck {
  folder: string;
  /** Required file names that are absent or zero bytes. */
  missing: string[];
}

/**
 * Stat every required file. Returns null off Windows, when the tools folder itself is
 * absent (a broken install — not a block), or on any error.
 */
export function findMissingToolFiles(): ToolFileCheck | null {
  if (process.platform !== "win32") return null;
  try {
    const folder = getLibimobiledevicePath();
    if (!fs.existsSync(folder)) return null;
    const missing: string[] = [];
    for (const name of REQUIRED_IPHONE_TOOL_FILES) {
      try {
        const stat = fs.statSync(path.join(folder, name));
        if (!stat.isFile() || stat.size === 0) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
    return { folder, missing };
  } catch (error) {
    log.warn("[iphoneToolBlock] Tool file check failed:", error);
    return null;
  }
}

let reportedThisSession = false;

/**
 * One Sentry event per app session, however many polls or syncs see the block.
 * main.log gets every occurrence.
 */
export function reportToolBlockedOnce(block: ToolBlock): void {
  log.warn("[iphoneToolBlock] iPhone tool blocked", block);
  if (reportedThisSession) return;
  reportedThisSession = true;
  try {
    Sentry.captureMessage("iPhone tool blocked by security software", {
      level: "warning",
      tags: {
        component: "libimobiledevice",
        iphone_tool_block: block.kind,
        tool: block.tool,
      },
      extra: {
        missingFiles: block.missingFiles,
        spawnCode: block.spawnCode,
        exitCode: block.exitCode,
      },
    });
  } catch {
    // Telemetry never fails the caller.
  }
}

/** Test seam: the per-session flag is module state. */
export function __resetToolBlockReportForTests(): void {
  reportedThisSession = false;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Pre-flight: is any required file missing? Used before a sync and before the
 * availability probe, so a removed file is named instead of read as "no tools".
 */
export function checkToolFilesForBlock(tool: string): ToolBlock | null {
  const check = findMissingToolFiles();
  if (!check || check.missing.length === 0) return null;
  const block: ToolBlock = { kind: "file-missing", tool, missingFiles: check.missing };
  reportToolBlockedOnce(block);
  return block;
}

/**
 * Classify a failed launch. Pass the spawn error (thrown or emitted) or, for a process
 * that ran, its exit code. Returns a block only for the never-started signals above.
 */
export function detectToolBlock(
  tool: string,
  failure: { error?: unknown; exitCode?: number | null },
): ToolBlock | null {
  try {
    let block: ToolBlock | null = null;
    if (failure.error !== undefined && failure.error !== null) {
      const code = errorCode(failure.error);
      const refused = code ? REFUSED_SPAWN_CODES[code] : undefined;
      if (!refused && code !== "ENOENT") return null;
      const check = findMissingToolFiles();
      if (!check) return null;
      if (check.missing.length > 0) {
        block = { kind: "file-missing", tool, missingFiles: check.missing, spawnCode: code };
      } else if (refused) {
        block = { kind: refused, tool, missingFiles: [], spawnCode: code };
      } else {
        log.warn(`[iphoneToolBlock] ${tool}: spawn ENOENT but every required file is present`);
        return null;
      }
    } else if (
      typeof failure.exitCode === "number" &&
      DLL_NOT_FOUND_EXIT_CODES.includes(failure.exitCode)
    ) {
      const check = findMissingToolFiles();
      if (!check) return null;
      const dlls = new Set<string>(REQUIRED_IPHONE_TOOL_DLLS);
      const missingDlls = check.missing.filter((name) => dlls.has(name));
      if (missingDlls.length === 0) return null;
      block = { kind: "dll-missing", tool, missingFiles: check.missing, exitCode: failure.exitCode };
    }
    if (block) reportToolBlockedOnce(block);
    return block;
  } catch (error) {
    log.warn("[iphoneToolBlock] Block detection failed:", error);
    return null;
  }
}

/** The folder a user adds as an exception: the install folder of a packaged build. */
export function keeprInstallFolder(): string | null {
  try {
    if (!app?.isPackaged || !process.resourcesPath) return null;
    return path.dirname(process.resourcesPath);
  } catch {
    return null;
  }
}
