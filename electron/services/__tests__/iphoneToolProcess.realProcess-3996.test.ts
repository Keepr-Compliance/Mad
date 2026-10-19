/**
 * BACKLOG-3996: the kill against a REAL stopped process (macOS / Linux only).
 *
 * The plan's probe P1 as a test: a child that is SIGSTOPped ignores SIGTERM and reads
 * `killed === true` while alive; killIphoneToolTree must still end it. Windows cannot
 * be run here — whether TerminateProcess ends a process held by security software is a
 * check on the PC retest, not something this suite proves.
 */
import { spawn, type ChildProcess } from "child_process";

jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn() }));

import { killIphoneToolTree, hasExited, __resetIphoneToolProcessForTests } from "../iphoneToolProcess";

const posix = process.platform !== "win32";
const maybe = posix ? describe : describe.skip;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasExited(proc)) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

maybe("BACKLOG-3996 real process (POSIX)", () => {
  beforeEach(() => __resetIphoneToolProcessForTests());

  it("a SIGSTOPped child: SIGTERM leaves it alive with killed=true; killIphoneToolTree ends it", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    process.kill(pid, "SIGSTOP");

    // The trap the old code fell into, measured here so the test fails if Node changes.
    child.kill("SIGTERM");
    expect(child.killed).toBe(true);
    expect(await waitForExit(child, 500)).toBe(false);
    expect(isAlive(pid)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    killIphoneToolTree(child, { tool: "ideviceinfo", reason: "timeout" });
    expect(await waitForExit(child, 3000)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    expect(isAlive(pid)).toBe(false);
  });
});
