/**
 * Live (2026-10-05): a Sync stuck on one chat for 80+ min in a HIDDEN tab
 * while Google's backend failed (SendMessage 401, ReceiveMessages HTTP/2
 * errors) and its loading indicator stayed up.
 *
 * Cause: loadHistory counted its budgets in NOMINAL sleep time (spent +=
 * 250 per poll). Chrome's intensive throttling of hidden tabs makes each
 * 250 ms setTimeout take ~1 min, and waits that see Google's loading
 * indicator do not even count — so the 60 s budget lasted hours.
 *
 * Mutations: spent not following the wall clock → red ("bounded");
 * no no-progress end → red ("no growth").
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as {
  loadHistory: (doc: Document, io: Record<string, unknown>) => Promise<{ stopReason: string; noProgress?: boolean; idleMs?: number; elapsedMs: number }>;
  HISTORY_NO_PROGRESS_MS: number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** A hidden tab: every sleep, whatever it asked for, costs a throttled minute. */
function throttled() {
  let clock = 1_000_000;
  let sleeps = 0;
  return {
    now: () => clock,
    sleep: async () => {
      sleeps += 1;
      clock += 60_000;
    },
    sleeps: () => sleeps,
  };
}

describe("history loading in a throttled hidden tab (live, 2026-10-05)", () => {
  beforeEach(() => {
    // Google's loading indicator stays up; no message ever arrives.
    document.body.innerHTML = "<div id='spinner'></div>";
  });

  it("bounded: nothing new and the indicator stuck → the chat ends within a few throttled minutes (not_settled)", async () => {
    const t = throttled();
    const r = await scan.loadHistory(document, {
      now: t.now,
      sleep: t.sleep,
      scrollUp: () => undefined,
      hasScroller: () => true,
      loadingSelectors: ["#spinner"],
      startMarkerSelectors: [],
    });
    expect(r.stopReason).toBe("not_settled");
    // Before: hundreds of throttled sleeps (hours). Now: the 60 s budget, on the wall clock.
    expect(t.sleeps()).toBeLessThanOrEqual(4);
  });

  it("no growth: even with a long budget, a chat with no new message for HISTORY_NO_PROGRESS_MS ends (noProgress)", async () => {
    const t = throttled();
    const r = await scan.loadHistory(document, {
      now: t.now,
      sleep: t.sleep,
      scrollUp: () => undefined,
      hasScroller: () => true,
      loadingSelectors: ["#spinner"],
      startMarkerSelectors: [],
      budgetMs: 10 * 60_000, // only the no-progress rule ends it before 10 min
    });
    expect(r.stopReason).toBe("not_settled");
    expect(r.noProgress).toBe(true);
    expect(r.idleMs).toBeGreaterThan(scan.HISTORY_NO_PROGRESS_MS);
    expect(t.sleeps()).toBeLessThanOrEqual(3);
  });

});
