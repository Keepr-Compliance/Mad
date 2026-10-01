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
 *   M3 a cache job back through planChecks (name planning)    → "checks every chat above the cutoff, in list order"
 *   M4 the no-number chat reported as "error"                 → same test (no_numbers)
 *   M5 a 422 not_a_contact counted as a failed image          → "an image Keepr does not keep"
 *   M6 drop holdWhileHidden before a chat                     → "pauses while hidden"
 *   M7 the history floor back to startDate for a cache job    → "history floor is since"
 *   M8 no Cancel on progress lines / Cancel calls nothing     → "renderOverlay: Cancel"
 *   M9 the page Sync button brought back                     → "no Keepr element on the page when idle"
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

  it.each(["", "soon", "Sep", "13/45/2026x", "3/4/25", "12/12/2025"])("unreadable %p → null", (text) => {
    expect(scan.parseListTime(text, NOW)).toBeNull();
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
  visibility?: { hidden: () => boolean; whenVisible: () => Promise<void> };
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
        return { ok: true, status: 200, body: { jobId: JOB, kind: "cache", contacts: [], since, startDate: "2020-01-01T00:00:00.000Z" } };
      }
      if (p.endsWith("/match")) return { ok: true, status: 200, body: { matched: true } };
      if (p.endsWith("/attachment")) return opts.imageReply ?? { ok: true, status: 200, body: { ok: true } };
      if (p.endsWith("/chat")) return { ok: true, status: 200, body: { ok: true, stored: 1, received: 1 } };
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
        transport: "rcs", imageSrcs: ["blob:x"], files: [], reactions: [],
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
        return { stopReason: "floor", count: 1 };
      },
      messageIdSet: () => "",
    },
  };
  return { env, calls, shown, opened, floors, since };
}

describe("runJob: a cache Sync", () => {
  const ROWS: Array<[string, string | null]> = [["Zed Example", "3:45 PM"], ["Ann Example", "Mon"], ["Bob Example", "Sep 22"], ["Old Example", "Aug 1"]];

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

  it("the history floor is since, not a transaction start date (M7)", async () => {
    const t = cacheEnv({ rows: ROWS.slice(0, 1), numbers: { [id(0)]: ["+15555550101"] } });
    await job.runJob(JOB, t.env);
    expect(t.floors).toEqual([Date.parse(t.since)]);
  });

  it("shows 'Chat i of N' with a Cancel on progress lines", async () => {
    const t = cacheEnv({ rows: ROWS, numbers: { [id(0)]: ["+15555550101"] } });
    await job.runJob(JOB, t.env);
    const stage = t.shown.find(([text]) => text.startsWith("Chat 1 of 3"));
    expect(stage).toBeDefined();
    expect(stage?.[2]).toEqual({ cancel: true });
    expect(t.calls.some(([, p, b]) => p.endsWith("/progress") && b?.stage === "Chat 2 of 3")).toBe(true);
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

  it("pauses while hidden and resumes once visible (M6)", async () => {
    let hidden = false;
    let release: () => void = () => {};
    const t = cacheEnv({
      rows: ROWS,
      numbers: { [id(0)]: ["+15555550101"], [id(1)]: ["+15555550103"] },
      visibility: {
        hidden: () => hidden,
        whenVisible: () => new Promise<void>((r) => {
          release = () => {
            hidden = false;
            r();
          };
        }),
      },
    });
    // Hidden once the first chat is done (back on the list), before the next.
    t.env.returnToList = async () => {
      if (t.opened.length === 1) hidden = true;
      return true;
    };
    const run = job.runJob(JOB, t.env);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Paused: Keepr heard it, and nothing more was opened.
    expect(t.calls.some(([, p, b]) => p.endsWith("/progress") && b?.stage === job.PAUSED_TEXT)).toBe(true);
    expect(t.opened).toEqual([id(0)]);
    expect(t.shown.some(([text]) => text === job.PAUSED_TEXT)).toBe(true);
    release();
    const outcome = await run;
    expect(outcome.outcome).toBe("finished");
    expect(t.opened).toEqual([id(0), id(1), id(2)]);
  });

  it("hidden mid-chat: pauses before loading its history, then goes on", async () => {
    let hidden = false;
    let release: () => void = () => {};
    const t = cacheEnv({
      rows: ROWS.slice(0, 1),
      numbers: { [id(0)]: ["+15555550101"] },
      visibility: {
        hidden: () => hidden,
        whenVisible: () => new Promise<void>((r) => {
          release = () => {
            hidden = false;
            r();
          };
        }),
      },
    });
    const origOpen = t.env.openConversation;
    t.env.openConversation = async (c) => {
      await origOpen(c);
      hidden = true;
    };
    const run = job.runJob(JOB, t.env);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.floors).toEqual([]);
    expect(t.calls.some(([, p, b]) => p.endsWith("/progress") && b?.stage === job.PAUSED_TEXT)).toBe(true);
    release();
    expect((await run).outcome).toBe("finished");
    expect(t.floors).toHaveLength(1);
  });

  it("a cancel while paused ends the run as cancelled", async () => {
    const t = cacheEnv({
      rows: ROWS,
      numbers: {},
      visibility: { hidden: () => true, whenVisible: async () => {} },
    });
    const api = t.env.api;
    t.env.api = async (m: string, p: string, b?: Record<string, unknown>) =>
      b?.stage === job.PAUSED_TEXT ? { ok: false, status: 410, body: { error: "job_over" } } : api(m, p, b);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("job_gone");
    expect(t.opened).toEqual([]);
  });
});

describe("renderOverlay: Cancel (M8)", () => {
  it("a progress line with {cancel} has one Cancel that asks for this job's cancel", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const cancel = jest.fn(async () => true);
    job.renderOverlay(panel, "Chat 1 of 3…", false, { cancel: true }, { copy: async () => true, cancel });
    const buttons = panel.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    const button = panel.querySelector('[data-keepr="cancel"]') as HTMLButtonElement;
    button.click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Cancelling…");
  });

  it("a plain line has no buttons", () => {
    const panel = document.createElement("div");
    job.renderOverlay(panel, "Loading…", false, undefined, { copy: async () => true });
    expect(panel.querySelectorAll("button")).toHaveLength(0);
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
