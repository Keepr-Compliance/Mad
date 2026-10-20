/**
 * BACKLOG-4002: is every thread of the running idevicebackup2 suspended? (Windows only)
 *
 * Security software can hold the backup tool by suspending every one of its threads.
 * The tool then prints nothing and the 30-minute no-progress watchdog is the only thing
 * that ends it. This module asks Windows for the tool's thread states so the sync screen
 * can say so within a few minutes instead.
 *
 * ## The discriminator
 *
 * A real device wait ALSO has every thread waiting (blocked on a socket or a timer).
 * What differs is the wait REASON: only SuspendThread / NtSuspendProcess on every thread
 * gives `WaitReason = Suspended`. So the rule is `threads > 0 AND suspended == threads`,
 * where "suspended" means ThreadState Wait AND WaitReason Suspended. ThreadState Wait on
 * its own means nothing.
 *
 * Measured on the founder's Windows 11 PC (BACKLOG-4002 pm_comments 45a0d9b5), with the
 * script this module ships minus the process-name check added after (SR R2):
 * - a running `ping -t`: `T=6 S=0` (5 of 5), 331-375 ms per call
 * - the same process under NtSuspendProcess: `T=6 S=6` (5 of 5)
 * - after Stop-Process: `GONE`
 * - a real 20-minute device wait of idevicebackup2: S=0 in all 40 samples, every thread
 *   waiting (UserRequest / EventPairLow / ExecutionDelay).
 *
 * ## Every failure is UNKNOWN, never suspended
 *
 * - powershell.exe blocked at launch (spawn throws EPERM / UNKNOWN, or exits non-zero)
 * - powershell.exe itself suspended by security software: the 10 s execFile timeout
 *   kills it (TerminateProcess, which ends a suspended process — BACKLOG-3996 step 2)
 * - a slow cold start above 10 s: the same timeout
 * - ConstrainedLanguage / AppLocker refusing a cmdlet: the error text does not parse
 * - any output that is not exactly `T=<n> S=<n>` or `GONE`
 *
 * The caller (BackupService) stops probing for the run after three unknowns in a row.
 *
 * Main process only. Never `-EncodedCommand` (encoded PowerShell is itself a heuristic
 * security software flags). The script has no double quotes, so Windows PowerShell 5.1
 * argument passing cannot alter it, and the only value put into it is an integer pid.
 */
import { execFile } from "child_process";
import { powershellPath } from "./appleInstallerSignature";

/** One reading of the tool's threads. */
export type ThreadStateSample =
  | { kind: "sampled"; threads: number; suspended: number }
  | { kind: "gone" }
  | { kind: "unknown"; reason: string };

/** Reads the thread states of one pid. Injectable on BackupService (a test seam). */
export type ThreadStateProbe = (pid: number) => Promise<ThreadStateSample>;

/** How long one probe may take before it is killed and read as unknown. */
export const THREAD_STATE_PROBE_TIMEOUT_MS = 10_000;

/** The process name the probe expects at the pid. A reused pid reads as GONE (SR R2). */
export const PROBED_TOOL_PROCESS_NAME = "idevicebackup2";

/**
 * The PowerShell script for `pid`, or null when `pid` is not a positive integer.
 *
 * `-and` short-circuits, and the order matters: ProcessThread.WaitReason throws when
 * ThreadState is not Wait.
 */
export function buildThreadStateScript(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return (
    "$ErrorActionPreference='Stop'; " +
    `try { $p = Get-Process -Id ${pid} } catch { 'GONE'; exit 0 }; ` +
    `if ($p.ProcessName -ne '${PROBED_TOOL_PROCESS_NAME}') { 'GONE'; exit 0 }; ` +
    "$t = @($p.Threads); " +
    "$s = @($t | Where-Object { $_.ThreadState -eq 'Wait' -and $_.WaitReason -eq 'Suspended' }).Count; " +
    "'T=' + $t.Count + ' S=' + $s; exit 0"
  );
}

/**
 * Parse the script's stdout. powershell.exe ends its output with CRLF, so the text is
 * trimmed first (SR R1): without the trim every real sample would read as unknown and
 * the notice could never show, with nothing going red.
 */
export function parseThreadStateOutput(stdout: string): ThreadStateSample {
  const text = String(stdout).trim();
  if (text === "GONE") return { kind: "gone" };
  const m = /^T=(\d+) S=(\d+)$/.exec(text);
  if (!m) return { kind: "unknown", reason: "unparseable" };
  return { kind: "sampled", threads: Number(m[1]), suspended: Number(m[2]) };
}

/** True only when the tool has threads and every one of them is suspended. */
export function isAllSuspended(sample: ThreadStateSample): boolean {
  return sample.kind === "sampled" && sample.threads > 0 && sample.suspended === sample.threads;
}

/** Ask Windows for the thread states of `pid`. Never rejects. */
export function probeToolThreadState(pid: number): Promise<ThreadStateSample> {
  const script = buildThreadStateScript(pid);
  if (script === null) return Promise.resolve({ kind: "unknown", reason: "invalid-pid" });
  return new Promise((resolve) => {
    try {
      execFile(
        powershellPath(),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: THREAD_STATE_PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            const e = error as { killed?: boolean; code?: unknown };
            resolve({ kind: "unknown", reason: e.killed ? "timeout" : `exit:${String(e.code ?? "error")}` });
            return;
          }
          resolve(parseThreadStateOutput(String(stdout)));
        },
      );
    } catch (spawnError) {
      const code = (spawnError as { code?: unknown } | null)?.code;
      resolve({ kind: "unknown", reason: `spawn:${String(code ?? "error")}` });
    }
  });
}
