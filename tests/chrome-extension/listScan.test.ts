/**
 * BACKLOG-3620 live fix — the conversation-list scan loads the WHOLE list.
 * BACKLOG-3641 — the Sync step log (shapes and hashes only) and the
 * "none matched" wording.
 *
 * Live (Windows, 2026-09-30): `listed 19, candidates 8, checked 8, matched 0`
 * — 19 is the number of items the page renders at once. The page's list is
 * virtualized: it renders a window of items for the current scroll position,
 * re-renders only on a 'scroll' event, may open scrolled part-way down, and
 * fetches older chats over the network when the bottom is reached. The fixture
 * below reproduces exactly that (SYNTHETIC names and ids; the real list's
 * element structure is UNVERIFIED, see scan.js).
 *
 * Mutation controls (each turns at least one test red):
 *   L1 no scroll-to-top first                 → "all 60 … starting mid-list"
 *   L2 no 'scroll' event after setting scrollTop → only the first window (19)
 *   L3 jump straight to scrollHeight          → the middle windows are missed
 *   L4 settleRetries 1 (no ~2 s wait)         → "slow network fetch"
 *   L5 stable rounds counted when not at the bottom → "slow render"
 *   D1 log a raw number instead of its shape  → "the step log …"
 *   D2 log a raw chat/contact name            → "the step log …"
 *   D3 drop the per-chat match= line          → "the step log …"
 *   D4 drop the "none matched" overlay branch → "checked but none matched"
 */

import * as fs from "fs";
import * as path from "path";

interface Conv {
  conversationId: string;
  name: string;
  href: string;
}

interface CollectResult {
  conversations: Conv[];
  stopReason: string;
  scroll: Record<string, unknown> | null;
}

interface ScanModule {
  collectConversations: (
    doc: Document,
    opts: { sleep: (ms: number) => Promise<void>; now?: () => number; waitMs?: number; settleRetries?: number; scroll?: () => void },
  ) => Promise<CollectResult>;
  [key: string]: unknown;
}

interface JobModule {
  RETURN_TO_KEEPR: string;
  numberShape: (s: string) => string;
  shortHash: (s: string) => string;
  runJob: (jobId: string, env: Record<string, unknown>) => Promise<{ outcome: string }>;
}

interface ApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as ScanModule;
const job = require("../../chrome-extension/job.js") as JobModule;
/* eslint-enable @typescript-eslint/no-require-imports */

const LIST = fs.readFileSync(path.join(__dirname, "fixtures", "conversation-list.synthetic.html"), "utf8");
const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
jest.setTimeout(10_000);

const ROW = 50;
const CLIENT = 950; // 19 rows on screen, as observed live
const WINDOW = 19;

function convId(i: number): string {
  return `conv${String(i).padStart(15, "0")}`;
}

/**
 * A virtualized list on a fake clock. `sleep(ms)` advances the clock and runs
 * whatever the page scheduled (delayed renders, network fetches).
 */
function virtualList(opts: {
  total: number;
  startTop?: number;
  renderDelayMs?: number;
  fetchMore?: { add: number; delayMs: number };
}) {
  document.body.innerHTML = `<div id="outer"><div id="scroller"></div></div>`;
  const el = document.getElementById("scroller") as HTMLElement;
  let total = opts.total;
  let top = opts.startTop ?? 0;
  let clock = 0;
  let sleeps = 0;
  let fetched = false;
  const pending: Array<{ at: number; run: () => void }> = [];
  const maxTop = (): number => Math.max(0, total * ROW - CLIENT);

  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.min(Math.max(0, v), maxTop());
    },
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => CLIENT });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total * ROW });

  function render(at: number): void {
    const first = Math.floor(at / ROW);
    let html = "";
    for (let i = first; i < Math.min(total, first + WINDOW); i++) {
      html += `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${convId(i)}"><span data-e2e-conversation-name>Person ${i}</span></a></mws-conversation-list-item>`;
    }
    el.innerHTML = html;
    // At the bottom the page asks the network for older chats.
    if (opts.fetchMore && !fetched && at >= maxTop() - 2) {
      fetched = true;
      const more = opts.fetchMore;
      pending.push({ at: clock + more.delayMs, run: () => { total += more.add; render(top); } });
    }
  }

  el.addEventListener("scroll", () => {
    const snapshot = top;
    if (opts.renderDelayMs) pending.push({ at: clock + opts.renderDelayMs, run: () => render(snapshot) });
    else render(snapshot);
  });
  render(top);

  const sleep = async (ms: number): Promise<void> => {
    sleeps += 1;
    if (sleeps > 5000) throw new Error("test harness: runaway loop");
    clock += ms;
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= clock) pending.shift()?.run();
  };
  return { el, sleep, now: () => clock };
}

describe("collectConversations on a virtualized list (BACKLOG-3620 live fix)", () => {
  it("returns all 60 chats in order, from the first, when the tab opens scrolled to mid-list (L1, L2, L3)", async () => {
    const page = virtualList({ total: 60, startTop: 1000 });
    expect(document.querySelectorAll("mws-conversation-list-item")).toHaveLength(WINDOW);
    const result = await scan.collectConversations(document, { sleep: page.sleep, now: page.now });
    expect(result.conversations.map((c) => c.conversationId)).toEqual(Array.from({ length: 60 }, (_, i) => convId(i)));
    expect(result.stopReason).toBe("stable");
    expect(result.scroll).toMatchObject({ scroller: true, startTop: 1000, clientHeight: CLIENT, atBottom: true });
    expect(result.scroll?.endTop).toBe(60 * ROW - CLIENT);
  });

  it("a slow network fetch at the bottom (4 s) is waited for (L4)", async () => {
    const page = virtualList({ total: 40, fetchMore: { add: 20, delayMs: 4000 } });
    const result = await scan.collectConversations(document, { sleep: page.sleep, now: page.now });
    expect(result.conversations).toHaveLength(60);
    expect(result.scroll?.scrollHeightAfter).toBe(60 * ROW);
  });

  it("a slow render does not stop the scan before the bottom (L5)", async () => {
    const page = virtualList({ total: 60, renderDelayMs: 7000 });
    const result = await scan.collectConversations(document, { sleep: page.sleep, now: page.now });
    expect(result.conversations).toHaveLength(60);
  });

  it("still bounded by maxMs while the list keeps loading slowly", async () => {
    const page = virtualList({ total: 60, renderDelayMs: 7000 });
    const result = await scan.collectConversations(document, {
      sleep: page.sleep, now: page.now, maxMs: 3000,
    } as Parameters<ScanModule["collectConversations"]>[1]);
    expect(result.stopReason).toBe("max_time");
  });

  // SR O1. The nearest overflowing ancestor of the items cannot move (its
  // scrollTop stays 0); its parent is the element that really scrolls.
  // Mutation L6: count a stable round instead of re-picking → only 19.
  it("re-picks the scrollable parent when the first scroller will not move (L6)", async () => {
    document.body.innerHTML = `<div id="outer"><div id="inner"></div></div>`;
    const outer = document.getElementById("outer") as HTMLElement;
    const inner = document.getElementById("inner") as HTMLElement;
    const total = 60;
    let top = 0;
    let clock = 0;
    const maxTop = total * ROW - CLIENT;
    Object.defineProperty(inner, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    Object.defineProperty(inner, "clientHeight", { configurable: true, get: () => CLIENT });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, get: () => total * ROW });
    Object.defineProperty(outer, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(Math.max(0, v), maxTop);
      },
    });
    Object.defineProperty(outer, "clientHeight", { configurable: true, get: () => CLIENT });
    Object.defineProperty(outer, "scrollHeight", { configurable: true, get: () => total * ROW });
    const render = (): void => {
      const first = Math.floor(top / ROW);
      let html = "";
      for (let i = first; i < Math.min(total, first + WINDOW); i++) {
        html += `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${convId(i)}"><span data-e2e-conversation-name>Person ${i}</span></a></mws-conversation-list-item>`;
      }
      inner.innerHTML = html;
    };
    outer.addEventListener("scroll", render);
    render();
    const result = await scan.collectConversations(document, {
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(result.conversations).toHaveLength(60);
    expect(result.scroll).toMatchObject({ repicks: 1, atBottom: true });
  });
});

describe("Sync step log (BACKLOG-3641)", () => {
  // SR F1. Mutation D8: copy ASCII letters / other ASCII through → red.
  it("numberShape never lets a name or an email through: letters → a, other ASCII → *", () => {
    expect(job.numberShape("Test Contact A")).toBe("aaaa aaaaaaa a");
    expect(job.numberShape("test.contact@example.test")).toBe("aaaa.aaaaaaa*aaaaaaa.aaaa");
    expect(job.numberShape("+1 (555) 555-0199 ext_9/x")).toBe("+d (ddd) ddd-dddd aaa*d*a");
  });

  it("numberShape keeps the format, hides the digits, spells out only invisible/format characters", () => {
    expect(job.numberShape("(555) 555-0199")).toBe("(ddd) ddd-dddd");
    expect(job.numberShape("+1 555\u202f0100")).toBe("+d dddU+202Fdddd");
    expect(job.numberShape("\u00a0\u200b\u200e\u202a\u202e\u2060\u2069\ufeff")).toBe(
      "U+00A0U+200BU+200EU+202AU+202EU+2060U+2069U+FEFF",
    );
    expect(job.numberShape("\u0663\u0664")).toBe("??");
    expect(job.numberShape("")).toBe("");
  });

  // SR F1b. Mutation D10: spell every non-ASCII char as U+XXXX again → red.
  it("a non-Latin or accented name is not spelled out as code points", () => {
    // Invented samples: "test" in Hebrew, Japanese and Cyrillic, and an accented "Test Contact".
    const names = ["\u05d1\u05d3\u05d9\u05e7\u05d4", "\u30c6\u30b9\u30c8", "\u0422\u0435\u0441\u0442 \u041a\u043e\u043d\u0442\u0430\u043a\u0442", "T\u00e9st C\u00f6ntact"];
    for (const name of names) {
      const shape = job.numberShape(name);
      for (const ch of Array.from(name)) {
        const code = ch.codePointAt(0) ?? 0;
        if (code > 127) {
          const spelled = "U+" + code.toString(16).toUpperCase().padStart(4, "0");
          expect([name, spelled, shape.includes(spelled)]).toEqual([name, spelled, false]);
        }
      }
      expect(shape).toMatch(/^[a ?]*$/);
    }
    expect(job.numberShape("T\u00e9st C\u00f6ntact")).toBe("a?aa a?aaaaa");
  });

  it("shortHash is 6 hex and stable", () => {
    expect(job.shortHash("Test Contact A")).toMatch(/^[0-9a-f]{6}$/);
    expect(job.shortHash("Test Contact A")).toBe(job.shortHash("Test Contact A"));
    expect(job.shortHash("Test Contact A")).not.toBe(job.shortHash("Test Contact B"));
  });

  function diagJob(matchIds: string[], numbers: string[] = ["(555) 555-0199", "+1 555 555 0100"]) {
    document.body.innerHTML = LIST;
    const lines: string[] = [];
    const shown: string[] = [];
    let open = "";
    const env = {
      doc: document,
      getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
      api: async (_m: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
        if (p.endsWith("/claim")) {
          return { ok: true, status: 200, body: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }, { contactId: "c-2", displayName: "Test Contact" }] } };
        }
        if (p.endsWith("/match")) {
          const matched = matchIds.includes(String(body?.conversationId));
          return { ok: true, status: 200, body: { matched, contactIds: matched ? ["c-1"] : [] } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: { show: (t: string) => shown.push(t) },
      log: (line: string) => lines.push(line),
      sleep: () => Promise.resolve(),
      click: () => {},
      scroll: () => {},
      openConversation: async (conv: Conv) => {
        open = conv.conversationId;
      },
      returnToList: async () => true,
      readImage: async () => null,
      extract: () => ({
        title: "x",
        messages: [{ msgId: "1", direction: "inbound", sender: "x", text: "SECRET MESSAGE TEXT", sentAt: "2026-09-20T13:05:00.000Z", transport: "rcs" }],
      }),
      scan: {
        ...scan,
        readParticipantsAndClose: async () => numbers,
        waitForMessageSwap: async () => true,
        loadHistory: async () => ({ stopReason: "no_more", count: 1 }),
        messageIdSet: () => "",
      },
    };
    return { env, lines, shown };
  }

  it("the step log: stages, list stats, candidates, per-chat reason / number shapes / match, final counts — no names, numbers or text (D1, D2, D3)", async () => {
    const t = diagJob(["aaaaaaaaaaaaaaaaaaa"]);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    const all = t.lines.join("\n");
    expect(all).toContain("stage: job found");
    expect(all).toContain("stage: loading the conversation list");
    expect(all).toMatch(/listed 5, stopReason \w+, scroll /);
    expect(all).toMatch(/candidates 4 \{.*"name".*\}/);
    expect(all).toMatch(/#1\/4 chat [0-9a-f]{6} reason=name/);
    expect(all).toContain('numbers ["(ddd) ddd-dddd","+d ddd ddd dddd"]');
    expect(t.lines.filter((l) => /match=(yes|no)/.test(l))).toHaveLength(4);
    expect(all).toContain("match=yes");
    expect(all).toMatch(/done: listed 5, candidates 4, checked 4, matched 1, imported 1 chats/);
    // Never PII.
    for (const forbidden of ["555", "0199", "Test Contact", "Test B. Contact", "SECRET MESSAGE TEXT", "Someone Else"]) {
      expect([forbidden, all.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  // SR F1: the Details selector is untraced, so a name or an email may come
  // back as a "number". Mutation D8 (letters copied through) → red.
  it("a name or an email read from Details never reaches the log: no letters, no '@'", async () => {
    const t = diagJob([], ["Test Contact A", "test.contact@example.test"]);
    await job.runJob(JOB, t.env);
    const numberLines = t.lines.filter((l) => l.startsWith("  numbers "));
    expect(numberLines).toHaveLength(4);
    for (const line of numberLines) {
      expect(line).toBe('  numbers ["aaaa aaaaaaa a","aaaa.aaaaaaa*aaaaaaa.aaaa"]');
      // Only the shape alphabet: no letter other than the placeholder "a".
      expect(line.replace(/^ {2}numbers /, "")).toMatch(/^[\["a d+()\-.*,\]]*$/);
    }
    const all = t.lines.join("\n");
    for (const forbidden of ["Test Contact", "test.contact", "Contact A", "example", "@"]) {
      expect([forbidden, all.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  // SR: per-job salt. Mutation D9: hash the name without the salt → red.
  it("name tags are salted per job: the same chat gets the same tag within a run, a different one across runs", async () => {
    const tagOf = (lines: string[]): string => (lines.find((l) => l.startsWith("#1/4 chat ")) ?? "").split(" ")[2];
    const contactTags = (lines: string[]): string[] =>
      ((lines.find((l) => l.startsWith("claimed:")) ?? "").match(/\[(.*)\]/)?.[1] ?? "").split(", ");
    const a = diagJob([]);
    await job.runJob(JOB, a.env);
    const b = diagJob([]);
    await job.runJob(JOB, b.env);
    expect(tagOf(a.lines)).toMatch(/^[0-9a-f]{6}$/);
    // Chat #1 is "Test Contact A", also contact 1: one run correlates them.
    expect(contactTags(a.lines)[0]).toBe(tagOf(a.lines));
    expect(tagOf(b.lines)).not.toBe(tagOf(a.lines));
    // A fixed salt (tests only) is deterministic.
    const c = diagJob([]);
    (c.env as Record<string, unknown>).salt = "fixed";
    await job.runJob(JOB, c.env);
    expect(tagOf(c.lines)).toBe(job.shortHash("fixed:Test Contact A"));
  });

  it("a failing log never stops the sync", async () => {
    const t = diagJob(["aaaaaaaaaaaaaaaaaaa"]);
    (t.env as Record<string, unknown>).log = () => {
      throw new Error("worker asleep");
    };
    expect((await job.runJob(JOB, t.env)).outcome).toBe("finished");
  });

  it("checked but none matched: the overlay says so instead of 'imported 0 chats' (D4)", async () => {
    const t = diagJob([]);
    await job.runJob(JOB, t.env);
    const done = t.shown[t.shown.length - 1];
    expect(done.split("\n")[0]).toBe("Checked 4 chats — none matched a phone number on this transaction's contacts.");
    expect(done).not.toContain("imported 0 chats");
    expect(done.endsWith(job.RETURN_TO_KEEPR)).toBe(true);
  });
});
