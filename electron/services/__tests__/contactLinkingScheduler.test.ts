/**
 * @jest-environment node
 *
 * BACKLOG-2474 — the scheduler that turns N independent source writes into one
 * matching pass.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * The contract is **"at most one pass per quiet period, and every written
 * record is seen by some pass"** — NOT "exactly one pass per sync run".
 *
 * The stronger claim is false and pinning it would be worse than pinning
 * nothing. `contactSyncService.syncAll` awaits its providers sequentially and
 * each completes an entire paginated network fetch (with a per-request throttle
 * and 429 backoff) before writing, so the gap between two sources on that path
 * routinely exceeds any quiet window worth having. A test asserting one pass
 * would pass here under fake timers and describe a system that does not exist.
 *
 * So: the coalescing tests below use the gap the founder actually observed on
 * the parallel `handleImportAll` path (1.7s), where one pass IS the real
 * property. The "every record is seen" half is proven in the handler suite,
 * against real rows.
 */

const warn = jest.fn();
jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn, error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  MAX_DEFERRAL_MS,
  QUIET_PERIOD_MS,
  __hasPendingContactLinking,
  __resetContactLinkingScheduler,
  cancelPendingContactLinking,
  configureContactLinking,
  holdContactLinking,
  releaseContactLinking,
  requestContactLinking,
  runContactLinkingNow,
} from "../contactLinkingScheduler";

const USER = "user-a";
const OTHER = "user-b";

/** Every userId the runner was called with, in order. IDENTITY, not a count. */
let runs: string[] = [];
let notified: string[] = [];

function configure(run?: (userId: string) => Promise<void> | void): void {
  configureContactLinking({
    run:
      run ??
      ((userId: string) => {
        runs.push(userId);
      }),
    notify: (userId: string) => {
      notified.push(userId);
    },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  runs = [];
  notified = [];
  warn.mockClear();
  __resetContactLinkingScheduler();
});

afterEach(() => {
  __resetContactLinkingScheduler();
  jest.useRealTimers();
});

describe("unconfigured", () => {
  it("is inert and schedules NOTHING", async () => {
    // No configure() call. This is the state every test suite that exercises
    // the real externalContactDbService runs in, and it must not acquire a
    // background timer — an un-fired timer here would surface as a jest open
    // handle in suites that have nothing to do with linking.
    requestContactLinking(USER);
    await runContactLinkingNow(USER);

    expect(__hasPendingContactLinking(USER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(runs).toEqual([]);
  });
});

describe("coalescing", () => {
  it("collapses the founder's macOS -> Outlook -> Google run into ONE pass", () => {
    configure();

    // The exact shape from his log: macOS at t=0, Outlook 1.7s later. Google
    // added on the same parallel path.
    requestContactLinking(USER);
    jest.advanceTimersByTime(1700);
    requestContactLinking(USER);
    jest.advanceTimersByTime(400);
    requestContactLinking(USER);

    // Nothing has run yet — each request restarted the window.
    expect(runs).toEqual([]);

    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([USER]);
  });

  it("does not run while writes are still arriving", () => {
    configure();

    // A write every 2s forever: below the quiet period, so the window keeps
    // restarting and the pass keeps deferring — until the ceiling.
    for (let elapsed = 0; elapsed < MAX_DEFERRAL_MS - 2000; elapsed += 2000) {
      requestContactLinking(USER);
      jest.advanceTimersByTime(2000);
    }
    expect(runs).toEqual([]);
  });

  it("fires at the ceiling even if writes never go quiet", () => {
    configure();

    // Same drip, carried past MAX_DEFERRAL_MS. Without the ceiling this would
    // defer forever and the user would never get an answer during a long sync.
    let elapsed = 0;
    while (elapsed <= MAX_DEFERRAL_MS) {
      requestContactLinking(USER);
      jest.advanceTimersByTime(2000);
      elapsed += 2000;
    }

    expect(runs).toEqual([USER]);
  });

  it("keeps users separate", () => {
    configure();

    requestContactLinking(USER);
    requestContactLinking(OTHER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);

    // Exact set, both present, neither collapsed into the other.
    expect([...runs].sort()).toEqual([OTHER, USER].sort());
  });
});

describe("immediate", () => {
  it("runs now and CANCELS the pending coalesced pass as redundant", async () => {
    configure();

    requestContactLinking(USER);
    expect(__hasPendingContactLinking(USER)).toBe(true);

    await runContactLinkingNow(USER);
    expect(runs).toEqual([USER]);
    expect(__hasPendingContactLinking(USER)).toBe(false);

    // The cancelled timer must not fire a second, redundant pass.
    jest.advanceTimersByTime(QUIET_PERIOD_MS * 2);
    expect(runs).toEqual([USER]);
  });
});

describe("re-entry", () => {
  it("never overlaps a pass with itself, and does not DROP the signal", async () => {
    // The runner became async when it took on the backfill re-run, so two
    // timers for one user could otherwise interleave two passes over the same
    // rows. A signal arriving mid-flight represents records the in-flight pass
    // may have started too early to see — it must be re-armed, not discarded.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlightAt: number[] = [];
    let depth = 0;

    configure(async (userId: string) => {
      depth++;
      inFlightAt.push(depth);
      runs.push(userId);
      await gate;
      depth--;
    });

    const first = runContactLinkingNow(USER);
    // Mid-flight signal.
    requestContactLinking(USER);
    expect(runs).toEqual([USER]);

    release();
    await first;

    // The re-armed pass is scheduled, not run concurrently.
    expect(Math.max(...inFlightAt)).toBe(1);
    expect(__hasPendingContactLinking(USER)).toBe(true);

    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    await Promise.resolve();
    expect(runs).toEqual([USER, USER]);
  });
});

describe("failure containment", () => {
  it("a throwing pass does not escape and does not block the next one", async () => {
    let calls = 0;
    configure(() => {
      calls++;
      throw new Error("pass exploded");
    });

    await expect(runContactLinkingNow(USER)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("linking pass"),
      "ContactLinkingScheduler",
    );

    await runContactLinkingNow(USER);
    expect(calls).toBe(2);
  });

  it("a throwing notify does not escape", async () => {
    configureContactLinking({
      run: (userId: string) => {
        runs.push(userId);
      },
      notify: () => {
        // The real notify reaches a BrowserWindow reference that is assigned
        // once and never reassigned, so it can be stale after a window close
        // and reopen on macOS.
        throw new Error("window is gone");
      },
    });

    await expect(runContactLinkingNow(USER)).resolves.toBeUndefined();
    expect(runs).toEqual([USER]);
  });

  it("notifies AFTER the pass, so a listener never reads a pre-pass count", async () => {
    const order: string[] = [];
    configureContactLinking({
      run: () => {
        order.push("run");
      },
      notify: () => {
        order.push("notify");
      },
    });

    await runContactLinkingNow(USER);
    expect(order).toEqual(["run", "notify"]);
  });
});

describe("holds", () => {
  it("suspends passes while rollback-eligible rows exist, then runs the one owed", () => {
    configure();

    holdContactLinking(USER);
    // A DIFFERENT source signalling during the hold — the case that suppressing
    // the provisional path's own signal does not cover.
    requestContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS * 3);
    expect(runs).toEqual([]);

    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    // Owed, not lost.
    expect(runs).toEqual([USER]);
  });

  it("disarms a pass that was ALREADY scheduled when the hold is taken", () => {
    configure();

    requestContactLinking(USER);
    holdContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS * 3);
    expect(runs).toEqual([]);

    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([USER]);
  });

  it("defers even an immediate run", async () => {
    configure();

    holdContactLinking(USER);
    await runContactLinkingNow(USER);
    expect(runs).toEqual([]);

    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([USER]);
  });

  it("is depth-counted, so overlapping syncs compose", () => {
    configure();

    holdContactLinking(USER);
    holdContactLinking(USER);
    requestContactLinking(USER);

    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS * 2);
    // Still held by the outer sync.
    expect(runs).toEqual([]);

    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([USER]);
  });

  it("holds one user without holding another", () => {
    configure();

    holdContactLinking(USER);
    requestContactLinking(USER);
    requestContactLinking(OTHER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS);

    expect(runs).toEqual([OTHER]);
  });

  it("releasing without a pending request runs nothing", () => {
    configure();

    holdContactLinking(USER);
    releaseContactLinking(USER);
    jest.advanceTimersByTime(QUIET_PERIOD_MS * 2);

    expect(runs).toEqual([]);
  });
});

describe("cancellation", () => {
  it("drops one user's pending pass without touching another's", () => {
    configure();

    requestContactLinking(USER);
    requestContactLinking(OTHER);
    cancelPendingContactLinking(USER);

    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([OTHER]);
  });

  it("drops every pending pass (logout / quit)", () => {
    configure();

    requestContactLinking(USER);
    requestContactLinking(OTHER);
    cancelPendingContactLinking();

    jest.advanceTimersByTime(QUIET_PERIOD_MS);
    expect(runs).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
