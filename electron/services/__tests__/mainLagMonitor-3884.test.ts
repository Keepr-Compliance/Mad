/**
 * @jest-environment node
 *
 * BACKLOG-3884 follow-up — main-process event-loop lag log.
 *
 * The first two tests run the REAL timer against a REAL synchronous block of
 * the test's own thread: a 1300 ms busy-wait must produce exactly one line, a
 * 200 ms busy-wait none. (A drift timer under-reads a block by up to one
 * interval, so 1000-1100 ms is deliberately not used with real timers; the
 * exact 999/1000 boundary is pinned with an injected clock below.)
 */
import { performance } from "perf_hooks";
import {
  createMainLagMonitor,
  MAIN_LAG_THRESHOLD_MS,
  type MainLagContext,
  type MainLagMonitor,
} from "../mainLagMonitor";
import {
  ipcActivitySnapshot,
  resetIpcActivityForTests,
  wrapHandleForReplySize,
  type HandleTarget,
} from "../ipcReplySize";

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // block the event loop
  }
}

function waitReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const noIpc: MainLagContext = { lastChannel: null, lastStartedAt: 0, inFlight: [], syncPhase: null };

describe("BACKLOG-3884: [MainLag] on a real synchronous block", () => {
  let monitor: MainLagMonitor | null = null;
  afterEach(() => {
    monitor?.stop();
    monitor = null;
    resetIpcActivityForTests();
  });

  function startReal(lines: string[]): void {
    monitor = createMainLagMonitor({
      now: () => performance.now(),
      log: (line) => lines.push(line),
      context: () => ({ ...ipcActivitySnapshot(), syncPhase: null }),
    });
    monitor.start();
  }

  it("logs exactly one line for a 1300 ms block, naming the IPC channel that was running", async () => {
    // A real wrapped handler that blocks main synchronously, as a slow SQL
    // handler does. The tracker records its channel at start.
    const registered = new Map<string, (e: unknown) => unknown>();
    const target: HandleTarget = { handle: (c, l) => void registered.set(c, l) };
    wrapHandleForReplySize(target, { phase: () => null, now: () => performance.now(), log: () => {} });
    target.handle("transactions:get-overview", () => {
      busyWait(1300);
      return { ok: true };
    });

    const lines: string[] = [];
    startReal(lines);
    await waitReal(150); // let the timer establish a baseline tick
    await registered.get("transactions:get-overview")!({});
    await waitReal(300); // let the late tick fire

    expect(lines).toHaveLength(1);
    const m = lines[0].match(
      /^\[MainLag\] durationMs=(\d+) sinceLastIpc=transactions:get-overview lastIpcAgoMs=\d+ inFlight=\S+ syncPhase=none$/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(MAIN_LAG_THRESHOLD_MS);
  });

  it("stays silent for a 200 ms block", async () => {
    const lines: string[] = [];
    startReal(lines);
    await waitReal(150);
    busyWait(200);
    await waitReal(300);
    expect(lines).toEqual([]);
  });
});

describe("BACKLOG-3884: [MainLag] threshold, rate limit and context (injected clock)", () => {
  function setup(context: () => MainLagContext = () => noIpc) {
    let t = 0;
    const lines: string[] = [];
    const monitor = createMainLagMonitor({
      now: () => t,
      log: (line) => lines.push(line),
      context,
      intervalMs: 100,
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    monitor.start(); // baseline at t=0
    const advance = (ms: number) => {
      t += ms;
      monitor.tick();
    };
    return { lines, advance, monitor };
  }

  it("is silent at 999 ms of lag", () => {
    const { lines, advance } = setup();
    advance(100 + 999);
    expect(lines).toEqual([]);
  });

  it("logs at exactly 1000 ms of lag", () => {
    const { lines, advance } = setup();
    advance(100 + 1000);
    expect(lines).toEqual([
      "[MainLag] durationMs=1000 sinceLastIpc=none lastIpcAgoMs=none inFlight=none syncPhase=none",
    ]);
  });

  it("rate-limits to one line per 5 s and counts what it skipped", () => {
    const { lines, advance } = setup();
    advance(1100); // logs
    advance(1100); // within 5 s -> suppressed
    advance(1100); // suppressed
    advance(100);
    advance(3000); // 6400 ms after the first line, lag 2900 -> logs with suppressed=2
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/ suppressed=2$/);
  });

  it("carries the last IPC channel, how long ago it started, in-flight handlers and the sync phase", () => {
    const { lines, advance } = setup(() => ({
      lastChannel: "transactions:sync-review-queue",
      lastStartedAt: 300,
      inFlight: ["transactions:sync-review-queue", "contacts:get-allx2"],
      syncPhase: "messages",
    }));
    advance(2000);
    expect(lines).toEqual([
      "[MainLag] durationMs=1900 sinceLastIpc=transactions:sync-review-queue lastIpcAgoMs=1700" +
        " inFlight=transactions:sync-review-queue,contacts:get-allx2 syncPhase=messages",
    ]);
  });

  it("a reset baseline (sleep/resume) does not report the gap", () => {
    const { lines, advance, monitor } = setup();
    monitor.resetBaseline();
    advance(60_000);
    advance(100);
    expect(lines).toEqual([]);
  });
});
