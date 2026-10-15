/**
 * @jest-environment node
 *
 * BACKLOG-3884 follow-up — main-process event-loop lag log.
 *
 * The first test runs the REAL timer against a REAL synchronous block of
 * the test's own thread: a 1300 ms busy-wait must produce at least one line naming the
 * running channel. (A drift timer under-reads a block by up to one
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
      minLogGapMs: 0,
    });
    monitor.start();
  }

  it("logs a line for a 1300 ms block, naming the IPC channel that was running", async () => {
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

    // Extra lines from an unrelated worker stall must not matter: require at
    // least one line naming the blocking channel.
    const re =
      /^\[MainLag\] durationMs=(\d+) sinceLastIpc=transactions:get-overview lastIpcAgoMs=\d+ inFlight=\S+ syncPhase=none$/;
    const named = lines.filter((l) => re.test(l));
    expect(named.length).toBeGreaterThanOrEqual(1);
    expect(named.some((l) => Number(l.match(re)![1]) >= MAIN_LAG_THRESHOLD_MS)).toBe(true);
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

  it("a tick after suspend/resume only sets a baseline, even when the wake gap is huge", () => {
    const { lines, advance, monitor } = setup();
    advance(100);
    monitor.suspend();
    advance(100); // tick while suspended: ignored
    monitor.resume();
    advance(60_000); // first tick after resume: baseline only
    advance(100);
    expect(lines).toEqual([]);
  });

  it("a tick that runs after the wake but before resume is delivered does not log", () => {
    const { lines, advance, monitor } = setup();
    advance(100);
    monitor.suspend();
    advance(100); // pre-sleep tick: must not become a baseline
    advance(60_000); // woke, resume event not yet delivered
    monitor.resume();
    advance(100);
    expect(lines).toEqual([]);
  });

  it("resume without a prior suspend still drops the old baseline", () => {
    const { lines, advance, monitor } = setup();
    advance(100);
    monitor.resume();
    advance(60_000); // first tick after resume: baseline only
    advance(100);
    expect(lines).toEqual([]);
  });

  it("a suspend with no resume event clears itself after 50 on-schedule ticks", () => {
    const { lines, advance, monitor } = setup();
    monitor.suspend();
    for (let i = 0; i < 50; i += 1) advance(100);
    expect(lines).toEqual(["[MainLag] resumed without a resume event"]);
    advance(100 + 1300); // a real block after the auto-resume
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\[MainLag\] durationMs=1300 /);
  });

  it("an off-schedule tick restarts the auto-resume count", () => {
    const { lines, advance, monitor } = setup();
    monitor.suspend();
    for (let i = 0; i < 40; i += 1) advance(100);
    advance(60_000); // wake gap
    for (let i = 0; i < 40; i += 1) advance(100);
    expect(lines).toEqual([]);
  });
});
