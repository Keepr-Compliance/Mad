/**
 * BACKLOG-3943 — run ONE page of OCR in a child process.
 *
 * The boundary is deliberately small: document bytes in, one page's recognised lines out
 * (founder ruling 7). Today the child is /usr/bin/osascript running the JXA source in
 * visionOcrScript.ts (Apple Vision, accurate level). A signed helper can replace it later
 * behind this same function.
 *
 * Why one child per page: a long single osascript process crashed in the JXA bridge on
 * long documents (reproduced by the plan and the SR review); one-page children ran clean
 * 84/84. A crash then costs one page, which the caller retries once.
 *
 * Process safety:
 *   - args array, no shell; the only argv entries are the script and four integers. No
 *     path ever reaches the child, and nothing is written to disk: the decrypted bytes go
 *     to the child's stdin.
 *   - env is PATH only. No TTY.
 *   - per-page timeout and stdout cap; both end the child with SIGKILL.
 *   - stopLiveOcrChild() ends the running child (app quit).
 *   - stdout is document text and is NEVER logged. stderr is read only to classify an
 *     unreadable input; it is not logged either.
 *
 * Platforms: macOS only in this build. Windows (Windows.Media.Ocr through PowerShell) is a
 * later PR; isOcrSupportedPlatform() is false there, so no row is ever marked by a missing
 * engine — it simply stays OCR-pending until a Windows engine ships.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { hasExited } from "../iphoneToolProcess";
import { VISION_OCR_SCRIPT, VISION_UNREADABLE_MESSAGE } from "./visionOcrScript";

export const OSASCRIPT_PATH = "/usr/bin/osascript";

/** The engine recorded in analysis_metadata. */
export const OCR_ENGINE = "apple-vision";

export function isOcrSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export interface OcrPageOptions {
  dpi: number;
  maxLongEdgePx: number;
  timeoutMs: number;
  maxStdoutBytes: number;
}

/**
 * Why a page produced no result:
 *   - "timeout"    the child ran past timeoutMs and was stopped
 *   - "signal"     the child died by a signal (a crash: SIGSEGV, SIGTRAP, ...)
 *   - "exit"       non-zero exit, or exit 0 without the expected output
 *   - "overflow"   stdout passed maxStdoutBytes; the child was stopped
 *   - "spawn"      the child could not be started
 *   - "unreadable" the bytes are neither a PDF nor an image (permanent)
 *   - "stopped"    stopLiveOcrChild() ended it (app quit)
 */
export type OcrPageFailure =
  | "timeout"
  | "signal"
  | "exit"
  | "overflow"
  | "spawn"
  | "unreadable"
  | "stopped";

export type OcrPageResult =
  | { ok: true; pagesTotal: number; lines: string[]; ms: number }
  | { ok: false; failure: OcrPageFailure; pagesTotal: number | null; ms: number };

export type OcrSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

let spawner: OcrSpawner = spawn as unknown as OcrSpawner;

/** TEST-ONLY: replace the spawner (pass null to restore child_process.spawn). */
export function __setOcrSpawnerForTests(fn: OcrSpawner | null): void {
  spawner = fn ?? (spawn as unknown as OcrSpawner);
}

/** The arguments a page child is started with. Exported so tests can assert on them. */
export function buildOcrArgs(pageIndex: number, opts: OcrPageOptions): string[] {
  return [
    "-l",
    "JavaScript",
    "-e",
    VISION_OCR_SCRIPT,
    String(opts.dpi),
    String(opts.maxLongEdgePx),
    String(pageIndex),
    String(pageIndex + 1),
  ];
}

const DOC_PREFIX = "\u0001DOC pages=";
const PAGE_PREFIX = "\u0001PAGE ";
const PAGE_END = "\u0002";

/**
 * Parse the child's stdout. Returns the page count from the DOC line (null when absent)
 * and the recognised lines of the first PAGE block (null when no complete block exists).
 * No RegExp.exec: plain string operations only.
 */
export function parseOcrOutput(stdout: string): { pagesTotal: number | null; lines: string[] | null } {
  const all = stdout.split("\n");
  let pagesTotal: number | null = null;
  let lines: string[] | null = null;
  let inPage = false;
  let current: string[] = [];
  for (const line of all) {
    if (line.startsWith(DOC_PREFIX)) {
      const n = Number.parseInt(line.slice(DOC_PREFIX.length), 10);
      if (Number.isFinite(n) && n >= 0) pagesTotal = n;
      continue;
    }
    if (line.startsWith(PAGE_PREFIX)) {
      inPage = true;
      current = [];
      continue;
    }
    if (inPage && line === PAGE_END) {
      if (lines === null) lines = current;
      inPage = false;
      continue;
    }
    if (inPage) current.push(line);
  }
  return { pagesTotal, lines };
}

// ── The live child (one at a time; the queue runs one job) ────────────────────

let liveChild: ChildProcess | null = null;
let liveStopRequested = false;

/**
 * Stop the running page child, if any (app quit). SIGKILL: the child holds no state worth
 * a graceful exit. Returns true when a child was signalled.
 */
export function stopLiveOcrChild(): boolean {
  const child = liveChild;
  if (!child || hasExited(child)) return false;
  liveStopRequested = true;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * OCR one page (0-based) of `buffer`. Never throws; every failure is a result.
 */
export function runOcrPage(
  buffer: Buffer,
  pageIndex: number,
  opts: OcrPageOptions,
): Promise<OcrPageResult> {
  const startedAt = Date.now();
  return new Promise<OcrPageResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawner(OSASCRIPT_PATH, buildOcrArgs(pageIndex, opts), {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, failure: "spawn", pagesTotal: null, ms: Date.now() - startedAt });
      return;
    }
    liveChild = child;
    liveStopRequested = false;

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";
    let timedOut = false;
    let overflowed = false;
    let settled = false;

    const finish = (result: OcrPageResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (liveChild === child) liveChild = null;
      resolve(result);
    };

    const killNow = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killNow();
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxStdoutBytes) {
        if (!overflowed) {
          overflowed = true;
          killNow();
        }
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: only needed to recognise the unreadable-input message.
      if (stderrText.length < 4096) stderrText += chunk.toString("utf8");
    });

    child.on("error", () => {
      finish({ ok: false, failure: "spawn", pagesTotal: null, ms: Date.now() - startedAt });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const ms = Date.now() - startedAt;
      const parsed = parseOcrOutput(Buffer.concat(chunks).toString("utf8"));
      const fail = (failure: OcrPageFailure): void =>
        finish({ ok: false, failure, pagesTotal: parsed.pagesTotal, ms });
      if (liveStopRequested && liveChild === child) return fail("stopped");
      if (timedOut) return fail("timeout");
      if (overflowed) return fail("overflow");
      if (signal) return fail("signal");
      if (code !== 0) {
        return fail(stderrText.includes(VISION_UNREADABLE_MESSAGE) ? "unreadable" : "exit");
      }
      if (parsed.pagesTotal === null) return fail("exit");
      // A page index past the end of the document yields a DOC line and no PAGE block.
      if (parsed.lines === null && pageIndex < parsed.pagesTotal) return fail("exit");
      finish({ ok: true, pagesTotal: parsed.pagesTotal, lines: parsed.lines ?? [], ms });
    });

    // The child may die before reading stdin (EPIPE); that surfaces through 'close'.
    child.stdin?.on("error", () => {
      /* reported via close */
    });
    child.stdin?.end(buffer);
  });
}
