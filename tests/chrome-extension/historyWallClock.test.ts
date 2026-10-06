/**
 * Live (2026-10-05): a Sync stuck on one chat for 80+ min in a HIDDEN tab
 * while Google's backend failed (SendMessage 401, ReceiveMessages HTTP/2
 * errors).
 *
 * Cause: loadHistory counted its budgets in NOMINAL sleep time (spent +=
 * 250 per poll). Chrome's intensive throttling of hidden tabs makes each
 * 250 ms setTimeout take ~1 min, so a budget meant as minutes lasted hours.
 * Now the wall clock counts too — but (SR F2) only after a minimum of real
 * polls, so a slowly growing hidden chat is not cut after one or two tries.
 *
 * Mutations: spent not following the wall clock → red ("bounded"); the
 * minimum polls removed → red ("not cut early").
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as {
  loadHistory: (doc: Document, io: Record<string, unknown>) => Promise<{ stopReason: string; count: number; noProgress?: boolean }>;
  HISTORY_MIN_POLLS_FOR_WALL: number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * A hidden tab: every sleep costs a throttled minute. The chat grows by one
 * message every `every` sleeps — slowly, but it never stalls for long.
 */
function slowGrowingHiddenChat(every: number) {
  let clock = 1_000_000;
  let sleeps = 0;
  let n = 0;
  const add = () => {
    const w = document.createElement("mws-message-wrapper");
    w.setAttribute("msg-id", "m" + n++);
    document.body.appendChild(w);
  };
  add();
  return {
    now: () => clock,
    sleep: async () => {
      sleeps += 1;
      clock += 60_000;
      if (sleeps % every === 0) add();
    },
    sleeps: () => sleeps,
  };
}

describe("history loading in a throttled hidden tab (live, 2026-10-05; SR F2)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("not cut early, and bounded: a slowly growing hidden chat gets ≥ the minimum polls, then ends on wall time", async () => {
    const t = slowGrowingHiddenChat(3);
    const r = await scan.loadHistory(document, {
      now: t.now,
      sleep: t.sleep,
      scrollUp: () => undefined,
      hasScroller: () => true,
      startMarkerSelectors: [],
      loadingSelectors: [],
      cap: 100_000,
    });
    // F2: never cut after one or two attempts.
    expect(t.sleeps()).toBeGreaterThanOrEqual(scan.HISTORY_MIN_POLLS_FOR_WALL);
    expect(r.count).toBeGreaterThanOrEqual(8);
    // Bounded: before, the nominal budget (extended while growing, up to the
    // cap) meant thousands of throttled minutes; now it ends soon after.
    expect(t.sleeps()).toBeLessThanOrEqual(scan.HISTORY_MIN_POLLS_FOR_WALL + 10);
    expect(r.stopReason).toBe("not_settled");
  });
});
