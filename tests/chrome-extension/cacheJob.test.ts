/**
 * BACKLOG-3658 (cache P2) — the page side of a cache Sync.
 *
 * A cache Sync stores every recent chat (Keepr links them later). On the page:
 *   - the list read stops at the first chat older than `since` (list times);
 *     with no readable time it is the whole list, capped, the rest "not checked";
 *   - every chat above the cutoff is checked in list order (no name planning);
 *   - a chat with no number is "no_numbers", never an error;
 *   - an image Keepr does not keep (422 not_a_contact) is counted apart and
 *     never makes the chat "not fully imported";
 *   - the steps PAUSE while the tab is hidden and resume once visible;
 *   - progress lines carry a Cancel for this job.
 *
 * Mutations that turn this suite red:
 *   M1 drop the `since` stop in collectConversations         → "stops at the first chat older than since"
 *   M2 cachePlan ignores the cutoff / the cap                 → "cachePlan" cases
 *   M3 a cache job not in list order                          → "checks every chat above the cutoff, in list order"
 *   M4 the no-number chat reported as "error"                 → same test (no_numbers)
 *   M5 a 422 not_a_contact counted as a failed image          → "an image Keepr does not keep"
 *   M6 drop holdWhileHidden before a chat                     → "pauses while hidden"
 *   M7 the history floor back to startDate for a cache job    → "history floor is since"
 *   M8 no Cancel on progress lines / Cancel calls nothing     → "renderOverlay: Cancel"
 *   M9 the page Sync button brought back                     → "no Keepr element on the page when idle"
 *   M10 done details not Keepr's saved counts                → "done details"
 */

import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/* eslint-enable @typescript-eslint/no-require-imports */

const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
// Wed 2026-09-30, 15:00 local.
const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();
const DAY = 864e5;

jest.setTimeout(10_000);

function id(n: number): string {
  return String.fromCharCode(97 + (n % 26)).repeat(19 - String(n).length) + String(n);
}

/** A synthetic list, newest first: [name, shown time text]. */
function renderList(rows: Array<[string, string | null]>): void {
  document.body.innerHTML =
    `<mws-conversations-list>` +
    rows
      .map(([name, time], i) =>
        `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${id(i)}">` +
        `<span data-e2e-conversation-name>${name}</span>` +
        (time === null ? "" : `<mws-relative-timestamp>${time}</mws-relative-timestamp>`) +
        `</a></mws-conversation-list-item>`,
      )
      .join("") +
    `</mws-conversations-list><div id="chat"></div>`;
}

describe("parseListTime (day precision)", () => {
  it.each([
    ["3:45 PM", NOW],
    ["15:45", NOW],
    ["Yesterday", new Date(2026, 8, 29).getTime()],
    ["Mon", new Date(2026, 8, 28).getTime()],
    ["Wed", new Date(2026, 8, 23).getTime()], // today's weekday → a week ago
    ["Sep 20", new Date(2026, 8, 20).getTime()],
    ["Dec 24", new Date(2025, 11, 24).getTime()], // in the future this year → last year
    ["Jan 3, 2024", new Date(2024, 0, 3).getTime()],
    ["9/20/25", new Date(2025, 8, 20).getTime()],
  ])("%s", (text, expected) => {
    expect(scan.parseListTime(text, NOW)).toBe(expected);
  });

  it.each(["", "soon", "Sep", "13/45/2026x", "13/14/25", "0/5/25"])("unreadable %p → null", (text) => {
    expect(scan.parseListTime(text, NOW)).toBeNull();
  });

  // LIVE (0.3.18): chats from before this year read "M/D/YY". Both parts 12
  // or less used to be null, so the list read ran on past the floor.
  // Mutation: back to null for both-≤12 → red.
  it.each([
    ["9/2/25", "mdy", new Date(2025, 8, 2).getTime()],
    ["9/2/2025", "mdy", new Date(2025, 8, 2).getTime()],
    ["12/12/2025", "mdy", new Date(2025, 11, 12).getTime()],
    ["3/4/25", "mdy", new Date(2025, 2, 4).getTime()],
    ["3/4/25", "dmy", new Date(2025, 3, 3).getTime()],
    ["2.9.25", "dmy", new Date(2025, 8, 2).getTime()],
  ])("numeric %s (%s)", (text, order, expected) => {
    expect(scan.parseListTime(text, NOW, { order })).toBe(expected);
  });

  it("a part over 12 settles the order and records it for the rest of the read", () => {
    const order = { order: "mdy" };
    expect(scan.parseListTime("20/9/25", NOW, order)).toBe(new Date(2025, 8, 20).getTime());
    expect(order).toEqual({ order: "dmy", proven: true });
    expect(scan.parseListTime("2/9/25", NOW, order)).toBe(new Date(2025, 8, 2).getTime());
    expect(scan.parseListTime("9/20/25", NOW, { order: "dmy" })).toBe(new Date(2025, 8, 20).getTime());
  });

  it("the locale's order is month first or day first", () => {
    expect(["mdy", "dmy"]).toContain(scan.localeDateOrder());
  });
});

// Live (0.3.18, a 14-day run read "the 1-month limit"). Mutation: rounded to months again → red.
describe("windowLabel: the window as set", () => {
  it.each([[14, "14-day"], [10, "10-day"], [30, "1-month"], [46, "1.5-month"], [91, "3-month"], [89, "3-month"], [183, "6-month"], [365, "1-year"], [400, "400-day"]])(
    "%d days → %s", (days, label) => {
      expect(job.windowLabel(days)).toBe(label);
    });
});

describe("the list read never goes past the floor (LIVE 0.3.18)", () => {
  // A 90-day run: this year's "Mon D" / weekday / time stamps, then last
  // year's "M/D/YY" — all with both parts 12 or less.
  const LIVE_LIST: Array<[string, string]> = [
    ["A", "3:45 PM"], ["B", "Mon"], ["C", "Sep 20"], ["D", "Aug 31"], ["E", "Mar 28"], ["F", "Jan 18"],
    ["G", "9/2/25"], ["H", "9/1/25"], ["I", "8/12/25"], ["J", "7/4/25"], ["K", "6/6/2025"],
  ];
  const names = (out: { conversations: Array<{ name: string }> }) => out.conversations.map((c) => c.name);
  // The page renders the list a window at a time: one more row per scroll.
  const read = (opts: Record<string, unknown>) => {
    let shown = 1;
    renderList(LIVE_LIST.slice(0, shown));
    return scan.collectConversations(document, {
      sleep: async () => {}, now: () => NOW, dateOrder: "mdy", stableRounds: 2,
      scroll: () => renderList(LIVE_LIST.slice(0, ++shown)),
      ...opts,
    });
  };
  const FLOOR_400 = NOW - 400 * DAY; // ≈ 8/26/25: inside the M/D/YY stretch

  // Mutation: both-≤12 numeric dates back to null → the read runs to the end → red.
  it("M/D/YY stamps end the read two past the floor", async () => {
    const out = await read({ stopAtOlderThanMs: FLOOR_400 });
    expect(out.stopReason).toBe("since");
    expect(names(out)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(out.scroll.timesUnread).toBe(0);
    expect(out.scroll.timesRead).toBe(10);
  });

  // Live (0.3.18, 14-day run: "Scanned 273 chats", steps 0): rows still mounted
  // were all taken in one pass. Mutation: the pass not ended at the stop → red.
  it("rows already on screen past the stop are not taken", async () => {
    renderList(LIVE_LIST);
    const out = await scan.collectConversations(document, {
      sleep: async () => {}, now: () => NOW, dateOrder: "mdy", stopAtOlderThanMs: FLOOR_400,
    });
    expect(out.stopReason).toBe("since");
    expect(names(out)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  });

  // Mutation: chats switched back on keep the read going past the floor → red.
  it("a chat switched back on that was never seen does not push the read past the floor", async () => {
    const out = await read({ stopAtOlderThanMs: NOW - 10 * DAY, mustSee: ["zzzzzzzzzzzzzzzzzzz"], mustSeeFloorMs: FLOOR_400 });
    expect(out.stopReason).toBe("since");
    expect(names(out)).not.toContain("K");
  });

  it("chats switched back on are still looked for, down to the floor", async () => {
    const out = await read({ stopAtOlderThanMs: NOW - 10 * DAY, mustSee: [id(7)], mustSeeFloorMs: FLOOR_400 });
    expect(out.stopReason).toBe("since");
    expect(names(out)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]); // already past since: stops as soon as H is seen
  });
});


describe("collectConversations with a since cutoff (M1)", () => {
  it("stops at the first chat older than since", async () => {
    renderList([["A", "3:45 PM"], ["B", "Mon"], ["C", "Sep 1"], ["D", "Aug 1"]]);
    const out = await scan.collectConversations(document, {
      sleep: async () => {},
      now: () => NOW,
      stopAtOlderThanMs: NOW - 10 * DAY,
    });
    expect(out.stopReason).toBe("since");
    expect(out.conversations.map((c: { name: string }) => c.name)).toEqual(["A", "B", "C", "D"]);
    expect(out.conversations[2].timeMs).toBe(new Date(2026, 8, 1).getTime());
  });

  it("one older chat followed by a newer one does not stop the read (SR D)", async () => {
    renderList([["Pinned", "Aug 1"], ["A", "3:45 PM"], ["B", "Mon"]]);
    const out = await scan.collectConversations(document, {
      sleep: async () => {},
      now: () => NOW,
      stopAtOlderThanMs: NOW - 10 * DAY,
    });
    expect(out.stopReason).not.toBe("since");
    expect(out.conversations).toHaveLength(3);
  });

  it("without list times it reads on (no early stop)", async () => {
    renderList([["A", null], ["B", null]]);
    const out = await scan.collectConversations(document, {
      sleep: async () => {},
      now: () => NOW,
      stopAtOlderThanMs: NOW - 10 * DAY,
    });
    expect(out.stopReason).not.toBe("since");
    expect(out.conversations).toHaveLength(2);
  });
});

describe("cachePlan (M2)", () => {
  const conv = (n: number, timeMs: number | null) => ({ conversationId: id(n), name: `Chat ${n}`, href: "", timeMs });

  const idsOf = (plan: { queue: Array<{ conversation: { conversationId: string } }> }) =>
    plan.queue.map((q) => q.conversation.conversationId);

  // SR F1: chats switched back on go FIRST, then the 300 cap — with a full
  // list they would otherwise stay "not checked" forever. Mutation: append
  // them after the regular chats → red.
  it("chats switched back on are checked first, even behind a full list (> 300 chats)", () => {
    const list = Array.from({ length: 320 }, (_, i) => conv(i, NOW - DAY));
    list.push(conv(400, NOW - 50 * DAY)); // switched back on, older than since
    const plan = job.cachePlan(list, NOW - 10 * DAY, { [id(400)]: true });
    expect(idsOf(plan)[0]).toBe(id(400));
    expect(idsOf(plan)).toHaveLength(300);
    expect(plan.notChecked).toBe(21);
  });

  it("every chat above the cutoff (two older in a row), in list order; the cutoff and below are out", () => {
    const list = [conv(0, NOW), conv(1, null), conv(2, NOW - 5 * DAY), conv(3, NOW - 30 * DAY), conv(4, NOW - 31 * DAY), conv(5, NOW)];
    const plan = job.cachePlan(list, NOW - 10 * DAY);
    expect(idsOf(plan)).toEqual([id(0), id(1), id(2)]);
    expect(plan.notChecked).toBe(0);
  });

  it("one older chat (e.g. pinned at the top) neither cuts the list nor is checked (SR D)", () => {
    const list = [conv(0, NOW - 90 * DAY), conv(1, NOW), conv(2, NOW - 2 * DAY)];
    expect(idsOf(job.cachePlan(list, NOW - 10 * DAY))).toEqual([id(1), id(2)]);
  });

  it("no list times: the whole list, capped; the rest are not checked", () => {
    const list = Array.from({ length: job.CACHE_CHECK_MAX + 7 }, (_, n) => conv(n, null));
    const plan = job.cachePlan(list, NOW - 10 * DAY);
    expect(plan.queue).toHaveLength(job.CACHE_CHECK_MAX);
    expect(plan.queue[0].conversation.conversationId).toBe(id(0));
    expect(plan.notChecked).toBe(7);
  });

  it("no since (null): the whole list", () => {
    const plan = job.cachePlan([conv(0, NOW - 400 * DAY), conv(1, NOW)], null);
    expect(plan.queue).toHaveLength(2);
  });
});

/** A two-pane page: the list stays; clicking a chat opens it. */
function cacheEnv(opts: {
  rows: Array<[string, string | null]>;
  numbers: Record<string, string[]>;
  imageReply?: { ok: boolean; status: number; body: Record<string, unknown> };
  visibility?: { hidden: () => boolean; onChange?: (cb: (hidden: boolean) => void) => () => void };
  finishReply?: Record<string, unknown>;
  /** History v2: /match's keepImages answer. */
  keepImages?: boolean;
  /** Live (0.3.15): extra claim fields (pendingConversationIds, floor). */
  claimExtra?: Record<string, unknown>;
  /** SR (2026-10-02): /match's floorMs per conversation id (a deal chat). */
  matchFloor?: Record<string, number>;
  /** 3671 P3 "Try again": /match says skip for these conversation ids. */
  matchSkip?: string[];
  /** The history load's stop reason (default "floor"). */
  historyStop?: string;
}) {
  renderList(opts.rows);
  let open = "";
  const opened: string[] = [];
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const shown: Array<[string, boolean, unknown]> = [];
  const floors: Array<number | null> = [];
  const since = new Date(NOW - 10 * DAY).toISOString();
  const env = {
    doc: document,
    now: () => new Date(NOW),
    getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
    api: async (method: string, p: string, body?: Record<string, unknown>) => {
      calls.push([method, p, body]);
      if (p.endsWith("/claim")) {
        return { ok: true, status: 200, body: { jobId: JOB, kind: "cache", contacts: [], since, startDate: "2020-01-01T00:00:00.000Z", ...(opts.claimExtra ?? {}) } };
      }
      if (p.endsWith("/match")) {
        const floorMs = opts.matchFloor && body ? opts.matchFloor[body.conversationId as string] : undefined;
        return {
          ok: true, status: 200,
          body: {
            ...(opts.keepImages === undefined ? { matched: true } : { matched: true, keepImages: opts.keepImages }),
            ...(floorMs !== undefined ? { floorMs } : {}),
            ...(opts.matchSkip && body && opts.matchSkip.includes(body.conversationId as string) ? { skip: true } : {}),
          },
        };
      }
      if (p.endsWith("/attachment")) return opts.imageReply ?? { ok: true, status: 200, body: { ok: true } };
      if (p.endsWith("/chat")) return { ok: true, status: 200, body: { ok: true, stored: 1, received: 1 } };
      if (p.endsWith("/finish") && opts.finishReply) return { ok: true, status: 200, body: opts.finishReply };
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: { show: (t: string, e: boolean, x?: unknown) => shown.push([t, e, x]) },
    sleep: async () => {},
    click: (el: Element) => (el as HTMLElement).click(),
    openConversation: async (c: { conversationId: string }) => {
      open = c.conversationId;
      opened.push(c.conversationId);
    },
    returnToList: async () => true,
    readImage: async () => ({ mimeType: "image/jpeg", base64: "AAAA" }),
    extract: () => ({
      conversationId: open,
      title: open,
      messages: [{
        msgId: "m1", direction: "inbound", sender: "x", text: "hi", sentAt: new Date(NOW - DAY).toISOString(),
        transport: "rcs", imageSrcs: ["blob:x"], files: [],
        reactions: [{ emoji: "x", reactor: "me", word: "" }, { emoji: "y", reactor: "them", word: "" }],
      }],
      skipped: { noDate: 0, noText: 0 },
    }),
    visibility: opts.visibility,
    scan: {
      ...scan,
      readParticipantsAndClose: async () => opts.numbers[open] ?? [],
      waitForMessageSwap: async () => true,
      loadHistory: async (_d: Document, o: { floorMs: number | null }) => {
        floors.push(o.floorMs);
        return { stopReason: opts.historyStop ?? "floor", count: 1 };
      },
      messageIdSet: () => "",
    },
  };
  return { env, calls, shown, opened, floors, since };
}

describe("runJob: a cache Sync", () => {
  const ROWS: Array<[string, string | null]> = [["Zed Example", "3:45 PM"], ["Ann Example", "Mon"], ["Bob Example", "Sep 22"], ["Old Example", "Aug 1"]];

  // SR (3671 P1): one retry per chat for transient failures, at the end of the
  // run, within its own pool. Mutations: no retry → red ("recovered"); the
  // entry kept after recovery → red; the pool unbounded → red ("pool"); a
  // second retry → red ("still failing").
  describe("transient retry (3671 P1)", () => {
    type Env = ReturnType<typeof cacheEnv>;
    const finishBody = (t: Env) => t.calls.find(([, p]) => p.endsWith("/finish"))![2] as {
      notReached: Array<{ name: string; reason: string }>;
      retry: { retried: number; recovered: number; notRetried: number };
    };
    const details = (t: Env) => (t.shown[t.shown.length - 1] as [string, boolean, { details: string }])[2].details;
    /** Opening `ids` throws the first time each is opened (a transient "not opened"). */
    const failFirstOpen = (t: Env, ids: string[]) => {
      const open = t.env.openConversation;
      const tries: Record<string, number> = {};
      t.env.openConversation = async (c: { conversationId: string }) => {
        tries[c.conversationId] = (tries[c.conversationId] || 0) + 1;
        if (ids.includes(c.conversationId) && tries[c.conversationId] === 1) throw Object.assign(new Error("gone"), { code: "not_found" });
        return open(c);
      };
      return tries;
    };

    it("first open fails, the retry succeeds: recovered, no longer \"not fully imported\"", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
      const tries = failFirstOpen(t, [id(0)]);
      await job.runJob(JOB, t.env);
      expect(tries[id(0)]).toBe(2);
      const f = finishBody(t);
      expect(f.retry).toEqual({ retried: 1, recovered: 1, notRetried: 0 });
      expect(f.notReached.some((e) => e.reason === "not_opened")).toBe(false);
      expect(t.calls.filter(([, p]) => p.endsWith("/chat")).length).toBeGreaterThan(0);
      expect(details(t)).toContain("Retried 1 chat, recovered 1");
    });

    // Live (founder, 0.3.80): chat 1's first pass read back 29 days and ended
    // not_settled (239 messages); the end-of-run retry read only 24 days back
    // (166) yet stopped as no_more. Keepr keeps both attempts (staged by
    // message id); the retry must not claim the chat complete.
    // Mutation: the read-less guard removed → red (reachedFloor true, recovered).
    // Founder: ONE line in the Done box when a chat is really not fully
    // synced (history that did not reach its floor); none when all are
    // complete. Mutations: the line not passed / not counted → red.
    describe("the Done box: chats not fully synced", () => {
      const doneExtras = (t: Env) => {
        const last = t.shown[t.shown.length - 1] as [string, boolean, { notFullyLine?: string }];
        expect(last[0]).toBe(job.DONE_LINE);
        return last[2];
      };
      it("a chat that did not reach its floor: \"1 chat not fully synced. Sync again to finish.\"", async () => {
        const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
        (t.env.scan as Record<string, unknown>).loadHistory = async () => ({ stopReason: "not_settled", count: 3, elapsedMs: 1000, idleMs: 0 });
        (t.env as Record<string, unknown>).transientRetryPoolMs = 0;
        await job.runJob(JOB, t.env);
        expect(doneExtras(t).notFullyLine).toBe("1 chat not fully synced. Sync again to finish.");
      });
      it("every chat complete (date_floor): no line", async () => {
        const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
        (t.env.scan as Record<string, unknown>).loadHistory = async () => ({ stopReason: "date_floor", count: 3, elapsedMs: 1000, idleMs: 0 });
        await job.runJob(JOB, t.env);
        expect(doneExtras(t).notFullyLine).toBe("");
      });
      it("the plural", () => {
        expect(job.notFullySyncedLine(0)).toBe("");
        expect(job.notFullySyncedLine(3)).toBe("3 chats not fully synced. Sync again to finish.");
      });
    });

    describe("a retry that reads less far back (live)", () => {
      const msg = (n: number, daysAgo: number) => ({
        msgId: "m" + n, direction: "inbound", sender: "x", text: "t", sentAt: new Date(NOW - daysAgo * DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [],
      });
      const run = async (retryOldestDays: number) => {
        const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
        let loads = 0;
        (t.env.scan as Record<string, unknown>).loadHistory = async () => {
          loads += 1;
          return loads === 1
            ? { stopReason: "not_settled", count: 3, elapsedMs: 61_000, idleMs: 0 }
            : { stopReason: "no_more", count: 2, elapsedMs: 4_000, idleMs: 4_000 };
        };
        (t.env as Record<string, unknown>).extract = () => ({
          conversationId: id(0), title: "x", skipped: { noDate: 0, noText: 0 },
          messages: loads === 1 ? [msg(1, 29), msg(2, 10), msg(3, 1)] : [msg(4, retryOldestDays), msg(3, 1)],
        });
        await job.runJob(JOB, t.env);
        const chats = t.calls.filter(([, p]) => p.endsWith("/chat")).map(([, , b]) => b as { reachedFloor: boolean; messages: unknown[] });
        return { t, loads, chats };
      };

      it("read less: not marked complete; still \"not fully imported\"; both attempts sent", async () => {
        const { t, loads, chats } = await run(24);
        expect(loads).toBe(2);
        expect(chats.map((c) => c.reachedFloor)).toEqual([false, false]);
        expect(chats.map((c) => c.messages.length)).toEqual([3, 2]);
        const f = finishBody(t);
        expect(f.retry).toEqual({ retried: 1, recovered: 0, notRetried: 0 });
        expect(f.notReached.some((e) => e.reason === "history_not_settled")).toBe(true);
      });

      it("read further back: believed — complete and recovered", async () => {
        const { t, chats } = await run(31);
        expect(chats.map((c) => c.reachedFloor)).toEqual([false, true]);
        expect(finishBody(t).retry).toEqual({ retried: 1, recovered: 1, notRetried: 0 });
      });
    });

    it("messages that did not load the first time are read on the retry", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
      let swaps = 0;
      (t.env.scan as Record<string, unknown>).waitForMessageSwap = async () => (++swaps === 1 ? false : true);
      await job.runJob(JOB, t.env);
      expect(finishBody(t).retry).toMatchObject({ retried: 1, recovered: 1 });
      expect(finishBody(t).notReached.some((e) => e.reason === "messages_not_loaded")).toBe(false);
    });

    it("still failing on the retry: left out as before, never a second retry", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
      const open = t.env.openConversation;
      let opens = 0;
      t.env.openConversation = async (c: { conversationId: string }) => {
        if (c.conversationId === id(0)) {
          opens += 1;
          throw Object.assign(new Error("gone"), { code: "not_found" });
        }
        return open(c);
      };
      await job.runJob(JOB, t.env);
      expect(opens).toBe(2);
      expect(finishBody(t).retry).toEqual({ retried: 1, recovered: 0, notRetried: 0 });
      expect(finishBody(t).notReached.filter((e) => e.reason === "not_opened")).toHaveLength(1);
    });

    it("the retry has its own pool: past it, chats are not retried and stay left out", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] } });
      (t.env as Record<string, unknown>).transientRetryPoolMs = 500;
      failFirstOpen(t, [id(0), id(1)]);
      await job.runJob(JOB, t.env);
      const f = finishBody(t);
      expect(f.retry).toEqual({ retried: 1, recovered: 1, notRetried: 1 });
      expect(f.notReached.filter((e) => e.reason === "not_opened")).toHaveLength(1);
      expect(details(t)).toContain("1 not retried (time limit)");
    });

    it("a retried chat already sent is not counted twice", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
      let loads = 0;
      (t.env.scan as Record<string, unknown>).loadHistory = async () => ({
        stopReason: ++loads === 1 ? "not_settled" : "no_more", count: 1, scrolls: 0, nudges: 0, confirmedBy: "first_page",
      });
      await job.runJob(JOB, t.env);
      const f = t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { chats: number; messages: number; retry: Record<string, number> };
      expect(f.retry).toMatchObject({ retried: 1, recovered: 1 });
      expect(f.chats).toBe(1);
      expect(f.messages).toBe(1);
    });

    it("the pool is 5 minutes", () => {
      expect(job.RCS_TRANSIENT_RETRY_POOL_MS).toBe(5 * 60000);
    });
  });

  // SR M: media. Every photo / video bubble counted against what was saved.
  // Mutations: keepPhotos ignored → red ("not kept"); no end-of-run retry →
  // red ("recovered"); the retry pool unbounded → red ("pool"); a too-large
  // photo uploaded → red; videos counted as saved / not counted → red.
  describe("media (SR M)", () => {
    type Env = ReturnType<typeof cacheEnv>;
    const media = (t: Env) =>
      (t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { media: Record<string, Record<string, number>> }).media;
    const details = (t: Env) => (t.shown[t.shown.length - 1] as [string, boolean, { details: string }])[2].details;
    const withMatch = (t: Env, body: Record<string, unknown>) => {
      const api = t.env.api;
      t.env.api = async (m: string, p: string, b?: Record<string, unknown>) =>
        p.endsWith("/match") ? (t.calls.push([m, p, b]), { ok: true, status: 200, body: { matched: true, ...body } }) : api(m, p, b);
    };
    const oneChat = () => cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });

    it("photos not kept for this chat: counted, none sent", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: false, keepVideos: false });
      await job.runJob(JOB, t.env);
      expect(t.calls.some(([, p]) => p.endsWith("/attachment"))).toBe(false);
      expect(media(t).photos).toMatchObject({ seen: 1, saved: 0, notKept: 1 });
    });

    it("photos kept (all chats): saved and shown as \"Photos: N saved\"", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      await job.runJob(JOB, t.env);
      expect(media(t).photos).toMatchObject({ seen: 1, saved: 1 });
      expect(details(t)).toContain("Photos: 1 saved");
    });

    // Live A/B (visible vs hidden tab): one timing line per chat + one photo
    // line — ms only, no PII — and the run totals in /finish metrics.
    // Mutations: a step not timed, p50 as the mean, totals not summed → red.
    it("per-chat timing: one line per chat, one photo line, run totals in the metrics", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      let clock = NOW;
      const lines: string[] = [];
      const e = t.env as Record<string, unknown>;
      e.now = () => new Date(clock);
      e.log = (l: string) => lines.push(l);
      e.extract = () => ({
        conversationId: id(0), title: "Pat Example", skipped: { noDate: 0, noText: 0 },
        messages: [{ msgId: "m1", direction: "inbound", sender: "Pat Example", text: "hello there", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: ["blob:a", "blob:b", "blob:c"], files: [] }],
      });
      const reads = [100, 500, 200]; // p50 200 ≠ mean 267
      let r = 0;
      e.readImage = async () => { clock += reads[r++ % 3]; return { mimeType: "image/jpeg", base64: "AAAA" }; };
      const scanIo = t.env.scan as Record<string, (...a: unknown[]) => unknown>;
      const wrap = (name: string, ms: number) => {
        const orig = scanIo[name];
        scanIo[name] = async (...a: unknown[]) => { const v = await orig(...a); clock += ms; return v; };
      };
      wrap("readParticipantsAndClose", 700);
      wrap("loadHistory", 2000);
      wrap("waitForMessageSwap", 500);
      const api = t.env.api;
      t.env.api = async (m: string, p: string, b?: Record<string, unknown>) => {
        const v = await api(m, p, b);
        if (p.endsWith("/attachment")) clock += 40;
        if (p.endsWith("/chat")) clock += 60;
        return v;
      };
      await job.runJob(JOB, t.env);
      const timing = lines.filter((l) => l.startsWith("  timing:"));
      // One line per chat opened (the others are left out after Details).
      expect(timing).toHaveLength(3);
      expect(timing[1]).toMatch(/details 700 · history 0 · settle 0 · commit 0 · hidden 0$/);
      expect(timing[0]).toMatch(/details 700 · history 2000 · settle 500 · commit 60 · hidden 0$/);
      expect(lines.filter((l) => l.startsWith("  photos:"))).toEqual([
        "  photos: 3 · read total 800 max 500 p50 200 · upload total 120 max 40 p50 40",
      ]);
      // No PII in the timing lines.
      for (const l of lines.filter((x) => /^  (timing|photos):/.test(x))) expect(l).not.toMatch(/Pat|hello|5555/);
      const fin = t.calls.find(([, p]) => p.endsWith("/finish"));
      expect((fin?.[2] as { metrics: { reading: Record<string, number> } }).metrics.reading).toMatchObject({
        detailsMs: 2100, historyMs: 2000, settleMs: 500, commitMs: 60, // details: 3 chats × 700
        photoReadMs: 800, photoUploadMs: 120, photoReadMaxMs: 500, photoUploadMaxMs: 40,
      });
    });

    // SR C5: Keepr's rate limit (429) is back-off-and-retry — never a failed
    // chat. A 300-photo chat with every third image answered 429 first.
    // Mutations: 429 not retried → red (photos failed); no wait → red.
    it("a 300-photo chat under Keepr's rate limit: waits, resends, all 300 saved, the chat not failed", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      const srcs = Array.from({ length: 300 }, (_v, i) => "blob:p" + i);
      (t.env as Record<string, unknown>).extract = () => ({
        conversationId: id(0), title: "x", skipped: { noDate: 0, noText: 0 },
        messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: srcs, files: [] }],
      });
      const base = t.env.api;
      let attachments = 0;
      t.env.api = async (method: string, p: string, body?: Record<string, unknown>) => {
        if (p.endsWith("/attachment")) {
          attachments += 1;
          if (attachments % 3 === 1) {
            t.calls.push([method, p, body]);
            return { ok: false, status: 429, body: { error: "rate_limited", retryAfterMs: 1000 } } as never;
          }
        }
        return base(method, p, body);
      };
      const waits: number[] = [];
      t.env.sleep = async (ms?: number) => {
        waits.push(Number(ms));
      };
      await job.runJob(JOB, t.env);
      expect(media(t).photos).toMatchObject({ seen: 300, saved: 300, failed: 0 });
      expect(waits.filter((w) => w === 1000).length).toBe(150); // 150 s: inside the run's 5-minute budget
      expect(t.calls.filter(([, p]) => p.endsWith("/chat"))).toHaveLength(1);
      const finish = t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { notReached?: Array<{ name: string }> };
      // The photo chat (the only one with numbers) is not among the chats not reached.
      expect((finish.notReached ?? []).map((n) => n.name)).not.toContain(ROWS[0][0]);
    });

    // SR (C5 review): the 429 waits of one run share a 5-minute budget; past
    // it the run fails as keepr_busy — Keepr told, the short line on the card.
    // Mutations: no budget (waits forever) → red; the busy error swallowed as
    // a photo failure → red.
    it("Keepr answering 429 past the run's 5-minute wait budget: the run fails as keepr_busy", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      const base = t.env.api;
      t.env.api = async (method: string, p: string, body?: Record<string, unknown>) => {
        if (p.endsWith("/attachment")) {
          t.calls.push([method, p, body]);
          return { ok: false, status: 429, body: { error: "rate_limited", retryAfterMs: 60000 } } as never;
        }
        return base(method, p, body);
      };
      const waits: number[] = [];
      t.env.sleep = async (ms?: number) => {
        waits.push(Number(ms));
      };
      const outcome = await job.runJob(JOB, t.env);
      expect(outcome).toEqual({ outcome: "keepr_busy" });
      expect(waits.filter((w) => w === 60000)).toHaveLength(5); // 5 × 1 min = the budget; the 6th is refused
      const err = t.calls.find(([, p]) => p.endsWith("/error"));
      expect(err?.[2]).toMatchObject({ code: "keepr_busy" });
      expect(t.shown[t.shown.length - 1][0]).toBe("Keepr is busy. Try again.");
      expect(t.calls.some(([, p]) => p.endsWith("/finish"))).toBe(false);
    });

    it("a photo that didn't load is retried at the end and recovered", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      const notLoaded = { msgId: "m1", direction: "inbound", sender: "x", text: "", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [{ name: "image (not loaded)", size: "" }] };
      (t.env as Record<string, unknown>).extract = () => ({ conversationId: id(0), title: "x", messages: [notLoaded], skipped: { noDate: 0, noText: 0 } });
      let loads = 0;
      (t.env.scan as Record<string, unknown>).loadHistory = async () => {
        loads += 1;
        return loads === 1
          ? { stopReason: "no_more", count: 1, scrolls: 0, nudges: 0 }
          : { stopReason: "no_more", count: 1, scrolls: 0, nudges: 0, elapsedMs: 3000, messages: [{ ...notLoaded, imageSrcs: ["blob:y"] }] };
      };
      await job.runJob(JOB, t.env);
      expect(loads).toBe(2);
      expect(media(t).photos).toMatchObject({ seen: 1, saved: 1, notLoaded: 0, recovered: 1 });
      expect(details(t)).toContain("Photos: 1 saved");
      expect(details(t)).not.toContain("didn't load");
    });

    it("the retry has its own bounded pool: past it, photos stay \"didn't load\"", async () => {
      const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] } });
      withMatch(t, { keepPhotos: true });
      (t.env as Record<string, unknown>).mediaRetryPoolMs = 2500;
      const nl = (c: string) => ({ msgId: "m-" + c, direction: "inbound", sender: "x", text: "", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [{ name: "image (not loaded)", size: "" }] });
      let current = "";
      const open = t.env.openConversation;
      t.env.openConversation = async (c: { conversationId: string }) => {
        current = c.conversationId;
        return open(c);
      };
      (t.env as Record<string, unknown>).extract = () => ({ conversationId: current, title: "x", messages: [nl(current)], skipped: { noDate: 0, noText: 0 } });
      let retries = 0;
      let main = 0;
      (t.env.scan as Record<string, unknown>).loadHistory = async (_d: unknown, io: { imagePass?: boolean; extensionPoolLeftMs?: number }) => {
        if (main < 2) {
          main += 1;
          return { stopReason: "no_more", count: 1, scrolls: 0, nudges: 0 };
        }
        retries += 1;
        return { stopReason: "not_settled", count: 1, scrolls: 0, nudges: 0, elapsedMs: 3000, messages: [] };
      };
      await job.runJob(JOB, t.env);
      expect(retries).toBe(1); // 1 s open + 3 s load > the 2.5 s pool: the second chat is not tried
      expect(media(t).photos).toMatchObject({ seen: 2, saved: 0, notLoaded: 2 });
      expect(details(t)).toContain("Photos: 0 saved · 2 couldn't download (2 didn't load)");
    });

    it("a photo over 25 MB is not sent and counts as too large", async () => {
      const t = oneChat();
      withMatch(t, { keepPhotos: true });
      t.env.readImage = async () => ({ mimeType: "image/jpeg", base64: "A".repeat(Math.ceil((job.RCS_MAX_PHOTO_BYTES * 4) / 3) + 8) });
      await job.runJob(JOB, t.env);
      expect(t.calls.some(([, p]) => p.endsWith("/attachment"))).toBe(false);
      expect(media(t).photos).toMatchObject({ tooLarge: 1, saved: 0 });
      expect(details(t)).toContain("1 too large");
    });

    it("videos: counted; not downloaded yet when kept (not supported), not kept when off", async () => {
      const video = { msgId: "v1", direction: "inbound", sender: "x", text: "", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [{ name: "clip_01.mp4", size: "" }] };
      const on = oneChat();
      withMatch(on, { keepPhotos: true, keepVideos: true });
      (on.env as Record<string, unknown>).extract = () => ({ conversationId: id(0), title: "x", messages: [video], skipped: { noDate: 0, noText: 0 } });
      await job.runJob(JOB, on.env);
      expect(media(on).videos).toEqual({ seen: 1, saved: 0, notKept: 0, notSupported: 1 });
      expect(details(on)).toContain("Videos: 0 saved · 1 couldn't download (1 not supported yet)");
      const off = oneChat();
      withMatch(off, { keepPhotos: true, keepVideos: false });
      (off.env as Record<string, unknown>).extract = on.env.extract;
      await job.runJob(JOB, off.env);
      expect(media(off).videos).toEqual({ seen: 1, saved: 0, notKept: 1, notSupported: 0 });
      expect(details(off)).not.toContain("Videos:");
    });

    it("caps and pool are constants", () => {
      expect(job.RCS_MAX_PHOTO_BYTES).toBe(25 * 1024 * 1024);
      expect(job.RCS_MAX_VIDEO_BYTES).toBe(200 * 1024 * 1024);
      expect(job.RCS_MEDIA_RETRY_POOL_MS).toBe(5 * 60000);
    });
  });

  it("checks every chat above the cutoff, in list order (no names); no number → no_numbers (M3, M4)", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(2)]: ["+15555550102"] } });
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(t.opened).toEqual([id(0), id(1), id(2)]);
    expect(t.calls.filter(([, p]) => p.endsWith("/match")).map(([, , b]) => b?.conversationId)).toEqual([id(0), id(2)]);
    expect(outcome.notReached).toEqual([{ name: "Ann Example", reason: "no_numbers" }]);
    const finish = t.calls.find(([, p]) => p.endsWith("/finish"));
    expect(finish?.[2]).toMatchObject({ chats: 2, notChecked: 0 });
  });

  // Founder (2026-10-01): the done details show what Keepr SAVED (its /finish
  // answer), checked / matched only in Copy details. Mutation M10: the page's
  // own sent counts on screen, or checked/matched left on screen → red.
  it("done details: what Keepr saved; checked / matched in Copy only (M10)", async () => {
    const t = cacheEnv({
      rows: ROWS,
      numbers: { [id(0)]: ["+15555550101"], [id(2)]: ["+15555550102"] },
      finishReply: { ok: true, saved: { chats: 1, messages: 1, newMessages: 1, reactions: 2, newReactions: 1 } },
    });
    await job.runJob(JOB, t.env);
    const finishAt = t.calls.findIndex(([, p]) => p.endsWith("/finish"));
    expect(finishAt).toBeGreaterThan(-1);
    expect(t.shown.some(([text]) => text === "Saving to Keepr")).toBe(true);
    const [text, , extras] = t.shown[t.shown.length - 1] as [string, boolean, { details: string; copy: string }];
    expect(text).toBe(job.DONE_LINE);
    expect(extras.details.split("\n")[0]).toBe("Scanned 4 chats · saved 1 chat · 1 message (1 new) · 2 reactions (1 new)");
    expect(extras.details).not.toMatch(/matched|checked/);
    // #14: per-chat reaction counts in the step log, the sum in Copy details.
    // Mutation: reactions not counted → red.
    expect(extras.copy).toContain("Checked 3 · matched 2 · sent 2 chats / 2 messages / 4 reactions");
    expect(extras.copy).toMatch(/imported 1 messages, 2 reactions \(history stop/);
  });

  it("done details when Keepr's save failed, or had not answered", async () => {
    const failed = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] }, finishReply: { ok: true, saved: null } });
    await job.runJob(JOB, failed.env);
    const last = failed.shown[failed.shown.length - 1] as [string, boolean, { details: string }];
    expect(last[2].details).toContain("Keepr could not save this Sync — nothing was imported");
    const slow = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] }, finishReply: { ok: true } });
    await job.runJob(JOB, slow.env);
    const lastSlow = slow.shown[slow.shown.length - 1] as [string, boolean, { details: string }];
    expect(lastSlow[2].details).toContain("Keepr is still saving — see Keepr for the result");
  });

  // Live (2026-10-05): Google's backend stopped answering (no banner): chats
  // whose history stopped growing, back to back, for 5 minutes in all → the
  // run fails as google_unresponsive ("Google Messages stopped responding."),
  // never waiting forever. Mutation: the run limit removed → red.
  it("chats with no new messages for 5 minutes in all: the run fails as google_unresponsive", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    (t.env.scan as Record<string, unknown>).loadHistory = async () => ({
      stopReason: "not_settled", count: 0, scrolls: 0, nudges: 0, elapsedMs: 160_000, idleMs: 160_000, noProgress: true,
    });
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome).toEqual({ outcome: "google_unresponsive" });
    expect(t.calls.filter(([, p]) => p.endsWith("/match"))).toHaveLength(2); // 2 × 160 s ≥ 5 min: chat 3 never opened
    expect(t.calls.find(([, p]) => p.endsWith("/error"))?.[2]).toMatchObject({ code: "google_unresponsive" });
    expect(t.shown[t.shown.length - 1][0]).toBe("Google Messages stopped responding.");
  });

  // SR F1: a healthy short chat confirmed at its start has idleMs == elapsedMs
  // (its confirm wait) — it must never count towards "no progress". Before
  // the fix, ~40–80 such chats (or 4 slow ones here, 100 s each) added up
  // to a false google_unresponsive. Mutation: confirmed chats counted → red.
  it("short chats that confirmed their start never add up to google_unresponsive (SR F1)", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"], [id(3)]: ["+15555550104"] } });
    const confirmed = [
      { stopReason: "no_more", confirmedBy: "first_page", count: 3, elapsedMs: 100_000, idleMs: 100_000 },
      { stopReason: "date_floor", count: 5, elapsedMs: 100_000, idleMs: 100_000 },
      { stopReason: "no_more", confirmedBy: "marker", count: 2, elapsedMs: 100_000, idleMs: 100_000 },
      { stopReason: "cap", count: 2000, elapsedMs: 100_000, idleMs: 100_000 },
    ];
    let n = 0;
    (t.env.scan as Record<string, unknown>).loadHistory = async () => confirmed[n++ % confirmed.length];
    expect((await job.runJob(JOB, t.env)).outcome).toBe("finished");
  });

  it("a chat that loaded something restarts the count: no failure for one idle chat after a growing one", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] } });
    const stops = [
      { stopReason: "not_settled", count: 0, elapsedMs: 250_000, idleMs: 250_000, noProgress: true },
      { stopReason: "not_settled", count: 2000, batches: 12, elapsedMs: 200_000, idleMs: 80_000, noProgress: true }, // loaded batches: restarts (250 + 80 s would pass 5 min)
    ];
    let n = 0;
    (t.env.scan as Record<string, unknown>).loadHistory = async () => stops[n++];
    expect((await job.runJob(JOB, t.env)).outcome).toBe("finished");
  });

  // Live (2026-10-05): Keepr's card showed "Reading chat 1 of 4" while a later
  // chat loaded only its first page — each chat's start now posts its line.
  // Mutation: no /progress at a chat's start → red.
  it("each chat's start tells Keepr its line ('Reading chat N of M')", async () => {
    // Chat 1 is skipped (no end-of-chat progress): only chat 2's start can post its line.
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] }, matchSkip: [id(0)] });
    await job.runJob(JOB, t.env);
    const stages = t.calls.filter(([, p]) => p.endsWith("/progress")).map(([, , b]) => String(b?.stage));
    const chat2 = stages.findIndex((st) => /chat 2 of/.test(st));
    const match2 = t.calls.findIndex(([, p, b]) => p.endsWith("/match") && b?.conversationId === id(1));
    const progressIdx = t.calls.findIndex(([, p, b]) => p.endsWith("/progress") && /chat 2 of/.test(String(b?.stage)));
    expect(chat2).toBeGreaterThanOrEqual(0);
    expect(progressIdx).toBeLessThan(match2);
  });

  // 3671 history depth: per chat "oldest read: N days ago (floor N days)",
  // and a "History depth" summary — counts and day numbers only. Mutation:
  // the depth not counted / the line missing → red.
  it("history depth: oldest read per chat in days, and the summary line (counts only)", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    const stops = [
      { stopReason: "date_floor", count: 1, scrolls: 1, nudges: 0, elapsedMs: 95_400, batches: 12, budgetExtensions: 2 },
      { stopReason: "no_more", count: 1, scrolls: 0, nudges: 0, confirmedBy: "first_page" },
      { stopReason: "history_gap", count: 1, scrolls: 2, nudges: 0, gapsDetected: 1, gapsRecovered: 0 },
    ];
    let n = 0;
    (t.env.scan as Record<string, unknown>).loadHistory = async () => stops[n++];
    await job.runJob(JOB, t.env);
    const [, , extras] = t.shown[t.shown.length - 1] as [string, boolean, { details: string; copy: string }];
    expect(extras.copy).toContain("oldest read: 1 days ago (floor 10 days)");
    // Per-chat load time and batches; date_floor counts as confirmed coverage.
    expect(extras.copy).toContain("load 95s, batches 12, budget extended 2×");
    expect(extras.copy).toContain("start confirmed by date_floor");
    expect(extras.details).toContain(" · 0 without scrolling · 1 reached the months limit · 1 not confirmed");
    expect(extras.details).toContain(
      "History depth: 1 chats reached the 10-day limit · 1 reached the chat's start · 1 not fully loaded · 1 gaps (0 recovered)",
    );
    expect(extras.copy).toContain("gaps 1 detected / 0 recovered");
  });

  // SR: one pool of extra history time per RUN (30 min). Each chat is given
  // what is left; once spent, chats get the base budget only. Shown in the
  // step log and the done details. Mutations: the used time not subtracted →
  // red; the details line missing → red.
  it("the extra-time pool is shared by the run's chats and shown when used", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    const stops = [
      { stopReason: "no_more", count: 1, scrolls: 3, nudges: 0, extraMs: 1_200_000 },
      { stopReason: "not_settled", count: 1, scrolls: 9, nudges: 0, extraMs: 600_000, poolExhausted: true },
      { stopReason: "not_settled", count: 1, scrolls: 2, nudges: 0, poolExhausted: true },
    ];
    const poolLeft: Array<number | undefined> = [];
    let n = 0;
    (t.env.scan as Record<string, unknown>).loadHistory = async (_doc: unknown, io: { extensionPoolLeftMs?: number }) => {
      poolLeft.push(io.extensionPoolLeftMs);
      return stops[n++];
    };
    // The transient retry has its own tests (retry-3671); none here.
    (t.env as Record<string, unknown>).transientRetryPoolMs = 0;
    await job.runJob(JOB, t.env);
    expect(poolLeft).toEqual([1_800_000, 600_000, 0]);
    const [, , extras] = t.shown[t.shown.length - 1] as [string, boolean, { details: string; copy: string }];
    expect(extras.copy).toContain("extra time used up");
    expect(extras.copy).toContain("extra time used: 30 min of 30");
    expect(extras.details).toContain("Extra time used: 30 min of 30");
  });

  it("no extra time used: no extra-time line", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    (t.env.scan as Record<string, unknown>).loadHistory = async () => ({ stopReason: "no_more", count: 1, scrolls: 0, nudges: 0 });
    await job.runJob(JOB, t.env);
    const [, , extras] = t.shown[t.shown.length - 1] as [string, boolean, { details: string; copy: string }];
    expect(extras.details).not.toContain("Extra time used");
  });

  // History v2: the image pass only where Keepr keeps the images.
  // Mutation: imagePass always on → red.
  it("image pass only for chats whose images Keepr keeps (/match keepImages)", async () => {
    for (const keep of [true, false]) {
      const t = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] }, keepImages: keep });
      const seen: unknown[] = [];
      const inner = (t.env.scan as Record<string, any>).loadHistory; // eslint-disable-line @typescript-eslint/no-explicit-any
      (t.env.scan as Record<string, unknown>).loadHistory = async (d: Document, o: { imagePass?: boolean }) => {
        seen.push(o.imagePass);
        return inner(d, o);
      };
      await job.runJob(JOB, t.env);
      expect(seen).toEqual([keep]);
    }
  });

  // Live (0.3.15): chats switched back on have no new message — they are
  // candidates anyway, read to the FULL floor. Mutations: not a candidate /
  // read only to since / the list scan stopping at since → red.
  it("a chat switched back on: a candidate though older than since, read to the full floor", async () => {
    const floor = new Date(NOW - 90 * DAY).toISOString();
    const t = cacheEnv({
      rows: ROWS,
      numbers: { [id(0)]: ["+15555550101"], [id(3)]: ["+15555550104"] },
      claimExtra: { pendingConversationIds: [id(3)], floor },
    });
    await job.runJob(JOB, t.env);
    // SR F1: checked FIRST, and read to the full floor; the others to since.
    expect(t.opened[0]).toBe(id(3));
    expect(t.floors[0]).toBe(Date.parse(floor));
    expect(t.floors.slice(1).every((f) => f === Date.parse(t.since))).toBe(true);
  });

  it("the list scan goes on past since until it has seen the chats switched back on", async () => {
    const rows: Array<[string, string | null]> = [["A", "3:45 PM"], ["B", "Aug 10"], ["C", "Aug 5"], ["D", "Aug 1"], ["E", "Jul 30"]];
    const read = async (mustSee: string[]) => {
      let shown = 2;
      renderList(rows.slice(0, shown));
      return scan.collectConversations(document, {
        sleep: async () => {},
        now: () => NOW,
        // A virtualized list: one more row per scroll step.
        scroll: async () => {
          if (shown < rows.length) renderList(rows.slice(0, ++shown));
        },
        stopAtOlderThanMs: NOW - 10 * DAY,
        mustSee,
        mustSeeFloorMs: NOW - 90 * DAY,
      });
    };
    const ids = (out: { conversations: Array<{ conversationId: string }> }) => out.conversations.map((c) => c.conversationId);
    expect(ids(await read([]))).not.toContain(id(3)); // stops at since
    expect(ids(await read([id(3)]))).toContain(id(3)); // goes on until it has seen it
  });

  // SR (2026-10-02): per-chat widening for deals. Mutations: /match floorMs
  // ignored → red; applied to every chat → red; deal chats not queued after
  // the pending ones and before the rest → red; mustSeeDeep not passed to the
  // list scan → red; /chat without reachedFloor (or true after a cap) → red.
  // 3671 P3 "Try again": a chat Keepr says the failed run saved is skipped
  // (no history read, no /chat) and counted. Mutation: skip ignored → red.
  it("Try again: a chat the failed run already saved is skipped and counted", async () => {
    const t = cacheEnv({
      rows: ROWS,
      numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] },
      matchSkip: [id(0)],
    });
    await job.runJob(JOB, t.env);
    expect(t.floors).toHaveLength(1);
    const chats = t.calls.filter(([, p]) => p.endsWith("/chat")).map(([, , b]) => b!.conversationId);
    expect(chats).toEqual([id(1)]);
    const fin = t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { alreadySaved: number };
    expect(fin.alreadySaved).toBe(1);
  });

  describe("deal chats (SR 2026-10-02)", () => {
    const JAN = new Date(2026, 0, 10).getTime();

    it("/match floorMs: that chat reads back to it; the others keep the job's floor", async () => {
      const t = cacheEnv({
        rows: ROWS,
        numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"] },
        matchFloor: { [id(1)]: JAN },
      });
      await job.runJob(JOB, t.env);
      expect(t.opened.slice(0, 2)).toEqual([id(0), id(1)]);
      expect(t.floors).toEqual([Date.parse(t.since), JAN]);
    });

    it("/chat says whether the chat was read down to its floor (a boolean)", async () => {
      const bodies = async (historyStop: string) => {
        const t = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] }, historyStop });
        await job.runJob(JOB, t.env);
        return t.calls.filter(([, p]) => p.endsWith("/chat")).map(([, , b]) => b!.reachedFloor);
      };
      expect(await bodies("date_floor")).toEqual([true]);
      expect(await bodies("no_more")).toEqual([true]);
      expect(await bodies("cap")).toEqual([false]);
      // (a not-settled chat is retried once at the end: false both times)
      expect(new Set(await bodies("not_settled"))).toEqual(new Set([false]));
      expect(await bodies("history_gap")).toEqual([false]);
    });

    it("the claim's deal chats: looked for past the settings floor (never past the oldest deal start), queued after pending, before the rest", async () => {
      const floor = new Date(NOW - 90 * DAY).toISOString();
      const t = cacheEnv({
        rows: ROWS,
        numbers: { [id(0)]: ["+15555550101"], [id(2)]: ["+15555550103"], [id(3)]: ["+15555550104"] },
        claimExtra: { pendingConversationIds: [id(2)], floor, dealConversationIds: [id(3)], dealFloor: new Date(JAN).toISOString() },
        matchFloor: { [id(3)]: JAN },
      });
      const seen: Array<Record<string, unknown>> = [];
      (t.env as Record<string, unknown>).scan = {
        ...t.env.scan,
        collectConversations: (d: Document, o: Record<string, unknown>) => {
          seen.push(o);
          return scan.collectConversations(d, o);
        },
      };
      await job.runJob(JOB, t.env);
      expect(seen[0]).toMatchObject({ mustSee: [id(2)], mustSeeFloorMs: Date.parse(floor), mustSeeDeep: [id(3)], mustSeeDeepFloorMs: JAN });
      expect(t.opened.slice(0, 3)).toEqual([id(2), id(3), id(0)]);
      expect(t.floors.slice(0, 2)).toEqual([Date.parse(floor), JAN]);
    });

    it("the list scan: deal chats past the settings floor are looked for, never past the oldest deal start", async () => {
      const rows: Array<[string, string | null]> = [["A", "3:45 PM"], ["B", "Aug 10"], ["C", "Aug 5"], ["D", "Jun 1"], ["E", "May 30"], ["F", "Mar 1"], ["G", "Feb 27"], ["H", "Feb 20"]];
      const read = async (deep: string[], deepFloor: number | null) => {
        let shown = 2;
        renderList(rows.slice(0, shown));
        return scan.collectConversations(document, {
          sleep: async () => {},
          now: () => NOW,
          scroll: async () => {
            if (shown < rows.length) renderList(rows.slice(0, ++shown));
          },
          stopAtOlderThanMs: NOW - 10 * DAY,
          mustSee: [],
          mustSeeFloorMs: NOW - 90 * DAY,
          mustSeeDeep: deep,
          mustSeeDeepFloorMs: deepFloor,
        });
      };
      const ids = (out: { conversations: Array<{ conversationId: string }> }) => out.conversations.map((c) => c.conversationId);
      expect(ids(await read([], null))).not.toContain(id(4)); // stops at since
      // A deal chat from June, the deal from April: found.
      expect(ids(await read([id(4)], new Date(2026, 3, 1).getTime()))).toContain(id(4));
      // A deal chat older than the oldest deal start: never read that far (two older rows end it, at G).
      const tooOld = ids(await read([id(7)], new Date(2026, 3, 1).getTime()));
      expect(tooOld).toContain(id(6));
      expect(tooOld).not.toContain(id(7));
      // Without a deep floor the list is never read past the settings floor for them.
      expect(ids(await read([id(4)], null))).not.toContain(id(4));
    });
  });

  it("the history floor is since, not a transaction start date (M7)", async () => {
    const t = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] } });
    await job.runJob(JOB, t.env);
    expect(t.floors).toEqual([Date.parse(t.since)]);
  });

  // Founder (P01–P03): walk EVERY card the run shows. Each running card has
  // the run's state: the line is one of the three phase lines, the bar never
  // goes back, and rendered it has the bar, the warning and Stop sync.
  // Mutations: a phase showing its own text; the bar going back; Stop sync
  // missing in a phase → red.
  it("every phase of a run: one of the three lines, a monotonic bar, the bar + warning + Stop sync", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(2)]: ["+15555550102"] } });
    await job.runJob(JOB, t.env);
    const running = t.shown.filter(([, , x]) => !!x && (x as { cancel?: boolean }).cancel === true) as Array<[string, boolean, { run: { phase: string; done: number; total: number } }]>;
    expect(running.length).toBeGreaterThan(5);
    const phases = new Set(running.map(([, , x]) => x.run.phase));
    expect(phases).toEqual(new Set(["finding", "reading", "saving"]));
    // P01: the list scan says how many chats it found so far.
    expect(running.some(([text]) => /^Finding your chats · \d+ so far$/.test(text))).toBe(true);
    let lastFrac = -1;
    let lastPhase = "finding";
    const order = ["finding", "reading", "saving"];
    for (const [text, isError, x] of running) {
      expect(isError).toBe(false);
      expect(text).toMatch(/^(Finding your chats( · \d+ so far)?|Reading chat \d+ of \d+( · skipping saved chats)?|Saving to Keepr)$/);
      expect(order.indexOf(x.run.phase)).toBeGreaterThanOrEqual(order.indexOf(lastPhase));
      lastPhase = x.run.phase;
      const frac = job.runFraction(x.run);
      if (frac !== null) {
        expect(frac).toBeGreaterThanOrEqual(lastFrac);
        lastFrac = frac;
      }
      const box = document.createElement("div");
      job.renderOverlay(box, text, false, x, { copy: async () => true, theme: "dark" });
      expect(box.querySelector('[data-keepr="progress"]')!.textContent).toBe(text);
      expect(box.querySelector('[data-keepr="progress-bar"]')).not.toBeNull();
      expect(box.querySelector('[data-keepr="dont-click"]')!.textContent).toBe(job.DONT_CLICK_LINE);
      expect(box.querySelector('[data-keepr="cancel"]')).not.toBeNull();
    }
    expect(lastFrac).toBe(1);
  });

  it("shows 'Reading chat i of N' with Stop sync on progress lines (P02)", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
    await job.runJob(JOB, t.env);
    const stage = t.shown.find(([text]) => text === "Reading chat 1 of 3");
    expect(stage).toBeDefined();
    expect(stage?.[2]).toMatchObject({ cancel: true, run: { phase: "reading", index: 1, total: 3 } });
    expect(t.calls.some(([, p, b]) => p.endsWith("/progress") && b?.stage === "Reading chat 2 of 3")).toBe(true);
  });

  it("an image Keepr does not keep (422 not_a_contact) is counted apart, never 'not fully imported' (M5)", async () => {
    const t = cacheEnv({
      rows: ROWS.slice(0, 1),
      numbers: { [id(0)]: ["+15555550101"] },
      imageReply: { ok: false, status: 422, body: { error: "not_a_contact" } },
    });
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.notReached).toEqual([]);
    expect(outcome.totals).toMatchObject({ imagesNotKept: 1, images: 0 });
    expect(outcome.progress.skipped).toBe(0);
  });

  // Founder (2026-10-03): a hidden tab (another tab, minimized, behind other
  // windows) does NOT pause the run; the time hidden and the history loaded
  // meanwhile are counted, and Chrome must not discard the tab during the run.
  // Mutations: the hidden pause back → red; the telemetry not sent → red;
  // the tab kept discardable / never released → red.
  it("a hidden tab does not pause: every chat is read, the time hidden is counted", async () => {
    let hidden = true;
    let clock = NOW;
    let notify: (h: boolean) => void = () => {};
    const t = cacheEnv({
      rows: ROWS,
      numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550103"] },
      visibility: {
        hidden: () => hidden,
        onChange: (cb: (h: boolean) => void) => {
          notify = cb;
          return () => { notify = () => {}; };
        },
      } as never,
    });
    t.env.now = () => new Date(clock);
    t.env.scan.loadHistory = async (_d: Document, o: { floorMs: number | null }) => {
      t.floors.push(o.floorMs);
      clock += 30_000;
      if (t.floors.length === 2) {
        hidden = false;
        notify(false);
      }
      return { stopReason: "floor", count: 1, batches: 4 };
    };
    const kept: boolean[] = [];
    (t.env as Record<string, unknown>).keepTab = (k: boolean) => void kept.push(k);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(t.opened).toEqual([id(0), id(1), id(2)]);
    expect(t.calls.some(([, p, b]) => p.endsWith("/progress") && b?.stage === job.PAUSED_TEXT)).toBe(false);
    const fin = t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { hidden: Record<string, number> };
    expect(fin.hidden).toEqual({ ms: 60_000, spells: 1, chats: 2, batches: 8 });
    expect(kept).toEqual([true, false]);
  });

  it("the tab is released also when the run ends early (cancelled in Keepr)", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: {} });
    const api = t.env.api;
    t.env.api = async (m: string, p: string, b?: Record<string, unknown>) =>
      p.endsWith("/claim") ? { ok: false, status: 410, body: { error: "job_over" } } : api(m, p, b);
    const kept: boolean[] = [];
    (t.env as Record<string, unknown>).keepTab = (k: boolean) => void kept.push(k);
    await job.runJob(JOB, t.env);
    expect(kept).toEqual([true, false]);
  });

  it("the worker keeps the job's tab from being discarded and puts its setting back", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
    expect(src).toContain("await chrome.tabs.update(tab.id, { autoDiscardable: false });");
    expect(src).toContain("await chrome.tabs.update(tab.id, { autoDiscardable: before });");
    const jobSrc = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    expect(jobSrc).not.toMatch(/whenVisible/);
  });
});

// C5 (founder): a real failure of a cache Sync — "Sync failed · Try again"
// (Keepr saved the chats it finished). Mutations: no retry offered → red; the
// button not asking Keepr → red; Try again on a non-retryable error → red;
// the closed tab not reported → red.
describe("Sync failed · Try again (C5)", () => {
  it("a cache Sync that fails for real offers Try again", async () => {
    const t = cacheEnv({ rows: [["A", "3:45 PM"]], numbers: {} });
    t.env.returnToList = async () => false;
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("list_not_reachable");
    const last = t.shown[t.shown.length - 1] as [string, boolean, { retry?: boolean }];
    expect(last[1]).toBe(true);
    expect(last[2].retry).toBe(true);
  });

  it("the failed box: 'Sync failed', the reason, and Try again asks Keepr", async () => {
    const panel = document.createElement("div");
    const retry = jest.fn(async () => true);
    job.renderOverlay(panel, "Your phone isn't reachable.", true, { details: "x", copy: "y", retry: true }, { copy: async () => true, retry });
    expect(panel.querySelector('[data-keepr="line"]')!.textContent).toBe(job.SYNC_FAILED_TITLE);
    expect(panel.textContent).toContain("Your phone isn't reachable.");
    const button = panel.querySelector('[data-keepr="try-again"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Try again");
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    // Not a retryable failure: no Try again.
    const other = document.createElement("div");
    job.renderOverlay(other, "Keepr refused this sync.", true, { details: "x", copy: "y" }, { copy: async () => true, retry });
    expect(other.querySelector('[data-keepr="try-again"]')).toBeNull();
  });

  it("the tab closed during a Sync is reported to Keepr as page_gone", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    expect(src).toContain('root.addEventListener("pagehide", function () {');
    expect(src).toContain('body: { code: "page_gone", message: PAGE_GONE_MESSAGE, metrics: currentRunMetrics() },');
  });
});

describe("renderOverlay: Cancel (M8)", () => {
  // Founder (2026-10-02): "Stop sync" asks inline first. Mutations: the
  // confirm skipped (one click cancels) → red; "Keep syncing" cancelling → red.
  it("a progress line with {cancel}, expanded: Stop sync asks first, then cancels this job", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const cancel = jest.fn(async () => true);
    let clock = 1_000;
    job.renderOverlay(panel, "Chat 1 of 3…", false, { cancel: true }, { copy: async () => true, cancel, expanded: true, now: () => clock });
    expect(panel.querySelectorAll('[data-keepr="cancel"]')).toHaveLength(1);
    const button = panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Stop sync");
    const confirm = panel.querySelector('[data-keepr="stop-confirm"]') as HTMLElement;
    expect(confirm.style.display).toBe("none");
    button.click();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm.style.display).toBe("flex");
    // The mockup (BoxStopConfirm): the question is the title, the consequence below.
    expect(panel.querySelector('[data-keepr="line"]')!.textContent).toBe(job.STOP_SYNC_TITLE);
    expect(confirm.textContent).toContain("Nothing from this run will be saved.");
    expect((panel.querySelector('[data-keepr="progress"]') as HTMLElement).style.display).toBe("none");
    (panel.querySelector('[data-keepr="stop-no"]') as HTMLButtonElement).click();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm.style.display).toBe("none");
    button.click();
    clock += job.STOP_CONFIRM_ARM_MS;
    const yes = panel.querySelector('[data-keepr="stop-yes"]') as HTMLButtonElement;
    yes.click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(yes.disabled).toBe(true);
    expect(yes.textContent).toBe("Stopping…");
  });

  // SR (f7aaa4486): the box is rebuilt on every progress line. Mutations: the
  // confirm state not kept across renders → red; the 400 ms arm removed → red;
  // the state not cleared when the job ends → red.
  it("the open confirm survives the next progress line and is answered there", () => {
    const panel = document.createElement("div");
    const cancel = jest.fn(async () => true);
    let clock = 5_000;
    const stop = { state: "closed", openedAt: 0 };
    const io = () => ({ copy: async () => true, cancel, expanded: true, now: () => clock, stop });
    job.renderOverlay(panel, "Chat 1 of 3…", false, { cancel: true }, io());
    (panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement).click();
    clock += 1_000;
    job.renderOverlay(panel, "Chat 2 of 3…", false, { cancel: true }, io());
    const confirm = panel.querySelector('[data-keepr="stop-confirm"]') as HTMLElement;
    expect(confirm.style.display).toBe("flex");
    expect((panel.querySelector('[data-keepr="cancel"]') as HTMLElement).style.display).toBe("none");
    (panel.querySelector('[data-keepr="stop-yes"]') as HTMLButtonElement).click();
    expect(cancel).toHaveBeenCalledTimes(1);
    // While stopping, a re-render keeps "Stopping…".
    job.renderOverlay(panel, "Chat 2 of 3…", false, { cancel: true }, io());
    const yes = panel.querySelector('[data-keepr="stop-yes"]') as HTMLButtonElement;
    expect(yes.textContent).toBe("Stopping…");
    expect(yes.disabled).toBe(true);
  });

  // C3 (founder): an unanswered "Stop the sync?" closes itself after 10 s
  // (the sync never paused meanwhile). Mutation: no auto-close → red; it
  // closing a confirm opened again later → red.
  it("the confirm closes itself after 10 s unanswered; a newer one is left open", () => {
    const panel = document.createElement("div");
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const rerender = jest.fn();
    let clock = 5_000;
    const stop = { state: "closed", openedAt: 0 };
    const io = () => ({
      copy: async () => true, cancel: jest.fn(async () => true), expanded: true, now: () => clock, stop, rerender,
      setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
    });
    job.renderOverlay(panel, "Chat 1 of 3…", false, { cancel: true }, io());
    (panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement).click();
    expect(timers.map((t) => t.ms)).toEqual([job.STOP_CONFIRM_AUTO_CLOSE_MS]);
    expect(job.STOP_CONFIRM_AUTO_CLOSE_MS).toBe(10_000);
    timers[0].fn();
    expect(stop.state).toBe("closed");
    expect(rerender).toHaveBeenCalledTimes(1);
    // Opened again: an older timer does not close the newer confirm.
    job.renderOverlay(panel, "Chat 2 of 3…", false, { cancel: true }, io());
    clock += 20_000;
    (panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement).click();
    timers[0].fn();
    expect(stop.state).toBe("open");
  });

  it("a double-click on Stop sync is not a confirm (Stop ignored for 400 ms after opening)", () => {
    const panel = document.createElement("div");
    const cancel = jest.fn(async () => true);
    let clock = 5_000;
    job.renderOverlay(panel, "Chat 1 of 3…", false, { cancel: true }, { copy: async () => true, cancel, expanded: true, now: () => clock });
    (panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement).click();
    const yes = panel.querySelector('[data-keepr="stop-yes"]') as HTMLButtonElement;
    clock += 50;
    yes.click();
    clock += job.STOP_CONFIRM_ARM_MS - 100;
    yes.click();
    expect(cancel).not.toHaveBeenCalled();
    expect(job.STOP_CONFIRM_ARM_MS).toBe(400);
    clock += 100;
    yes.click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("the page keeps the confirm across renders and drops it when the job ends", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8") as string;
    expect(src).toContain("cancel: cancelJob, stop: stopConfirm,");
    expect(src).toContain(`if (!(extras && extras.cancel)) stopConfirm = { state: "closed", openedAt: 0 };`);
  });

  it("the page's stop is a signed job call that says it was the page (ended_by=user_page)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8") as string;
    // A job route (keepr-job-api: always signed by the worker), naming the page as who ended it.
    expect(src).toContain(`type: "keepr-job-api", method: "POST", path: "/job/" + currentJobId + "/cancel", body: { endedBy: "user_page", metrics: currentRunMetrics() }`);
  });

  it("a plain line has no Cancel, collapsed or expanded", () => {
    const panel = document.createElement("div");
    job.renderOverlay(panel, "Loading…", false, undefined, { copy: async () => true });
    expect(panel.querySelector('[data-keepr="cancel"]')).toBeNull();
    job.renderOverlay(panel, "Loading…", false, undefined, { copy: async () => true, expanded: true });
    expect(panel.querySelector('[data-keepr="cancel"]')).toBeNull();
  });
});

// Founder decision (BACKLOG-3658): no Sync button on the page; the extension
// shows nothing when idle. Mutation: bring the button back → red.
describe("no Keepr element on the page when idle", () => {
  it("content.js no longer builds a Sync button or asks for a cache status", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "content.js"), "utf8");
    expect(src).not.toMatch(/Sync to Keepr|keepr-cache-start|keepr-cache-status|cache\/status/);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});

// Founder (2026-10-02): reply-to — a msg-id only on a UNIQUE quoted-text match
// in the same chat, else a snippet (≤80, whitespace collapsed) + me/them.
// Mutations: a non-unique "ok" linked → red; no cap → red; the quote sent
// to Keepr as such → red.
describe("replyToFor (reply-to metadata)", () => {
  const ROWS2: Array<[string, string | null]> = [["Zed Example", "3:45 PM"]];

  it("/chat carries replyTo and never the quote itself", async () => {
    const t = cacheEnv({ rows: ROWS2, numbers: { [id(0)]: ["+15555550101"] } });
    (t.env as Record<string, unknown>).extract = () => ({
      conversationId: id(0), title: "x", skipped: { noDate: 0, noText: 0 },
      messages: [
        { msgId: "1", direction: "inbound", sender: "x", text: "Are you still coming?", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [], quote: null },
        { msgId: "2", direction: "outbound", sender: "me", text: "Yes!", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [], quote: { text: "Are you still coming?", fromMe: false } },
      ],
    });
    await job.runJob(JOB, t.env);
    const sent = t.calls.find(([, p]) => p.endsWith("/chat"))![2] as { messages: Array<Record<string, unknown>> };
    expect(sent.messages[1].replyTo).toEqual({ msgId: "1" });
    expect(sent.messages.some((x) => "quote" in x)).toBe(false);
  });

  const m = (msgId: string, text: string, quote?: { text: string; fromMe: boolean }) => ({ msgId, text, ...(quote ? { quote } : {}) });

  it("a unique match in the chat → the quoted message's msg-id", () => {
    const all = [m("1", "Are you still coming?"), m("2", "Yes!", { text: "Are  you still\ncoming?", fromMe: false })];
    expect(job.replyToFor(all[1], all)).toEqual({ msgId: "1" });
  });

  it("a non-unique text (\"ok\") never links: a snippet instead", () => {
    const all = [m("1", "ok"), m("2", "ok"), m("3", "great", { text: "ok", fromMe: true })];
    expect(job.replyToFor(all[2], all)).toEqual({ snippet: "ok", sender: "me" });
  });

  it("no match → a snippet capped at 80; no quote → null", () => {
    const all = [m("1", "Sure", { text: "y".repeat(200), fromMe: false }), m("2", "plain")];
    expect(job.replyToFor(all[0], all)).toEqual({ snippet: "y".repeat(80), sender: "them" });
    expect(job.replyToFor(all[1], all)).toBeNull();
  });
});

// BACKLOG-3671 P2: the run's numbers for Keepr's sync_outcomes corpus —
// phase times, counts, per-chat p50 / p90 / slowest (computed HERE, the raw
// list never leaves), bytes read, Chrome's version. Mutations: no metrics on
// /finish or /error → red; a raw list sent → red; the percentiles wrong →
// red; Chrome's version from anything but the version → red.
describe("run metrics (BACKLOG-3671 P2)", () => {
  const ROWS: Array<[string, string | null]> = [["Zed Example", "3:45 PM"], ["Ann Example", "Mon"], ["Bob Example", "Sep 22"]];
  type Metrics = Record<string, Record<string, unknown> | string | undefined>;
  const ticking = (t: ReturnType<typeof cacheEnv>) => {
    let ms = NOW;
    t.env.now = () => new Date((ms += 250));
    (t.env as Record<string, unknown>).chromeVersion = async () => "141.0.7390.55";
  };
  const noArrays = (v: unknown): boolean =>
    !Array.isArray(v) && (v === null || typeof v !== "object" || Object.values(v as object).every(noArrays));

  it("/finish carries the numbers: phases, counts, per-chat summary, bytes, Chrome's version — no lists", async () => {
    const t = cacheEnv({ rows: ROWS, keepImages: true, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    ticking(t);
    await job.runJob(JOB, t.env);
    const m = (t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { metrics: Metrics }).metrics;
    const finding = m.finding as Record<string, number>;
    const reading = m.reading as Record<string, number>;
    expect(finding.ms).toBeGreaterThan(0);
    expect(finding).toMatchObject({ chatsFound: 3, chatsInRange: 3, chatsSkippedHidden: 0, chatsSkippedDisabled: 0 });
    expect(reading.ms).toBeGreaterThan(0);
    expect(reading).toMatchObject({ chatsRead: 3, chatsSkipped: 0, chatsFailed: 0, chatsOpened: 3, photosRead: 3 });
    expect(reading).not.toHaveProperty("perChatCount");
    expect(reading.messagesRead).toBe(3);
    expect(reading.bytesRead).toBe(3 * 3); // "AAAA" → 3 bytes, one photo per chat
    expect(reading.perChatP50Ms).toBeGreaterThan(0);
    expect(reading.perChatP90Ms).toBeGreaterThanOrEqual(reading.perChatP50Ms);
    expect(reading.perChatSlowestMs).toBeGreaterThanOrEqual(reading.perChatP90Ms);
    expect(m.chromeVersion).toBe("141.0.7390.55");
    expect(noArrays(m)).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/Example|5555550|aaaa/);
  });

  // Live (0.3.57): chats_read 5 vs a count of 15. chatsRead = chats whose
  // messages were SENT; chatsOpened = every chat opened and finished with
  // (the per-chat times' sample). Mutations: a chat with no messages counted
  // as read; the timing sample not the opened chats → red.
  it("chatsRead counts chats with messages sent; chatsOpened every chat finished with", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550102"], [id(2)]: ["+15555550103"] } });
    ticking(t);
    const extract = t.env.extract;
    let n = 0;
    // The second chat opened has no messages (a new group).
    t.env.extract = ((...a: unknown[]) => {
      const r = (extract as (...x: unknown[]) => { messages: unknown[] })(...a);
      return n++ === 1 ? { ...r, messages: [] } : r;
    }) as typeof t.env.extract;
    await job.runJob(JOB, t.env);
    const reading = (t.calls.find(([, p]) => p.endsWith("/finish"))![2] as { metrics: { reading: Record<string, number> } }).metrics.reading;
    expect(reading.chatsOpened).toBe(3);
    expect(reading.chatsRead).toBeLessThan(reading.chatsOpened);
    expect(reading.chatsRead + reading.chatsSkipped).toBe(reading.chatsOpened);
  });

  it("a failed run's /error carries the numbers so far", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: {} });
    ticking(t);
    t.env.returnToList = async () => false; // list_not_reachable
    await job.runJob(JOB, t.env);
    const err = t.calls.find(([, p]) => p.endsWith("/error"))![2] as { code: string; metrics: Metrics };
    expect(err.code).toBe("list_not_reachable");
    expect(err.metrics).toMatchObject({ chromeVersion: "141.0.7390.55", reading: {} });
  });

  it("perChatStats: nearest-rank p50 / p90, slowest, count", () => {
    expect(job.perChatStats([5, 1, 4, 2, 3, 10, 9, 8, 7, 6])).toEqual({ perChatP50Ms: 5, perChatP90Ms: 9, perChatSlowestMs: 10, perChatCount: 10 });
    expect(job.perChatStats([700])).toEqual({ perChatP50Ms: 700, perChatP90Ms: 700, perChatSlowestMs: 700, perChatCount: 1 });
    expect(job.perChatStats([])).toEqual({ perChatCount: 0 });
    expect(job.perChatStats([1, NaN, -5, "x", 3])).toEqual({ perChatP50Ms: 1, perChatP90Ms: 3, perChatSlowestMs: 3, perChatCount: 2 });
  });

  it("chromeVersionFrom: the full version from userAgentData, else the UA's Chrome/x — the version only", () => {
    // A browser brand, not a person (brand and version on their own lines).
    const CHROME = "Google Chrome";
    const list = [
      { brand: "Not=A?Brand", version: "99.0.0.0" },
      {
        brand: CHROME,
        version: "141.0.7390.55",
      },
    ];
    expect(job.chromeVersionFrom(list, "Mozilla/5.0 Chrome/140.0.0.0")).toBe("141.0.7390.55");
    expect(job.chromeVersionFrom(null, "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36")).toBe("141.0.0.0");
    expect(job.chromeVersionFrom([{ brand: CHROME, version: "141; drop table" }], "no chrome here")).toBeNull();
    expect(job.chromeVersionFrom(undefined, undefined)).toBeNull();
  });
});
