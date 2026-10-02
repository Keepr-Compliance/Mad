/**
 * Founder (2026-10-02) — GAP GUARD: every message inside the window is
 * captured, with no gap in the middle, on a list that RECYCLES its rows
 * (virtualized: only a window of messages is in the DOM at a time).
 *
 * Mutations that turn this red:
 *   G1 no overlap check (a skipped page goes undetected)          → "a skipped page is detected"
 *   G2 messages taken only from the final DOM (not as read)        → "every message read is kept"
 *   G3 an unbridgeable gap not reported as history_gap             → "unrecovered"
 *   G4 the union not unique / not sorted                           → "every message read is kept"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const scan = require("../../chrome-extension/scan.js") as Record<string, any>;
const extract = require("../../chrome-extension/extract.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WINDOW = 25;

/** Message i (0 = newest), one per day back from 2026-09-20 09:05 local. */
function wrapper(i: number): string {
  const d = new Date(2026, 8, 20 - i, 9, 5);
  const phrase = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at 9:05 AM`;
  return `<mws-message-wrapper msg-id="g${i}"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
    <mws-text-message-part aria-label="Test Contact A said: note ${i}. Received on ${phrase}."><mws-message-part-content data-e2e-message-content>note ${i}</mws-message-part-content></mws-text-message-part>
  </div></mws-message-wrapper>`;
}

/**
 * A recycling pane over `total` messages: only [start, start + WINDOW) is in
 * the DOM. scrollUp moves the window 20 older (5 overlap) — except the
 * scrolls listed in `jumpAt`, which move it 45 (no overlap: a skipped page).
 * stepBack moves it 10 newer, or not at all when `stuck`.
 */
function recyclingPane(opts: { total: number; jumpAt?: number[]; stuck?: boolean }) {
  let start = 0;
  let scrolls = 0;
  const render = (): void => {
    let html = "";
    const end = Math.min(opts.total, start + WINDOW);
    for (let i = end - 1; i >= start; i--) html += wrapper(i);
    let pane = document.getElementById("pane");
    if (!pane) {
      document.body.innerHTML = `<div id="pane"></div>`;
      pane = document.getElementById("pane");
    }
    pane!.innerHTML = html;
  };
  render();
  return {
    scrollUp: (): void => {
      scrolls += 1;
      const jump = (opts.jumpAt ?? []).includes(scrolls) ? 45 : 20;
      start = Math.min(Math.max(0, opts.total - WINDOW), start + jump);
      render();
    },
    stepBack: (): void => {
      if (opts.stuck) return;
      start = Math.max(0, start - 10);
      render();
    },
    sleep: async (): Promise<void> => {},
    oldestMs: (): number | null => null,
    extractBatch: () =>
      extract.extractConversation(document, "https://messages.google.com/web/conversations/aaaaaaaaaaaaaaaaaaa", new Date(2026, 8, 21)).messages,
  };
}

const run = (p: ReturnType<typeof recyclingPane>) =>
  scan.loadHistory(document, { ...p, floorMs: null, hasScroller: () => true, nudgeWaitsMs: [250], budgetMs: 60_000 });

// SR: the ON-SCREEN copy wins (images loaded, reactions present); a
// same-minute sentAt is ordered by numeric msg-id, then first-seen.
// Mutations: read copy first / no numeric tie-break → red.
describe("unionMessages (gap guard)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const job = require("../../chrome-extension/job.js") as Record<string, any>;
  const at = "2026-09-20T09:05:00.000Z";
  it("the on-screen copy of a message wins over the copy read earlier", () => {
    const read = [{ msgId: "7", sentAt: at, images: 0, reactions: [] }];
    const onScreen = [{ msgId: "7", sentAt: at, images: 1, reactions: [{ emoji: "x" }] }];
    expect(job.unionMessages(read, onScreen)).toEqual(onScreen);
  });
  it("same minute: numeric msg-id order (10 after 9), then first seen", () => {
    const read = [
      { msgId: "10", sentAt: at },
      { msgId: "9", sentAt: at },
      { msgId: "b", sentAt: at },
      { msgId: "a", sentAt: at },
      { msgId: "1", sentAt: "2026-09-20T09:04:00.000Z" },
    ];
    expect(job.unionMessages(read, []).map((m: { msgId: string }) => m.msgId)).toEqual(["1", "9", "10", "b", "a"]);
  });
  it("ids longer than 15 digits: compared exactly (length, then digits), not as rounded numbers", () => {
    const big = ["90071992547409930", "90071992547409929", "900719925474099301"].map((msgId) => ({ msgId, sentAt: at }));
    expect(job.unionMessages(big, []).map((m: { msgId: string }) => m.msgId)).toEqual([
      "90071992547409929", "90071992547409930", "900719925474099301",
    ]);
  });
});

/**
 * SR T1/T2: a page parked at the top that loads only during the nudge's
 * return steps, with a recycling window. At return step 2 the window jumps to
 * the NEW batch only (no overlap — momentarily), at step 5 it settles on a
 * window that overlaps what was read before. `flash`: a message is on screen
 * ONLY during return step 3's poll.
 */
function nudgePane(opts: { flash?: boolean }) {
  const render = (from: number, to: number, extra = "") => {
    let html = "";
    for (let i = to - 1; i >= from; i--) html += wrapper(i);
    document.body.innerHTML = `<div id="pane">${html}${extra}</div>`;
  };
  render(0, 25);
  let loaded = false;
  return {
    scrollUp: (): void => {}, // parked: a plain scroll-up asks for nothing
    nudgeDown: (): void => {},
    nudgeReturnStep: (i: number): void => {
      if (loaded) return;
      if (i === 2) render(25, 50); // the new batch alone: NO overlap yet
      if (i === 3 && opts.flash) render(25, 50, wrapper(77)); // g77 visible only now
      if (i === 4 && opts.flash) render(25, 50);
      if (i === 5) {
        render(20, 50); // settled: overlaps g20..g24
        loaded = true;
      }
    },
    sleep: async (): Promise<void> => {},
    oldestMs: (): number | null => null,
    extractBatch: () =>
      extract.extractConversation(document, "https://messages.google.com/web/conversations/aaaaaaaaaaaaaaaaaaa", new Date(2026, 8, 21)).messages,
  };
}

describe("history v2: the nudge's return steps are collected, never judged (SR T1, T2)", () => {
  const go = (p: ReturnType<typeof nudgePane>) =>
    scan.loadHistory(document, { ...p, floorMs: null, hasScroller: () => true, budgetMs: 60_000 });

  // Mutation: check contiguity at each return step → the momentary jump trips history_gap → red.
  it("a momentary jump during the return steps is not a gap (T1)", async () => {
    const r = await go(nudgePane({}));
    expect(r.stopReason).toBe("no_more");
    expect(r.gapsDetected).toBeUndefined();
    expect(r.count).toBe(50);
  });

  // Mutation: no union collect in the nudge polls → g77 is lost → red.
  it("a message on screen only during a nudge poll is kept (T2)", async () => {
    const r = await go(nudgePane({ flash: true }));
    const ids = (r.messages as Array<{ msgId: string }>).map((m) => m.msgId);
    expect(ids).toContain("g77");
  });
});

describe("gap guard on a recycling list", () => {
  it("every message read is kept (unique, oldest first), though the DOM only ever holds 25 (G2, G4)", async () => {
    const r = await run(recyclingPane({ total: 100 }));
    expect(r.gapsDetected).toBeUndefined();
    const ids = (r.messages as Array<{ msgId: string }>).map((m) => m.msgId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe("g99"); // oldest first
    expect(ids[99]).toBe("g0");
    expect(document.querySelectorAll("mws-message-wrapper")).toHaveLength(25);
  });

  it("a skipped page is detected and bridged by stepping back — nothing missing (G1)", async () => {
    const r = await run(recyclingPane({ total: 100, jumpAt: [2] }));
    expect(r).toMatchObject({ gapsDetected: 1, gapsRecovered: 1 });
    expect(r.stopReason).not.toBe("history_gap");
    const ids = new Set((r.messages as Array<{ msgId: string }>).map((m) => m.msgId));
    for (let i = 0; i < 100; i++) expect(ids.has(`g${i}`)).toBe(true);
  });

  it("unrecovered: a gap the step-back cannot bridge ends history_gap (G3)", async () => {
    const r = await run(recyclingPane({ total: 100, jumpAt: [2], stuck: true }));
    expect(r).toMatchObject({ stopReason: "history_gap", gapsDetected: 1, gapsRecovered: 0 });
  });
});
