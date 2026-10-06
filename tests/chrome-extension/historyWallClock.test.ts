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
  HISTORY_WALL_CEILING_MS: number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * A hidden tab: every sleep costs `tickMs` of wall time. The chat grows by
 * one message every `every` sleeps — slowly, but it never stalls for long.
 */
function slowGrowingHiddenChat(every: number, tickMs: number) {
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
      clock += tickMs;
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
    // 15 s per poll: the minimum polls (7.5 min) come before the wall ceiling.
    const t = slowGrowingHiddenChat(3, 15_000);
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

  // SR: an absolute wall-clock ceiling per chat, whatever the poll count.
  // Mutation: no ceiling → red (~30 throttled minutes on one chat).
  it("ceiling: at 1 min per poll a chat that keeps growing ends at 10 minutes (not_settled)", async () => {
    const t = slowGrowingHiddenChat(1, 60_000);
    const r = await scan.loadHistory(document, {
      now: t.now,
      sleep: t.sleep,
      scrollUp: () => undefined,
      hasScroller: () => true,
      startMarkerSelectors: [],
      loadingSelectors: [],
      cap: 100_000,
    });
    expect(t.sleeps()).toBeLessThanOrEqual(scan.HISTORY_WALL_CEILING_MS / 60_000 + 1);
    expect(r.stopReason).toBe("not_settled");
    expect((r as { wallCeiling?: boolean }).wallCeiling).toBe(true);
  });

  // Live (founder, 0.3.84 hidden run): a chat read back 88 days for a 30-day
  // floor ended not_settled — never settled, yet complete for this Sync.
  // Now the same "date_floor" stop. Mutation: the conversion removed → red.
  it("read past the floor but never settled: date_floor, not not_settled", async () => {
    const t = slowGrowingHiddenChat(1, 60_000);
    const now = t.now();
    const old = { msgId: "old", sentAt: new Date(now - 88 * 864e5).toISOString() };
    const r = await scan.loadHistory(document, {
      now: t.now,
      sleep: t.sleep,
      scrollUp: () => undefined,
      hasScroller: () => true,
      startMarkerSelectors: [],
      loadingSelectors: [],
      cap: 100_000,
      floorMs: now - 30 * 864e5,
      // What the page showed at each check is newer than the floor; the
      // message past it was read (kept) on the way.
      oldestMs: () => null,
      extractBatch: () => [old],
    });
    expect(r.stopReason).toBe("date_floor");
    expect(r.noProgress).toBeUndefined();
  });

  it("grew, then stalled with the page never settling, but read past the floor: date_floor, and not counted as a stall", async () => {
    // 15 s per poll; grows for the first polls, then nothing (Google stopped).
    let clock = 1_000_000;
    let sleeps = 0;
    let n = 0;
    const add = () => {
      const w = document.createElement("mws-message-wrapper");
      w.setAttribute("msg-id", "g" + n++);
      document.body.appendChild(w);
    };
    add();
    const now = clock;
    const r = await scan.loadHistory(document, {
      now: () => clock,
      sleep: async () => { sleeps += 1; clock += 15_000; if (sleeps <= 26) add(); },
      scrollUp: () => undefined, hasScroller: () => true,
      startMarkerSelectors: [], loadingSelectors: [], cap: 100_000,
      floorMs: now - 30 * 864e5, oldestMs: () => null,
      extractBatch: () => [{ msgId: "old", sentAt: new Date(now - 88 * 864e5).toISOString() }],
    });
    expect(r.stopReason).toBe("date_floor");
    expect(r.noProgress).toBeUndefined();
  });

  it("never read past the floor: still not_settled", async () => {
    const t = slowGrowingHiddenChat(1, 60_000);
    const now = t.now();
    const recent = { msgId: "recent", sentAt: new Date(now - 10 * 864e5).toISOString() };
    const r = await scan.loadHistory(document, {
      now: t.now, sleep: t.sleep, scrollUp: () => undefined, hasScroller: () => true,
      startMarkerSelectors: [], loadingSelectors: [], cap: 100_000,
      floorMs: now - 30 * 864e5, oldestMs: () => null, extractBatch: () => [recent],
    });
    expect(r.stopReason).toBe("not_settled");
  });
});
