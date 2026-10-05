/**
 * BACKLOG-3629 — Sync in both Messages for Web layouts, and no silent skips.
 * BACKLOG-3628 — the claim is a POST. BACKLOG-3636 — the finished overlay
 * says how to get back to Keepr.
 *
 * Layouts (founder observation, 2026-09-30): a wide window shows the
 * conversation list and the open chat side by side (two-pane); a narrow one
 * shows the list OR the chat (single-pane), with a back button in the chat
 * header. The fixture below is SYNTHETIC: the header back button's selector and
 * whether the hidden list leaves the DOM (or is only display:none) are
 * UNTRACED on the live page, so both variants are exercised.
 *
 * Mutation controls (each turns at least one test here red):
 *   M1 remove `returnToList` from `openFromList` (scan.js)        → "single-pane: clicks back…"
 *   M2 remove the back-button click (history.back only)           → "…header back button"
 *   M3 remove the `io.back()` fallback                            → "no back button: history.back()"
 *   M4 remove the per-chat `returnToList` in runJob's finally     → "single-pane job … ends on the list"
 *   M5 remove the `returnToList` before the list scan             → "single-pane job starting inside a chat"
 *   M6 drop any one leaveOut(...) reason in runJob                → "every way a chat is left out"
 *   M7 drop the cap / "+N more"                                   → "caps the named list at 20"
 *   M8 claim back to GET, or no "/claim"                          → "claims with POST /claim"
 *   M9 the finished overlay is more than its one line             → the overlay assertions
 */

import * as fs from "fs";
import * as path from "path";

interface Conv {
  conversationId: string;
  name: string;
  href: string;
}

interface LayoutIo {
  click: (el: Element) => void;
  sleep: (ms: number) => Promise<void>;
  back?: () => void;
  getPathname: () => string;
  timeoutMs?: number;
}

interface ScanModule {
  listShown: (doc: Document) => boolean;
  isShown: (el: Element) => boolean;
  returnToList: (doc: Document, io: LayoutIo) => Promise<boolean>;
  openFromList: (doc: Document, conv: { conversationId: string }, io: LayoutIo) => Promise<void>;
  [key: string]: unknown;
}

interface ApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

interface NotReached {
  name: string;
  reason: string;
  count?: number;
}

interface JobModule {
  DONE_LINE: string;
  LIST_NOT_REACHABLE: string;
  runJob: (
    jobId: string,
    env: Record<string, unknown>,
  ) => Promise<{ outcome: string; notReached?: NotReached[] }>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as ScanModule;
const job = require("../../chrome-extension/job.js") as JobModule;
/* eslint-enable @typescript-eslint/no-require-imports */

const LIST = fs.readFileSync(path.join(__dirname, "fixtures", "conversation-list.synthetic.html"), "utf8");
const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
/** A cache Sync (the only kind since 2026-10-05): its history floor. */
const SINCE = "2026-01-01T00:00:00.000Z";

let sleeps = 0;
beforeEach(() => {
  sleeps = 0;
});
const noSleep = (): Promise<void> => {
  sleeps += 1;
  if (sleeps > 20_000) throw new Error("test harness: runaway loop");
  return Promise.resolve();
};
jest.setTimeout(10_000);

type Layout = "two" | "single";

/**
 * A synthetic Messages page. Clicking a list link opens that chat; in the
 * single-pane layout the list then leaves the screen (removed, or
 * display:none) and the header shows a back button.
 */
function messagesPage(opts: {
  layout: Layout;
  hideListBy?: "remove" | "display";
  backButton?: boolean;
  /** "anchor": the live page's back control (traced 2026-10-01). */
  backMarkup?: "button" | "anchor";
  /** The first N clicks of the back control do nothing (a slow page). */
  backIgnoresClicks?: number;
  startInChat?: string;
}) {
  let ignoreBack = opts.backIgnoresClicks ?? 0;
  const log: string[] = [];
  let open = "";
  document.body.innerHTML = `<div id="list-wrap"></div><div id="chat"></div>`;
  const listWrap = document.getElementById("list-wrap") as HTMLElement;
  const chat = document.getElementById("chat") as HTMLElement;

  function render(): void {
    const listOnScreen = opts.layout === "two" || open === "";
    if (opts.hideListBy === "display") {
      if (!listWrap.innerHTML) listWrap.innerHTML = LIST;
      listWrap.style.display = listOnScreen ? "" : "none";
    } else {
      listWrap.innerHTML = listOnScreen ? LIST : "";
    }
    const back = opts.layout === "single" && opts.backButton !== false
      ? opts.backMarkup === "anchor"
        ? `<a aria-label="Back" data-e2e-header-back-button class="mdc-icon-button mat-mdc-icon-button mat-unthemed" id="back"><span class="mat-mdc-button-touch-target"></span></a>`
        : `<button aria-label="Back" id="back">Back</button>`
      : "";
    chat.innerHTML = open
      ? `<mws-header><div class="left-content">${back}<h2 data-e2e-header-title>${open}</h2></div></mws-header>`
      : "";
  }

  function goBack(): void {
    log.push("back");
    open = "";
    render();
  }

  document.body.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest("#back")) {
      e.preventDefault();
      if (ignoreBack > 0) {
        ignoreBack -= 1;
        log.push("back (no effect)");
        return;
      }
      goBack();
      return;
    }
    const link = target.closest("a[data-e2e-conversation]");
    if (link) {
      e.preventDefault();
      open = (link.getAttribute("href") ?? "").split("/").pop() ?? "";
      log.push(`open:${open}`);
      render();
    }
  });

  if (opts.startInChat) open = opts.startInChat;
  render();

  const io: LayoutIo = {
    click: (el) => (el as HTMLElement).click(),
    sleep: noSleep,
    back: () => {
      log.push("history.back");
      open = "";
      render();
    },
    getPathname: () => `/web/conversations/${open}`,
    timeoutMs: 1000,
  };
  return { log, io, isOpen: () => open };
}

describe("layout detection and returning to the list (scan.js)", () => {
  it("two-pane: the list stays on screen with a chat open, and nothing is clicked", async () => {
    const page = messagesPage({ layout: "two", startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(scan.listShown(document)).toBe(true);
    expect(await scan.returnToList(document, page.io)).toBe(true);
    expect(page.log).toEqual([]);
    expect(page.isOpen()).toBe("aaaaaaaaaaaaaaaaaaa");
  });

  it("two-pane: openFromList opens a chat straight from the list", async () => {
    const page = messagesPage({ layout: "two", startInChat: "aaaaaaaaaaaaaaaaaaa" });
    await scan.openFromList(document, { conversationId: "ccccccccccccccccccc" }, page.io);
    expect(page.log).toEqual(["open:ccccccccccccccccccc"]);
  });

  it.each(["remove", "display"] as const)(
    "single-pane (list %s): a chat open hides the list; clicks back, then opens the next chat (M1)",
    async (hideListBy) => {
      const page = messagesPage({ layout: "single", hideListBy, startInChat: "aaaaaaaaaaaaaaaaaaa" });
      expect(scan.listShown(document)).toBe(false);
      await scan.openFromList(document, { conversationId: "ccccccccccccccccccc" }, page.io);
      expect(page.log).toEqual(["back", "open:ccccccccccccccccccc"]);
    },
  );

  it("single-pane: returnToList uses the header back button, not history.back() (M2)", async () => {
    const page = messagesPage({ layout: "single", startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(await scan.returnToList(document, page.io)).toBe(true);
    expect(page.log).toEqual(["back"]);
    expect(scan.listShown(document)).toBe(true);
  });

  // Live 2026-10-01 (narrow window, a chat open → list_not_reachable): the
  // back control is an <a data-e2e-header-back-button>. Mutation: the old
  // selectors (no anchor) → history.back() → red.
  it("single-pane, the live anchor back control: clicked, never history.back() (N1)", async () => {
    const page = messagesPage({ layout: "single", backMarkup: "anchor", startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(await scan.returnToList(document, page.io)).toBe(true);
    expect(page.log).toEqual(["back"]);
  });

  // Mutation: one click only, or history.back() after the control → red.
  it("the back control is retried (at most 3 clicks), never followed by history.back() (N2)", async () => {
    const slow = messagesPage({ layout: "single", backMarkup: "anchor", backIgnoresClicks: 2, startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(await scan.returnToList(document, slow.io)).toBe(true);
    expect(slow.log).toEqual(["back (no effect)", "back (no effect)", "back"]);
    const dead = messagesPage({ layout: "single", backMarkup: "anchor", backIgnoresClicks: 99, startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(await scan.returnToList(document, dead.io)).toBe(false);
    expect(dead.log).toEqual(["back (no effect)", "back (no effect)", "back (no effect)"]);
  });

  it("single-pane with no back button: history.back() brings the list back (M3)", async () => {
    const page = messagesPage({ layout: "single", backButton: false, startInChat: "aaaaaaaaaaaaaaaaaaa" });
    expect(await scan.returnToList(document, page.io)).toBe(true);
    expect(page.log).toEqual(["history.back"]);
  });

  // SR B1. Mutation: drop the chat-path condition on io.back() → back() is
  // called from these paths and this goes red.
  it.each(["/web/conversations", "/web/conversations/", "/web/welcome", "/"])(
    "never calls history.back() when the path %s is not an open chat (B1)",
    async (pathname) => {
      const page = messagesPage({ layout: "single", backButton: false, startInChat: "aaaaaaaaaaaaaaaaaaa" });
      const io: LayoutIo = { ...page.io, getPathname: () => pathname };
      expect(await scan.returnToList(document, io)).toBe(false);
      expect(page.log).toEqual([]);
    },
  );

  it("the list cannot be brought back: returnToList is false (never throws) and openFromList rejects not_reachable", async () => {
    const page = messagesPage({ layout: "single", backButton: false, startInChat: "aaaaaaaaaaaaaaaaaaa" });
    const stuck: LayoutIo = { ...page.io, back: () => page.log.push("history.back (no effect)") };
    expect(await scan.returnToList(document, stuck)).toBe(false);
    const err = await scan
      .openFromList(document, { conversationId: "ccccccccccccccccccc" }, stuck)
      .then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("not_reachable");
  });
});

/** Stubbed scan steps around the REAL layout functions and list scan. */
function layoutJob(page: ReturnType<typeof messagesPage>) {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const shown: string[] = [];
  const details: string[] = [];
  const env = {
    doc: document,
    getLocation: () => ({
      pathname: `/web/conversations/${page.isOpen()}`,
      href: `https://messages.google.com/web/conversations/${page.isOpen()}`,
    }),
    api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
      calls.push([method, p, body]);
      if (p.endsWith("/claim")) return { ok: true, status: 200, body: { jobId: JOB, kind: "cache", since: SINCE } };
      if (p.endsWith("/match")) {
        const matched = body?.conversationId === "aaaaaaaaaaaaaaaaaaa" || body?.conversationId === "eeeeeeeeeeeeeeeeeee";
        return { ok: true, status: 200, body: { matched, contactIds: matched ? ["c-1"] : [] } };
      }
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: {
      show: (text: string, _e?: boolean, x?: { details?: string }) => {
        shown.push(text);
        details.push(x?.details ?? "");
      },
    },
    sleep: noSleep,
    click: page.io.click,
    scroll: () => {},
    openConversation: (conv: Conv) => scan.openFromList(document, conv, page.io),
    returnToList: () => scan.returnToList(document, page.io),
    readImage: async () => null,
    extract: () => ({
      title: page.isOpen(),
      messages: [{ msgId: "1", direction: "inbound", sender: "x", text: "hi", sentAt: "2026-09-20T13:05:00.000Z", transport: "rcs" }],
    }),
    scan: {
      ...scan,
      // Details and message loading have their own suites (scan.test.ts).
      readParticipantsAndClose: async () => ["(555) 555-0199"],
      waitForMessageSwap: async () => true,
      loadHistory: async () => ({ stopReason: "no_more", count: 1 }),
      messageIdSet: () => "",
    },
  };
  return { env, calls, shown, details };
}

describe("the Sync job in both layouts", () => {
  // BACKLOG-3658: a cache Sync checks every chat newer than its floor, in
  // list order (no name ordering since the per-transaction Sync was removed).
  const CANDIDATES = [
    "aaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbb", "ccccccccccccccccccc", "ddddddddddddddddddd", "eeeeeeeeeeeeeeeeeee",
  ];

  it("two-pane: every candidate is opened, the back button is never used, nothing is left out", async () => {
    const page = messagesPage({ layout: "two" });
    const t = layoutJob(page);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(page.log).toEqual(CANDIDATES.map((id) => `open:${id}`));
    expect(t.calls.filter(([, p]) => p.endsWith("/chat")).map(([, , b]) => b?.conversationId)).toEqual([
      "aaaaaaaaaaaaaaaaaaa", "eeeeeeeeeeeeeeeeeee",
    ]);
    expect(outcome.notReached).toEqual([]);
  });

  it.each(["remove", "display"] as const)(
    "single-pane (list %s): back to the list after every chat, every candidate is reached, and the job ends on the list (M4)",
    async (hideListBy) => {
      const page = messagesPage({ layout: "single", hideListBy });
      const t = layoutJob(page);
      const outcome = await job.runJob(JOB, t.env);
      expect(outcome.outcome).toBe("finished");
      expect(page.log).toEqual(CANDIDATES.flatMap((id) => [`open:${id}`, "back"]));
      expect(t.calls.filter(([, p]) => p.endsWith("/chat")).map(([, , b]) => b?.conversationId)).toEqual([
        "aaaaaaaaaaaaaaaaaaa", "eeeeeeeeeeeeeeeeeee",
      ]);
      expect(outcome.notReached).toEqual([]);
      expect(scan.listShown(document)).toBe(true);
    },
  );

  it("single-pane job starting inside a chat: goes back to the list before scanning it (M5)", async () => {
    const page = messagesPage({ layout: "single", startInChat: "bbbbbbbbbbbbbbbbbbb" });
    const t = layoutJob(page);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(page.log[0]).toBe("back");
    const progress = t.calls.find(([, p, b]) => p.endsWith("/progress") && String(b?.stage).startsWith("Reading chat"));
    expect(progress?.[2]).toMatchObject({ listed: 5, candidates: 5 });
  });

  it("claims with POST /claim, never a GET (M8)", async () => {
    const page = messagesPage({ layout: "two" });
    const t = layoutJob(page);
    await job.runJob(JOB, t.env);
    expect(t.calls[0]).toEqual(["POST", `/job/${JOB}/claim`, undefined]);
    expect(t.calls.some(([m]) => m !== "POST")).toBe(false);
  });

  // SR B2. Mutation: ignore returnToList's false before the scan → the job
  // "finishes" with 0 chats and this goes red.
  it("the list cannot be shown at the start: the job fails list_not_reachable, no scan, no /finish (B2)", async () => {
    const page = messagesPage({ layout: "single", backButton: false, startInChat: "bbbbbbbbbbbbbbbbbbb" });
    page.io.back = () => page.log.push("history.back (no effect)");
    const t = layoutJob(page);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("list_not_reachable");
    const err = t.calls.find(([, p]) => p.endsWith("/error"));
    expect(err?.[2]).toMatchObject({ code: "list_not_reachable", message: job.LIST_NOT_REACHABLE });
    expect(t.calls.some(([, p]) => p.endsWith("/finish") || p.endsWith("/match"))).toBe(false);
    // SR U1: the card's short line; the long how-to (with the URL) in the details.
    expect(t.shown[t.shown.length - 1]).toBe("Couldn't open your conversation list.");
    expect(t.details[t.details.length - 1]).toContain(job.LIST_NOT_REACHABLE);
    expect(job.LIST_NOT_REACHABLE).toContain("messages.google.com/web/conversations");
  });

  // SR O1. Mutation: drop the signed_in check on the chat-header branch of
  // waitForPageState → the job claims on an unknown path and this goes red.
  it("a chat header on a path that is not a signed-in Messages path is not 'ready' (O1)", async () => {
    document.body.innerHTML = "<mws-header><h2 data-e2e-header-title>x</h2></mws-header>";
    const calls: string[] = [];
    const outcome = await job.runJob(JOB, {
      doc: document,
      getLocation: () => ({ pathname: "/web/somewhere-else", href: "https://messages.google.com/web/somewhere-else" }),
      api: async (_m: string, p: string): Promise<ApiReply> => {
        calls.push(p);
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: { show: () => {} },
      sleep: noSleep,
      pageTimeoutMs: 500,
      scan,
    });
    expect(outcome.outcome).toBe("page_not_ready");
    expect(calls).toEqual([`/job/${JOB}/error`]);
  });
});

describe("no chat is ever silently left out (BACKLOG-3629)", () => {
  interface Plan {
    name: string;
    open?: "throws";
    numbers?: string[];
    /** #11: the kind readParticipantsAndClose gives an empty result. */
    numbersKind?: string;
    matched?: boolean;
    swap1?: boolean;
    swap2?: boolean;
    messages?: number;
    images?: Array<"ok" | "unreadable" | "refused">;
    stopReason?: string;
    chat?: "fails";
  }

  function planJob(plans: Plan[]) {
    const convs: Conv[] = plans.map((p, i) => ({
      conversationId: `conv${String(i).padStart(15, "0")}`,
      name: p.name,
      href: `/web/conversations/conv${String(i).padStart(15, "0")}`,
    }));
    const byId = new Map(convs.map((c, i) => [c.conversationId, plans[i]]));
    let open = "";
    let swaps = 0;
    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const shown: string[] = [];
    const details: string[] = [];
    const copies: string[] = [];
    const current = (): Plan => byId.get(open) as Plan;
    document.body.innerHTML = "<mws-conversation-list-item></mws-conversation-list-item>";
    const env = {
      doc: document,
      // A fixed clock: the history-depth line names the days back to SINCE.
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
      api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
        calls.push([method, p, body]);
        if (p.endsWith("/claim")) return { ok: true, status: 200, body: { jobId: JOB, kind: "cache", since: SINCE } };
        if (p.endsWith("/match")) {
          const matched = !!byId.get(String(body?.conversationId))?.matched;
          // A cache Sync keeps a chat's photos only when Keepr says so.
          return { ok: true, status: 200, body: { matched, contactIds: [], keepPhotos: matched } };
        }
        if (p.endsWith("/chat") && current().chat === "fails") {
          return { ok: false, status: 500, body: { message: "Keepr could not save this chat." } };
        }
        if (p.endsWith("/attachment") && body?.base64 === "REFUSED") {
          return { ok: false, status: 400, body: { message: "Image not stored" } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: {
        show: (text: string, _isError?: boolean, extras?: { details: string; copy: string }) => {
          shown.push(text);
          details.push(extras?.details ?? "");
          copies.push(extras?.copy ?? "");
        },
      },
      sleep: noSleep,
      click: () => {},
      scroll: () => {},
      openConversation: async (conv: Conv) => {
        if (byId.get(conv.conversationId)?.open === "throws") throw new Error("Timed out waiting for the chat to open");
        open = conv.conversationId;
        swaps = 0;
      },
      returnToList: async () => true,
      readImage: async (src: string) => {
        if (src.endsWith("unreadable")) return null;
        return { mimeType: "image/png", base64: src.endsWith("refused") ? "REFUSED" : "AAAA" };
      },
      extract: () => {
        const plan = current();
        const count = plan.messages ?? 1;
        const images = plan.images ?? [];
        return {
          title: plan.name,
          messages: Array.from({ length: count }, (_, i) => ({
            msgId: String(i + 1),
            direction: "inbound",
            sender: plan.name,
            text: `m${i}`,
            sentAt: "2026-09-20T13:05:00.000Z",
            transport: "rcs",
            ...(i === 0 ? { imageSrcs: images.map((kind, n) => `blob:x-${n}-${kind}`) } : {}),
          })),
        };
      },
      scan: {
        ...scan,
        collectConversations: async () => ({ conversations: convs, stopReason: "stable" }),
        messageIdSet: () => "",
        readParticipantsAndClose: async () => {
          const list = current().numbers ?? ["(555) 555-0199"];
          if (current().numbersKind) Object.defineProperty(list, "kind", { value: current().numbersKind, enumerable: false });
          return list;
        },
        waitForMessageSwap: async () => {
          swaps += 1;
          const plan = current();
          return swaps === 1 ? plan.swap1 !== false : plan.swap2 !== false;
        },
        loadHistory: async () => ({ stopReason: current().stopReason ?? "no_more", count: current().messages ?? 1 }),
      },
    };
    const finish = (): Record<string, unknown> | undefined => calls.find(([, p]) => p.endsWith("/finish"))?.[2];
    return { env, calls, shown, details, copies, finish };
  }

  // BACKLOG-3658 #12: same-name threads are told apart in the step log by a
  // salted id tag — never the raw id. Mutation: no id tag, or the raw id → red.
  it("the step log tags each chat's conversation id (salted per job), never the raw id", async () => {
    const t = planJob([
      { name: "Chat Same Name", matched: true },
      { name: "Chat Same Name", matched: true },
    ]);
    await job.runJob(JOB, t.env);
    const copy = t.copies[t.copies.length - 1];
    const lines = copy.split("\n").filter((l) => /^#\d+\/2 chat /.test(l));
    expect(lines).toHaveLength(2);
    const nameTags = lines.map((l) => /chat (\S+)/.exec(l)?.[1]);
    const idTags = lines.map((l) => / id ([0-9a-f]{6}) /.exec(l)?.[1]);
    expect(nameTags[0]).toBe(nameTags[1]);
    expect(idTags[0]).toMatch(/^[0-9a-f]{6}$/);
    expect(idTags[0]).not.toBe(idTags[1]);
    expect(copy).not.toContain("conv000000000000000");
  });

  // BACKLOG-3658 #11. Mutation: every empty result reported as no_numbers → red.
  it("short-code and named-sender chats are reported apart from no_numbers, never sent to /match", async () => {
    const t = planJob([
      { name: "Chat Short Code", numbers: [], numbersKind: "short_code" },
      { name: "Chat Business", numbers: [], numbersKind: "business" },
      { name: "Chat No Details", numbers: [], numbersKind: "no_details" },
    ]);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.notReached).toEqual([
      { name: "Chat Short Code", reason: "short_code" },
      { name: "Chat Business", reason: "business" },
      { name: "Chat No Details", reason: "no_numbers" },
    ]);
    expect(t.calls.filter(([, p]) => p.endsWith("/match"))).toEqual([]);
  });

  it("every way a chat is left out, or imported only in part, is named in /finish and on the page (M6, M9)", async () => {
    const t = planJob([
      { name: "Chat Not Opened", open: "throws" },
      { name: "Chat No Numbers", numbers: [] },
      { name: "Chat Not Theirs", matched: false },
      { name: "Chat Not Loaded", matched: true, swap1: false },
      { name: "Chat Unsettled", matched: true, swap2: false },
      { name: "Chat Empty", matched: true, messages: 0 },
      { name: "Chat Truncated", matched: true, stopReason: "cap", images: ["ok", "unreadable", "refused"] },
      { name: "Chat Save Failed", matched: true, chat: "fails" },
      { name: "Chat Fine", matched: true, images: ["ok"] },
    ]);
    // The transient retry has its own tests (retry-3671); none here.
    (t.env as Record<string, unknown>).transientRetryPoolMs = 0;
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    const expected: NotReached[] = [
      { name: "Chat Not Opened", reason: "not_opened" },
      { name: "Chat No Numbers", reason: "no_numbers" },
      { name: "Chat Not Loaded", reason: "messages_not_loaded" },
      { name: "Chat Unsettled", reason: "history_not_settled" },
      { name: "Chat Empty", reason: "no_messages" },
      { name: "Chat Truncated", reason: "history_truncated" },
      { name: "Chat Truncated", reason: "images_failed", count: 2 },
      { name: "Chat Save Failed", reason: "error" },
    ];
    expect(t.finish()).toMatchObject({ notReached: expected, notReachedMore: 0 });
    expect(outcome.notReached).toEqual(expected);
    // "Chat No Numbers" is reported without asking Keepr (it cannot be checked).
    const matched = t.calls.filter(([, p]) => p.endsWith("/match")).length;
    expect(matched).toBe(7);

    // BACKLOG-3641 founder UX: one line on the page; the list is in Details.
    expect(t.shown[t.shown.length - 1]).toBe(job.DONE_LINE);
    expect(job.DONE_LINE).toBe("Sync done — switch back to Keepr.");
    const done = t.details[t.details.length - 1];
    expect(done).toContain("Scanned 9 chats");
    // The scan counts are diagnostics: in the Copy text (cache Sync).
    expect(t.copies[t.copies.length - 1]).toContain("Checked 8 · matched 6 · sent ");
    for (const e of expected) expect(done).toContain(e.name);
    expect(done).toContain("images not imported: 2");
    expect(done).toContain("only the newest messages imported");
    expect(done).not.toContain("Chat Not Theirs");
    expect(done).not.toContain("Chat Fine");
  });

  it("nothing left out: one line on the page, and Details is just the counts", async () => {
    const t = planJob([{ name: "Chat Fine", matched: true }]);
    await job.runJob(JOB, t.env);
    expect(t.finish()).toMatchObject({ notReached: [], notReachedMore: 0 });
    expect(t.shown[t.shown.length - 1]).toBe(job.DONE_LINE);
    const done = t.details[t.details.length - 1];
    expect(done).toBe(
      "Scanned 1 chat · Keepr is still saving — see Keepr for the result\n" +
        "History start: 0 confirmed by the start marker · 0 complete on the first page · 0 without scrolling · 0 reached the months limit · 1 not confirmed\n" +
        "History depth: 0 chats reached the 9-month limit · 1 reached the chat's start · 0 not fully loaded",
    );
  });

  // SR S2: how each chat's history start was confirmed — per chat in the step
  // log, a count per kind in the summary and /finish. Mutation: kind not
  // recorded / not counted → red.
  it("history start: confirmedBy per chat in the step log, counted per kind", async () => {
    const t = planJob([
      { name: "Chat Marker", matched: true },
      { name: "Chat First Page", matched: true },
      { name: "Chat Unconfirmed", matched: true },
    ]);
    const kinds = ["marker", "first_page", undefined];
    let n = 0;
    (t.env.scan as Record<string, unknown>).loadHistory = async () => {
      const confirmedBy = kinds[n++];
      return { stopReason: confirmedBy ? "no_more" : "not_settled", count: 1, scrolls: 0, nudges: 0, ...(confirmedBy ? { confirmedBy } : {}) };
    };
    await job.runJob(JOB, t.env);
    expect(t.finish()).toMatchObject({ historyConfirmed: { marker: 1, first_page: 1, none: 1 } });
    const copy = t.copies[t.copies.length - 1];
    expect(copy).toContain("start confirmed by marker");
    expect(copy).toContain("start confirmed by first_page");
    expect(copy).toContain("start confirmed by none");
    expect(t.details[t.details.length - 1]).toContain(
      "History start: 1 confirmed by the start marker · 1 complete on the first page · 0 without scrolling · 0 reached the months limit · 1 not confirmed",
    );
  });

  // Live (founder 2026-10-03): every checked chat failed, none imported →
  // the run FAILED ("Sync failed"), never "done". Mutation: the rule removed → red.
  it("every checked chat failed: a failed run, no /finish", async () => {
    const t = planJob(Array.from({ length: 3 }, (_, i) => ({ name: `Chat ${i}`, open: "throws" as const })));
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("all_failed");
    expect(t.calls.map(([, p]) => p).some((p) => p.endsWith("/finish"))).toBe(false);
    expect(t.calls.map(([, p]) => p).some((p) => p.endsWith("/error"))).toBe(true);
    expect(t.shown[t.shown.length - 1]).toBe("None of the chats could be read.");
    expect(t.details[t.details.length - 1]).toContain("None of the 3 chats could be read.");
  });

  it("caps the named list at 20 and counts the rest as '+N more' (M7)", async () => {
    const plans: Plan[] = Array.from({ length: 25 }, (_, i) => ({ name: `Chat ${i}`, open: "throws" as const }));
    // One chat read (a partial success stays "done" with its list — live rule).
    plans.push({ name: "Chat Read", matched: true });
    const t = planJob(plans);
    await job.runJob(JOB, t.env);
    const body = t.finish() as { notReached: NotReached[]; notReachedMore: number };
    expect(body.notReached).toHaveLength(20);
    expect(body.notReachedMore).toBe(5);
    const done = t.details[t.details.length - 1];
    expect(done).toContain("Chat 19 (could not be opened)");
    expect(done).not.toContain("Chat 20 ");
    expect(done).toContain("+5 more");
  });
});
