/**
 * BACKLOG-3943 — an in-process stand-in for the OCR page child, so the crash, timeout,
 * overflow and page-cap controls run without spawning anything (SR plan review R8: only
 * the KEEPR_OCR_PROOF suite starts a real child).
 *
 * The output it emits is the real child's wire format (visionOcrScript.ts), the shape
 * captured from /usr/bin/osascript runs on this build's fixture (see fixtures/README.md).
 */
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import type { ChildProcess, SpawnOptions } from "child_process";
import type { OcrSpawner } from "../ocrChild";

export type FakeBehaviour =
  /** exit 0 with a DOC line and, when the page exists, a PAGE block of these lines */
  | { kind: "page"; pagesTotal: number; lines: string[] }
  /** die by a signal after optionally streaming the DOC line first */
  | { kind: "crash"; signal: NodeJS.Signals; pagesTotal?: number }
  /** exit non-zero with this stderr */
  | { kind: "exit"; code: number; stderr?: string }
  /** never exit until killed */
  | { kind: "hang" }
  /** write this many bytes of stdout, then exit 0 */
  | { kind: "flood"; bytes: number }
  /** wait for `release` before emitting the page (to change the DB mid-run) */
  | { kind: "gated"; release: Promise<void>; pagesTotal: number; lines: string[] };

export interface FakeCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  page: number;
  stdinBytes: number;
  killedWith: NodeJS.Signals | null;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  private closed = false;

  constructor(private readonly call: FakeCall, onStdin: (n: number) => void) {
    super();
    const chunks: Buffer[] = [];
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
      final(cb) {
        onStdin(Buffer.concat(chunks).length);
        cb();
      },
    });
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.call.killedWith = signal;
    this.close(null, signal);
    return true;
  }
}

function pageText(pagesTotal: number, page: number, lines: string[]): string {
  let s = `\u0001DOC pages=${pagesTotal}\n`;
  if (page < pagesTotal) s += `\u0001PAGE ${page + 1} ms=1 lines=${lines.length} held=4\n${lines.join("\n")}\n\u0002\n`;
  return s;
}

/**
 * A spawner that answers each call with the behaviour `plan(page, attemptForThatPage)`
 * returns. Records every call.
 */
export function makeFakeSpawner(plan: (page: number, attempt: number) => FakeBehaviour): {
  spawner: OcrSpawner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const attempts = new Map<number, number>();
  const spawner: OcrSpawner = (command, args, options) => {
    const page = Number.parseInt(args[args.length - 2], 10);
    const attempt = (attempts.get(page) ?? 0) + 1;
    attempts.set(page, attempt);
    const call: FakeCall = { command, args, options, page, stdinBytes: -1, killedWith: null };
    calls.push(call);
    const child = new FakeChild(call, (n) => {
      call.stdinBytes = n;
    });
    const b = plan(page, attempt);
    setImmediate(() => {
      switch (b.kind) {
        case "page":
          child.stdout.write(pageText(b.pagesTotal, page, b.lines));
          child.close(0, null);
          break;
        case "crash":
          if (b.pagesTotal !== undefined) child.stdout.write(`\u0001DOC pages=${b.pagesTotal}\n`);
          child.close(null, b.signal);
          break;
        case "exit":
          if (b.stderr) child.stderr.write(b.stderr);
          child.close(b.code, null);
          break;
        case "hang":
          break;
        case "flood":
          child.stdout.write(Buffer.alloc(b.bytes, 0x41));
          setImmediate(() => child.close(0, null));
          break;
        case "gated":
          void b.release.then(() => {
            child.stdout.write(pageText(b.pagesTotal, page, b.lines));
            child.close(0, null);
          });
          break;
      }
    });
    return child as unknown as ChildProcess;
  };
  return { spawner, calls };
}
