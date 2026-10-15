/**
 * BACKLOG-3884 — a renderer main-thread stall of >= 1 s logs one line with the
 * screen and phase NAMES, rate-limited.
 */
import {
  createStallReporter,
  installRendererStallLogger,
  __resetRendererStallLoggerForTests,
  STALL_LOG_MS,
  STALL_LOG_MIN_INTERVAL_MS,
} from "../rendererStallLogger";

function reporter() {
  const lines: string[] = [];
  let now = 0;
  const report = createStallReporter({
    now: () => now,
    log: (l) => lines.push(l),
    screen: () => "dashboard+TransactionDetails",
    phase: () => "transaction-open",
  });
  return { lines, report, at: (t: number) => (now = t) };
}

describe("renderer stall reporter", () => {
  it(`logs a ${STALL_LOG_MS} ms stall with screen and phase; ignores ${STALL_LOG_MS - 1} ms`, () => {
    const { lines, report } = reporter();
    report(STALL_LOG_MS - 1, "longtask");
    expect(lines).toEqual([]);
    report(STALL_LOG_MS, "longtask");
    expect(lines).toEqual([
      "[RendererStall] durationMs=1000 screen=dashboard+TransactionDetails phase=transaction-open source=longtask",
    ]);
  });

  it("rate-limits, then reports how many were suppressed", () => {
    const { lines, report, at } = reporter();
    at(0);
    report(2_000, "longtask");
    at(STALL_LOG_MIN_INTERVAL_MS - 1);
    report(3_000, "longtask");
    at(STALL_LOG_MIN_INTERVAL_MS);
    report(1_500, "raf");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "[RendererStall] durationMs=1500 screen=dashboard+TransactionDetails phase=transaction-open source=raf suppressed=1",
    );
  });
});

describe("installRendererStallLogger", () => {
  beforeEach(() => __resetRendererStallLoggerForTests());

  it("observes longtask entries when supported", () => {
    const lines: string[] = [];
    let cb: ((list: { getEntries: () => { duration: number }[] }) => void) | null = null;
    class FakePO {
      static supportedEntryTypes = ["longtask"];
      constructor(fn: typeof cb) {
        cb = fn;
      }
      observe(): void {}
    }
    const mode = installRendererStallLogger({
      PerformanceObserver: FakePO as unknown as typeof PerformanceObserver,
      now: () => 0,
      log: (l) => lines.push(l),
    });
    expect(mode).toBe("longtask");
    cb!({ getEntries: () => [{ duration: 40 }, { duration: 1_200 }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[RendererStall\] durationMs=1200 .*source=longtask$/);
  });

  it("falls back to rAF gaps while visible, and ignores gaps across a hidden window", () => {
    const lines: string[] = [];
    let frame: FrameRequestCallback | null = null;
    let t = 0;
    const doc = { visibilityState: "visible", addEventListener: () => undefined } as unknown as Document;
    const mode = installRendererStallLogger({
      PerformanceObserver: undefined,
      requestAnimationFrame: (f) => ((frame = f), 1),
      document: doc,
      now: () => t,
      log: (l) => lines.push(l),
    });
    expect(mode).toBe("raf");
    const step = (to: number) => {
      t = to;
      frame!(to);
    };
    step(16);
    step(1_216); // 1200 ms gap, visible
    expect(lines).toHaveLength(1);
    (doc as unknown as { visibilityState: string }).visibilityState = "hidden";
    step(20_000);
    (doc as unknown as { visibilityState: string }).visibilityState = "visible";
    step(40_000);
    step(40_016);
    expect(lines).toHaveLength(1);
  });
});
