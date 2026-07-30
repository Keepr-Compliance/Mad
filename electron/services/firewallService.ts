/**
 * Firewall Service
 *
 * Windows-only check for whether the running app already has an inbound
 * "Allow" firewall rule for its executable. Used by the Android pairing flow
 * (BACKLOG-2348) to decide whether to pre-warn the user before the local sync
 * server binds the LAN IP and triggers the Windows Defender Firewall prompt.
 *
 * The OS prompt fires only the FIRST time the executable binds a non-loopback
 * address; once the user clicks "Allow access", Windows persists a rule and
 * never prompts again. So we only need to explain the upcoming prompt when no
 * allow rule exists yet — otherwise the pre-warn is just noise.
 *
 * BACKLOG-2348
 */

import { execFile } from "child_process";
import { promisify } from "util";
import logService from "./logService";

const execFileAsync = promisify(execFile);
const LOG_TAG = "FirewallService";

export interface FirewallCheckResult {
  /**
   * True if an inbound Allow rule exists for the executable, OR the platform
   * has no Windows firewall prompt to warn about (non-Windows).
   */
  allowed: boolean;
  /** True only if the check ran and produced a definitive Windows answer. */
  checked: boolean;
}

/**
 * Runs the firewall query and resolves the raw stdout. Injectable so tests can
 * exercise the success/blocked/error branches deterministically without a live
 * Windows host.
 */
export type FirewallExec = (script: string, execPath: string) => Promise<string>;

const defaultExec: FirewallExec = async (script, execPath) => {
  // Pass the executable path via env (not string interpolation) to avoid any
  // command injection from the path (CodeQL: js/shell-command-injection).
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, KEEPR_FW_EXE: execPath },
    }
  );
  return stdout;
};

/**
 * Parse the single-word PowerShell output into an allowed flag.
 * Exported for testing.
 */
export function parseFirewallOutput(stdout: string): boolean {
  return stdout.trim().toUpperCase().includes("ALLOWED");
}

/**
 * Check whether the running executable has an inbound Allow firewall rule.
 *
 * Non-Windows platforms return `{ allowed: true, checked: false }` — there is
 * no Windows firewall prompt to pre-warn about (macOS's local-network
 * permission is handled separately and is out of scope for BACKLOG-2348).
 *
 * On any error/timeout the result is `{ allowed: false, checked: false }` so
 * the caller shows the pre-warn (safe default: explain once rather than let the
 * OS prompt appear with no context).
 *
 * The query filters firewall rules by program path (indexed → fast) and
 * compares Direction/Action/Enabled as enums in PowerShell, so it is
 * language-independent — unlike `netsh` text output, which is localized and
 * would break on non-English Windows.
 */
export async function checkInboundFirewallAllowed(opts?: {
  platform?: NodeJS.Platform;
  execPath?: string;
  /** Override the PowerShell runner (tests inject success/blocked/error). */
  exec?: FirewallExec;
}): Promise<FirewallCheckResult> {
  const platform = opts?.platform ?? process.platform;
  const execPath = opts?.execPath ?? process.execPath;
  const exec = opts?.exec ?? defaultExec;

  if (platform !== "win32") {
    return { allowed: true, checked: false };
  }

  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$exe=$env:KEEPR_FW_EXE;" +
    "$r=Get-NetFirewallApplicationFilter -Program $exe | " +
    "Get-NetFirewallRule | " +
    "Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' };" +
    "if ($r) { Write-Output 'ALLOWED' } else { Write-Output 'BLOCKED' }";

  try {
    const stdout = await exec(script, execPath);
    const allowed = parseFirewallOutput(stdout);
    logService.info(
      `[Firewall] Inbound allow rule for executable: ${allowed ? "present" : "absent"}`,
      LOG_TAG
    );
    return { allowed, checked: true };
  } catch (err) {
    logService.warn(
      `[Firewall] Check failed, defaulting to show pre-warn: ${
        err instanceof Error ? err.message : String(err)
      }`,
      LOG_TAG
    );
    return { allowed: false, checked: false };
  }
}
