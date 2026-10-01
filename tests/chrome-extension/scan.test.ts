/**
 * BACKLOG-3620 — the conversation-list scan, Details reading and the job runner.
 *
 * Runs chrome-extension/scan.js and job.js (the same files the content script
 * loads) against synthetic fixtures whose headers state what was observed on
 * the live page and what is unverified.
 *
 * Control 10: the scan loads a lazily rendered list fully and stops (stable
 *             count over 3 scrolls, or the item cap).
 * Control 11: Details is closed with Done, and its participant rows are gone,
 *             before the scan moves on.
 * Control 12: on the sign-in page the job reports not_signed_in and scans nothing.
 */

import * as fs from "fs";
import * as path from "path";

interface Conv {
  conversationId: string;
  name: string;
  href: string;
}

interface ScanModule {
  signInState: (pathname: string) => string;
  readConversationList: (doc: Document) => Conv[];
  collectConversations: (
    doc: Document,
    opts: {
      scroll: () => void | Promise<void>;
      sleep: (ms: number) => Promise<void>;
      now?: () => number;
      waitMs?: number;
      stableRounds?: number;
      maxItems?: number;
      maxMs?: number;
    },
  ) => Promise<{ conversations: Conv[]; stopReason: string }>;
  pickCandidates: (
    conversations: Conv[],
    contacts: Array<{ contactId: string; displayName: string }>,
  ) => Array<{ conversation: Conv; reason: string }>;
  readParticipantsAndClose: (
    doc: Document,
    io: { click: (el: Element) => void; sleep: (ms: number) => Promise<void>; timeoutMs?: number },
  ) => Promise<string[]>;
}

interface ApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

interface JobModule {
  jobIdFromHash: (hash: string) => string | null;
  NOT_SIGNED_IN: string;
  runJob: (jobId: string, env: Record<string, unknown>) => Promise<{ outcome: string }>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as ScanModule;
const job = require("../../chrome-extension/job.js") as JobModule;
const extract = require("../../chrome-extension/extract.js") as {
  extractConversation: (doc: Document, href: string, now: Date) => unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const LIST = fs.readFileSync(path.join(__dirname, "fixtures", "conversation-list.synthetic.html"), "utf8");
const DETAILS = fs.readFileSync(path.join(__dirname, "fixtures", "details.synthetic.html"), "utf8");

// Every harness sleep resolves at once, so a loop that never stops starves the
// event loop and jest's own timeout never fires. Each sleep counts toward a
// per-test budget and throws past it, so a runaway loop fails in seconds.
// (The longest real test here sleeps a few hundred times.)
const SLEEP_BUDGET = 20_000;
let sleepCalls = 0;
beforeEach(() => {
  sleepCalls = 0;
});
function budget(): void {
  sleepCalls += 1;
  if (sleepCalls > SLEEP_BUDGET) throw new Error(`test harness: more than ${SLEEP_BUDGET} sleeps — runaway loop`);
}
jest.setTimeout(10_000);

const noSleep = (): Promise<void> => {
  budget();
  return Promise.resolve();
};

function listItem(id: string, name: string): string {
  return `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${id}"><span data-e2e-conversation-name>${name}</span></a></mws-conversation-list-item>`;
}

function appendItems(from: number, count: number): void {
  const scroller = document.getElementById("list-scroller");
  if (!scroller) throw new Error("fixture has no #list-scroller");
  let html = "";
  for (let i = from; i < from + count; i++) html += listItem(`lazy${String(i).padStart(15, "0")}`, `Lazy Person ${i}`);
  scroller.insertAdjacentHTML("beforeend", html);
}

describe("readConversationList / signInState", () => {
  beforeEach(() => {
    document.body.innerHTML = LIST;
  });

  it("reads id, name and link of every list item", () => {
    const list = scan.readConversationList(document);
    expect(list.map((c) => c.conversationId)).toEqual([
      "aaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbb",
      "ccccccccccccccccccc",
      "ddddddddddddddddddd",
      "eeeeeeeeeeeeeeeeeee",
    ]);
    expect(list[0]).toEqual({
      conversationId: "aaaaaaaaaaaaaaaaaaa",
      name: "Test Contact A",
      href: "/web/conversations/aaaaaaaaaaaaaaaaaaa",
    });
  });

  it.each([
    ["/web/welcome", "not_signed_in"],
    ["/web/authentication", "not_signed_in"],
    ["/web/conversations", "signed_in"],
    ["/web/conversations/aaaaaaaaaaaaaaaaaaa", "signed_in"],
    ["/", "unknown"],
  ])("%s -> %s", (p, state) => {
    expect(scan.signInState(p)).toBe(state);
  });
});

describe("collectConversations (control 10)", () => {
  beforeEach(() => {
    document.body.innerHTML = LIST;
  });

  it("loads a lazy list that only grows on some scrolls, then stops after 3 unchanged scrolls", async () => {
    // Every OTHER scroll renders 10 more items, up to 40 more (then the list ends).
    let scrolls = 0;
    let added = 0;
    const result = await scan.collectConversations(document, {
      scroll: () => {
        scrolls += 1;
        if (scrolls % 2 === 0 && added < 40) {
          appendItems(added, 10);
          added += 10;
        }
      },
      sleep: noSleep,
    });
    expect(result.conversations).toHaveLength(45);
    expect(result.stopReason).toBe("stable");
    // The list stopped growing at scroll 8; three unchanged scrolls follow.
    expect(scrolls).toBe(11);
  });

  it("a list that never grows is scrolled exactly 3 times", async () => {
    let scrolls = 0;
    const result = await scan.collectConversations(document, {
      scroll: () => {
        scrolls += 1;
      },
      sleep: noSleep,
    });
    expect(result.conversations).toHaveLength(5);
    expect(scrolls).toBe(3);
  });

  it("a list that never stops growing stops at the item cap", async () => {
    let added = 0;
    let t = 0;
    const result = await scan.collectConversations(document, {
      scroll: () => {
        appendItems(added, 10);
        added += 10;
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      maxItems: 50,
      maxMs: 60_000,
    });
    expect(result.stopReason).toBe("max_items");
    expect(result.conversations).toHaveLength(50);
  });
});

describe("pickCandidates", () => {
  beforeEach(() => {
    document.body.innerHTML = LIST;
  });

  it("is loose on names (the phone check is the gate) and always includes number-named chats", () => {
    const list = scan.readConversationList(document);
    const picked = scan.pickCandidates(list, [
      { contactId: "c-1", displayName: "Test Contact A" },
      { contactId: "c-2", displayName: "Test Contact" },
      { contactId: "c-3", displayName: "Unknown" },
    ]);
    expect(picked.map((p) => [p.conversation.conversationId, p.reason])).toEqual([
      ["aaaaaaaaaaaaaaaaaaa", "name"],
      ["ccccccccccccccccccc", "phone_name"],
      ["ddddddddddddddddddd", "name_loose"],
      ["eeeeeeeeeeeeeeeeeee", "name_loose"],
    ]);
  });

  it("a contact named Unknown matches nothing by name", () => {
    const list = scan.readConversationList(document).filter((c) => c.conversationId !== "ccccccccccccccccccc");
    expect(scan.pickCandidates(list, [{ contactId: "c-3", displayName: "Unknown" }])).toEqual([]);
  });
});

/**
 * Wires the Details fixture the way the page behaves: the menu button renders
 * the Details item; Details renders the participant panel; Done removes it.
 */
type DetailsRow = string | { name: string; number: string };
function mountDetails(numbers: DetailsRow[]): { clicks: string[]; click: (el: Element) => void } {
  document.body.innerHTML = DETAILS;
  const clicks: string[] = [];
  const click = (el: Element): void => {
    if (el.matches("[data-e2e-conversation-menu-button]")) {
      clicks.push("menu");
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div role="menu" id="menu"><button data-e2e-details-button>Details</button></div>',
      );
    } else if (el.matches("[data-e2e-details-button]")) {
      clicks.push("details");
      document.getElementById("menu")?.remove();
      const rows = numbers
        .map((n, i) => {
          const r = typeof n === "string" ? { name: `Person ${i}`, number: n } : n;
          return `<li data-e2e-details-participant><h3 data-e2e-details-participant-name>${r.name}</h3><span data-e2e-details-participant-number>${r.number}</span></li>`;
        })
        .join("");
      document.getElementById("overlay-container")?.insertAdjacentHTML(
        "beforeend",
        `<mw-conversation-details><ul>${rows}</ul></mw-conversation-details><div class="dialog-actions"><button aria-label="Done">Done</button></div>`,
      );
    } else if (el.matches('button[aria-label="Done"]')) {
      clicks.push("done");
      document.getElementById("overlay-container")!.innerHTML = "";
    }
  };
  return { clicks, click };
}

describe("readParticipantsAndClose (control 11)", () => {
  it("reads every participant's number, clicks Done, and returns only once the rows are gone", async () => {
    const page = mountDetails(["(555) 555-0199", "(555) 555-0101"]);
    const numbers = await scan.readParticipantsAndClose(document, { click: page.click, sleep: noSleep });
    expect(numbers).toEqual(["(555) 555-0199", "(555) 555-0101"]);
    expect(page.clicks).toEqual(["menu", "details", "done"]);
    expect(document.querySelector("li[data-e2e-details-participant]")).toBeNull();
  });

  it("an unsaved contact has an empty number span and the number in the name heading: that number is read; a plain name or a short number is not", async () => {
    const page = mountDetails([
      { name: "Test Contact A", number: "(555) 555-0101" }, // saved: name in h3, number in span
      { name: "(555) 555-0199", number: "" }, // unsaved: number in h3, span empty
      { name: "+1 555-555-0102", number: "" }, // unsaved, international form
      { name: "Test Contact B", number: "" }, // a name and no number: nothing
      { name: "(555) 555-01", number: "" }, // 8 digits: not a number
    ]);
    const numbers = await scan.readParticipantsAndClose(document, { click: page.click, sleep: noSleep });
    expect(numbers).toEqual(["(555) 555-0101", "(555) 555-0199", "+1 555-555-0102"]);
  });

  it("rejects when Details never closes", async () => {
    const page = mountDetails(["(555) 555-0199"]);
    const stuck = (el: Element): void => {
      if (el.matches('button[aria-label="Done"]')) return; // Done does nothing
      page.click(el);
    };
    await expect(
      scan.readParticipantsAndClose(document, { click: stuck, sleep: noSleep, timeoutMs: 500 }),
    ).rejects.toThrow("Details to close");
  });
});

describe("job runner", () => {
  const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row

  it("reads the job id from the page address hash", () => {
    expect(job.jobIdFromHash(`#keepr-job=${JOB}`)).toBe(JOB);
    expect(job.jobIdFromHash("#other")).toBeNull();
  });

  it("control 12: on the sign-in page it reports not_signed_in, shows the message, and scans nothing", async () => {
    document.body.innerHTML = "<mw-welcome-page-container><button data-e2e-welcome-page-sign-in-button>Sign in</button></mw-welcome-page-container>";
    const calls: Array<[string, string, unknown]> = [];
    const shown: Array<[string, boolean]> = [];
    const collect = jest.fn();
    const outcome = await job.runJob(JOB, {
      doc: document,
      getLocation: () => ({ pathname: "/web/welcome", href: "https://messages.google.com/web/welcome?redirectUrl=x" }),
      api: async (method: string, p: string, body: unknown): Promise<ApiReply> => {
        calls.push([method, p, body]);
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: { show: (text: string, isError: boolean) => shown.push([text, isError]) },
      sleep: noSleep,
      pageTimeoutMs: 1000,
      scan: { ...scan, collectConversations: collect },
    });
    expect(outcome.outcome).toBe("not_signed_in");
    expect(calls).toEqual([
      ["POST", `/job/${JOB}/error`, { code: "not_signed_in", message: job.NOT_SIGNED_IN }],
    ]);
    expect(job.NOT_SIGNED_IN).toBe("Sign in to Google Messages, then click Sync in Keepr again");
    expect(shown).toEqual([[job.NOT_SIGNED_IN, true]]);
    expect(collect).not.toHaveBeenCalled();
  });

  it("imports only the chat Keepr matched, closes Details before the next chat, uploads its image, then finishes", async () => {
    document.body.innerHTML = LIST;
    const listHtml = document.body.innerHTML;
    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const order: string[] = [];
    let open = "";
    const detailsNumbers: Record<string, string[]> = {
      aaaaaaaaaaaaaaaaaaa: ["(555) 555-0199"],
      ccccccccccccccccccc: ["(555) 555-0101"],
      ddddddddddddddddddd: ["(555) 555-0102", "(555) 555-0103"],
      eeeeeeeeeeeeeeeeeee: ["(555) 555-0104"],
    };
    let page = mountDetails([]);
    const env = {
      doc: document,
      getLocation: () => ({
        pathname: `/web/conversations/${open}`,
        href: `https://messages.google.com/web/conversations/${open}`,
      }),
      api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
        calls.push([method, p, body]);
        if (p.endsWith("/claim")) {
          return { ok: true, status: 200, body: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }, { contactId: "c-2", displayName: "Test Contact" }] } };
        }
        if (p.endsWith("/match")) {
          order.push(`match:${String(body?.conversationId)}`);
          // Participant rows must be gone when Keepr is asked.
          expect(document.querySelector("li[data-e2e-details-participant]")).toBeNull();
          const matched = body?.conversationId === "aaaaaaaaaaaaaaaaaaa";
          return { ok: true, status: 200, body: { matched, contactIds: matched ? ["c-1"] : [] } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: { show: () => {} },
      sleep: noSleep,
      click: (el: Element) => page.click(el),
      scroll: () => {},
      openConversation: async (conv: Conv) => {
        order.push(`open:${conv.conversationId}`);
        expect(document.querySelector("li[data-e2e-details-participant]")).toBeNull();
        open = conv.conversationId;
        page = mountDetails(detailsNumbers[conv.conversationId] ?? []);
        if (open === "aaaaaaaaaaaaaaaaaaa") {
          document.body.insertAdjacentHTML(
            "beforeend",
            `<mws-message-wrapper msg-id="1"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
              <mws-text-message-part aria-label="Test Contact A said: hello. Received on September 20, 2026 at 9:05 AM."><mws-message-part-content data-e2e-message-content>hello</mws-message-part-content></mws-text-message-part>
              <mws-image-message-part aria-label="Test Contact A sent an image. Received on September 20, 2026 at 9:05 AM."><div data-e2e-message-image><img src="blob:https://messages.google.com/x-1"></div></mws-image-message-part>
            </div></mws-message-wrapper>`,
          );
        }
      },
      readImage: async (src: string) => ({ mimeType: "image/gif", base64: `B64(${src})` }),
      extract: extract.extractConversation,
      scan,
    };
    // The list is read first, from the list page.
    document.body.innerHTML = listHtml;
    const outcome = await job.runJob(JOB, env);
    expect(outcome.outcome).toBe("finished");

    const posts = calls.filter(([m]) => m === "POST").map(([, p]) => p.replace(`/job/${JOB}`, ""));
    expect(posts.filter((p) => p === "/chat")).toHaveLength(1);
    const chat = calls.find(([, p]) => p.endsWith("/chat"))?.[2] as { conversationId: string; messages: Array<Record<string, unknown>> };
    expect(chat.conversationId).toBe("aaaaaaaaaaaaaaaaaaa");
    expect(chat.messages[0]).not.toHaveProperty("imageSrcs");
    expect(chat.messages[0]).toMatchObject({ images: 1, text: "hello" });
    const upload = calls.find(([, p]) => p.endsWith("/attachment"))?.[2];
    expect(upload).toEqual({
      conversationId: "aaaaaaaaaaaaaaaaaaa",
      msgId: "1",
      index: 0,
      mimeType: "image/gif",
      base64: "B64(blob:https://messages.google.com/x-1)",
    });
    expect(posts[posts.length - 1]).toBe("/finish");
    // BACKLOG-3645: EVERY chat is checked (5 ≤ the cap); names only order the
    // queue — exact name, loose name, number-only, then the rest. Each match
    // is asked after its Details closed. The last chat shows no number, so it
    // is reported (no_numbers) and never sent to /match.
    expect(order).toEqual([
      "open:aaaaaaaaaaaaaaaaaaa", "match:aaaaaaaaaaaaaaaaaaa",
      "open:ddddddddddddddddddd", "match:ddddddddddddddddddd",
      "open:eeeeeeeeeeeeeeeeeee", "match:eeeeeeeeeeeeeeeeeee",
      "open:ccccccccccccccccccc", "match:ccccccccccccccccccc",
      "open:bbbbbbbbbbbbbbbbbbb",
    ]);
  });
});

/** One synthetic message wrapper (observed shape, see the conversation fixture). */
function wrapper(msgId: string, text: string): string {
  return `<mws-message-wrapper msg-id="${msgId}"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
    <mws-text-message-part aria-label="Test Contact A said: ${text}. Received on September 20, 2026 at 9:05 AM."><mws-message-part-content data-e2e-message-content>${text}</mws-message-part-content></mws-text-message-part>
  </div></mws-message-wrapper>`;
}

const STALE = wrapper("900", "stale one") + wrapper("901", "stale two");
const FRESH = wrapper("1", "hello");

/**
 * A job page driven by a fake clock: `sleep(ms)` advances it. The message pane
 * starts with the PREVIOUS chat's messages (STALE). Opening chat A keeps them
 * on screen until `swapAfterMs` of clock have passed (null = never), then
 * replaces them with A's own (FRESH) — the shape measured live on 2026-09-29.
 */
function jobPage(opts: {
  swapAfterMs: number | null;
  api?: (method: string, p: string, body?: Record<string, unknown>) => ApiReply | undefined;
  onOpen?: (id: string) => void;
}) {
  const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const opened: string[] = [];
  const shown: Array<[string, boolean]> = [];
  let clock = 0;
  let pane = STALE;
  let swapAt: number | null = null;
  let open = "";
  let page = mountDetails([]);
  const renderPane = (): void => {
    document.getElementById("pane")?.remove();
    document.body.insertAdjacentHTML("beforeend", `<div id="pane">${pane}</div>`);
  };
  const tick = (): void => {
    if (swapAt !== null && clock >= swapAt && pane !== FRESH) {
      pane = FRESH;
      renderPane();
    }
  };
  document.body.innerHTML = LIST;
  renderPane();
  const env = {
    doc: document,
    getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
    api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
      calls.push([method, p, body]);
      const custom = opts.api?.(method, p, body);
      if (custom) return custom;
      if (p.endsWith("/claim")) {
        return { ok: true, status: 200, body: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }, { contactId: "c-2", displayName: "Test Contact" }] } };
      }
      if (p.endsWith("/match")) {
        const matched = body?.conversationId === "aaaaaaaaaaaaaaaaaaa";
        return { ok: true, status: 200, body: { matched, contactIds: matched ? ["c-1"] : [] } };
      }
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: { show: (text: string, isError: boolean) => shown.push([text, isError]) },
    sleep: async (ms: number) => {
      budget();
      clock += ms;
      tick();
    },
    click: (el: Element) => page.click(el),
    scroll: () => {},
    openConversation: async (conv: Conv) => {
      opened.push(conv.conversationId);
      open = conv.conversationId;
      page = mountDetails(["(555) 555-0199"]);
      if (open === "aaaaaaaaaaaaaaaaaaa" && opts.swapAfterMs !== null) swapAt = clock + opts.swapAfterMs;
      renderPane();
      opts.onOpen?.(open);
    },
    readImage: async () => null,
    extract: extract.extractConversation,
    scan,
  };
  const posts = (): string[] => calls.filter(([m]) => m === "POST").map(([, p]) => p.replace(`/job/${JOB}`, ""));
  return { JOB, env, calls, opened, shown, posts };
}

describe("SR fix 1: a job Keepr no longer knows ends the run", () => {
  it("/progress answering 410 after the first chat stops the page: no further chats, no /finish, no /error", async () => {
    let progressCalls = 0;
    const t = jobPage({
      swapAfterMs: 0,
      api: (_m, p) => {
        if (p.endsWith("/progress")) {
          progressCalls += 1;
          // 1st = the pre-loop "Checking N chats"; 2nd = after chat 1.
          if (progressCalls >= 2) return { ok: false, status: 410, body: { error: "job_over" } };
        }
        return undefined;
      },
    });
    const outcome = await job.runJob(t.JOB, t.env);
    expect(outcome.outcome).toBe("job_gone");
    expect(t.opened).toEqual(["aaaaaaaaaaaaaaaaaaa"]);
    expect(t.posts()).not.toContain("/finish");
    expect(t.posts()).not.toContain("/error");
    expect(t.shown[t.shown.length - 1]).toEqual(["Sync cancelled in Keepr", true]);
  });

  it("/match answering 404 is not counted as a skipped chat — the run ends", async () => {
    const t = jobPage({
      swapAfterMs: 0,
      api: (_m, p) => (p.endsWith("/match") ? { ok: false, status: 404, body: { error: "no_job" } } : undefined),
    });
    const outcome = await job.runJob(t.JOB, t.env);
    expect(outcome.outcome).toBe("job_gone");
    expect(t.opened).toEqual(["aaaaaaaaaaaaaaaaaaa"]);
    expect(t.posts()).not.toContain("/finish");
  });
});

describe("SR fix 2: Details rows from an earlier chat", () => {
  it("readParticipantsAndClose throws details_stuck when participant rows are on screen before the menu click", async () => {
    const page = mountDetails(["(555) 555-0109"]);
    page.click(document.querySelector("[data-e2e-conversation-menu-button]")!);
    page.click(document.querySelector("[data-e2e-details-button]")!);
    page.clicks.length = 0; // the earlier chat's Details is open and never closed
    let result: string[] | undefined;
    const err = await scan
      .readParticipantsAndClose(document, { click: page.click, sleep: noSleep, timeoutMs: 500 })
      .then((r) => {
        result = r;
        return null;
      }, (e: Error & { code?: string }) => e);
    expect(result).toBeUndefined();
    expect(err?.code).toBe("details_stuck");
    expect(page.clicks).toEqual([]);
  });

  it("the job fails with details_stuck instead of skipping: no /match for that chat, no /finish", async () => {
    const t = jobPage({
      swapAfterMs: 0,
      onOpen: (id) => {
        if (id === "ccccccccccccccccccc") {
          document.body.insertAdjacentHTML(
            "beforeend",
            "<mw-conversation-details><ul><li data-e2e-details-participant><span data-e2e-details-participant-number>(555) 555-0199</span></li></ul></mw-conversation-details>",
          );
        }
      },
    });
    const outcome = await job.runJob(t.JOB, t.env);
    expect(outcome.outcome).toBe("details_stuck");
    const matches = t.calls.filter(([, p]) => p.endsWith("/match")).map(([, , b]) => b?.conversationId);
    // The queue is a, d, e (names) then c: c is where Details sticks.
    expect(matches).toEqual(["aaaaaaaaaaaaaaaaaaa", "ddddddddddddddddddd", "eeeeeeeeeeeeeeeeeee"]);
    const err = t.calls.find(([, p]) => p.endsWith("/error"));
    expect(err?.[2]).toMatchObject({ code: "details_stuck" });
    expect(t.posts()).not.toContain("/finish");
    expect(t.opened).toEqual(["aaaaaaaaaaaaaaaaaaa", "ddddddddddddddddddd", "eeeeeeeeeeeeeeeeeee", "ccccccccccccccccccc"]);
  });
});

describe("chat switch readiness (live measurement 2026-09-29)", () => {
  it("the previous chat's messages stay 2 s after the click: only the new chat's messages are sent", async () => {
    const t = jobPage({ swapAfterMs: 2000 });
    const outcome = await job.runJob(t.JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    const chats = t.calls.filter(([, p]) => p.endsWith("/chat"));
    expect(chats).toHaveLength(1);
    const sent = chats[0][2] as { conversationId: string; messages: Array<{ msgId: string; text: string }> };
    expect(sent.conversationId).toBe("aaaaaaaaaaaaaaaaaaa");
    expect(sent.messages.map((m) => m.msgId)).toEqual(["1"]);
    expect(sent.messages[0].text).toBe("hello");
  });

  it("messages that never change: the chat is skipped as messages_not_loaded, nothing sent, the job still finishes", async () => {
    const t = jobPage({ swapAfterMs: null });
    const outcome = (await job.runJob(t.JOB, t.env)) as { outcome: string; skips?: Array<{ conversationId: string; reason: string }> };
    expect(outcome.outcome).toBe("finished");
    expect(t.calls.filter(([, p]) => p.endsWith("/chat"))).toHaveLength(0);
    expect(outcome.skips).toEqual([{ conversationId: "aaaaaaaaaaaaaaaaaaa", reason: "messages_not_loaded" }]);
    expect(t.posts()[t.posts().length - 1]).toBe("/finish");
  });

  it("waitForMessageSwap: an empty pane never counts as ready, a new set must hold 500 ms", async () => {
    const s = scan as unknown as {
      messageIdSet: (d: Document) => string;
      waitForMessageSwap: (d: Document, before: string, io: { sleep: (ms: number) => Promise<void>; timeoutMs?: number }) => Promise<boolean>;
    };
    document.body.innerHTML = `<div id="pane">${STALE}</div>`;
    const before = s.messageIdSet(document);
    document.getElementById("pane")!.innerHTML = "";
    let clock = 0;
    expect(await s.waitForMessageSwap(document, before, { sleep: async (ms) => { clock += ms; } })).toBe(false);
    expect(clock).toBe(8000);

    // New set appears at 300 ms, then a second message at 600 ms: ready only
    // after the set stops changing for 500 ms.
    document.getElementById("pane")!.innerHTML = STALE;
    clock = 0;
    const ready = await s.waitForMessageSwap(document, before, {
      sleep: async (ms) => {
        clock += ms;
        if (clock === 300) document.getElementById("pane")!.innerHTML = FRESH;
        if (clock === 600) document.getElementById("pane")!.insertAdjacentHTML("beforeend", wrapper("2", "second"));
      },
    });
    expect(ready).toBe(true);
    expect(clock).toBe(1100);
  });
});

// ---------------------------------------------------------------------------
// History loading (live measurement #2, 2026-09-29: only the latest 25
// messages render when a chat opens). Synthetic chats only.
// ---------------------------------------------------------------------------

interface HistoryModule {
  findMessageScroller: (doc: Document) => Element | null;
  loadHistory: (
    doc: Document,
    io: {
      scrollUp: () => void | Promise<void>;
      sleep: (ms: number) => Promise<void>;
      oldestMs: () => number | null;
      floorMs?: number | null;
      cap?: number;
      noNewTimeoutMs?: number;
      onProgress?: (n: number) => void;
    },
  ) => Promise<{ stopReason: string; count: number; scrolls: number }>;
}
const hist = scan as unknown as HistoryModule;
const extractFn = extract.extractConversation as (d: Document, h: string, n: Date) => {
  messages: Array<{ msgId: string; sentAt: string }>;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PAGE = 25;

/** Message i of a synthetic chat: i = 0 is the newest, one per day going back from 2026-09-20 09:05 local. */
function historyDate(i: number): Date {
  return new Date(2026, 8, 20 - i, 9, 5);
}
function historyWrapper(i: number): string {
  const d = historyDate(i);
  const phrase = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at 9:05 AM`;
  return `<mws-message-wrapper msg-id="h${i}"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
    <mws-text-message-part aria-label="Test Contact A said: note ${i}. Received on ${phrase}."><mws-message-part-content data-e2e-message-content>note ${i}</mws-message-part-content></mws-text-message-part>
  </div></mws-message-wrapper>`;
}

/**
 * A chat pane holding the latest 25 of `total` messages. `scrollUp()` asks for
 * 25 older ones, which appear `loadDelayMs` of clock later (clock advanced by
 * `sleep`). `virtualized`: the pane only ever holds the 25 oldest loaded.
 */
function historyPane(opts: { total: number; loadDelayMs?: number; virtualized?: boolean }) {
  const delay = opts.loadDelayMs ?? 400;
  let loaded = Math.min(PAGE, opts.total);
  let clock = 0;
  let pendingAt: number | null = null;
  const scrollClocks: number[] = [];
  const render = (): void => {
    const from = opts.virtualized ? Math.max(0, loaded - PAGE) : 0;
    let html = "";
    for (let i = loaded - 1; i >= from; i--) html += historyWrapper(i);
    const pane = document.getElementById("pane");
    if (pane) pane.innerHTML = html;
    else document.body.insertAdjacentHTML("beforeend", `<div id="pane">${html}</div>`);
  };
  const tick = (): void => {
    if (pendingAt !== null && clock >= pendingAt) {
      pendingAt = null;
      loaded = Math.min(opts.total, loaded + PAGE);
      render();
    }
  };
  return {
    render,
    clock: () => clock,
    scrollClocks,
    scrollUp: (): void => {
      scrollClocks.push(clock);
      if (loaded < opts.total && pendingAt === null) pendingAt = clock + delay;
    },
    sleep: async (ms: number): Promise<void> => {
      budget();
      clock += ms;
      // The longest real case (the cap test) uses ~32 s of clock; far past that is a loop.
      if (clock > 500_000) throw new Error("history harness: runaway loop");
      tick();
    },
    oldestMs: (): number | null => {
      const msgs = extractFn(document, "https://messages.google.com/web/conversations/aaaaaaaaaaaaaaaaaaa", new Date(2026, 8, 21)).messages;
      if (msgs.length === 0) return null;
      return Math.min(...msgs.map((m) => Date.parse(m.sentAt)));
    },
  };
}

describe("findMessageScroller: picked by computed style", () => {
  function sized(el: Element, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  }

  it("returns the nearest ancestor with overflow-y auto/scroll whose content overflows it", () => {
    document.body.innerHTML = `<div id="outer" style="overflow-y: auto"><div id="anchored" style="overflow-y: scroll"><div id="clipped" style="overflow-y: auto"><div id="list">${historyWrapper(0)}</div></div></div></div>`;
    sized(document.getElementById("list")!, 5000, 400); // overflows but overflow-y visible
    sized(document.getElementById("clipped")!, 400, 400); // scrollable style, nothing to scroll
    sized(document.getElementById("anchored")!, 5000, 600); // the one
    sized(document.getElementById("outer")!, 9000, 800);
    expect(hist.findMessageScroller(document)?.id).toBe("anchored");
  });

  it("returns null when no ancestor scrolls, or there are no messages", () => {
    document.body.innerHTML = `<div id="list">${historyWrapper(0)}</div>`;
    sized(document.getElementById("list")!, 5000, 400);
    expect(hist.findMessageScroller(document)).toBeNull();
    document.body.innerHTML = `<div style="overflow-y: auto"></div>`;
    expect(hist.findMessageScroller(document)).toBeNull();
  });
});

describe("loadHistory: scroll up until the start date, nothing new, or the cap", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stops once the oldest loaded message is earlier than the date floor", async () => {
    const p = historyPane({ total: 200 });
    p.render();
    const floorMs = new Date(2026, 8, 20 - 60).getTime(); // midnight of message 60's day
    const r = await hist.loadHistory(document, { scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs });
    expect(r).toEqual({ stopReason: "date_floor", count: 75, scrolls: 2 });
    expect(p.oldestMs()).toBe(historyDate(74).getTime());
  });

  it("a message dated exactly at the floor is inside the window: one more scroll is needed", async () => {
    const p = historyPane({ total: 200 });
    p.render();
    const r = await hist.loadHistory(document, {
      scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs: historyDate(49).getTime(),
    });
    expect(r).toEqual({ stopReason: "date_floor", count: 75, scrolls: 2 });
  });

  it("does not scroll at all when the first 25 already reach past the floor", async () => {
    const p = historyPane({ total: 200 });
    p.render();
    const r = await hist.loadHistory(document, {
      scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs: historyDate(10).getTime(),
    });
    expect(r).toEqual({ stopReason: "date_floor", count: 25, scrolls: 0 });
    expect(p.scrollClocks).toEqual([]);
  });

  it("stops when a scroll brings nothing new within 3 s", async () => {
    const p = historyPane({ total: 60 });
    p.render();
    const r = await hist.loadHistory(document, { scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs: null });
    expect(r).toEqual({ stopReason: "no_more", count: 60, scrolls: 3 });
    // The last scroll waited the full 3 s before giving up.
    expect(p.clock() - p.scrollClocks[2]).toBe(3000);
  });

  it("a slow load (2.5 s) still counts; one slower than 3 s ends the load", async () => {
    const slow = historyPane({ total: 60, loadDelayMs: 2500 });
    slow.render();
    expect(await hist.loadHistory(document, { scrollUp: slow.scrollUp, sleep: slow.sleep, oldestMs: slow.oldestMs })).toMatchObject({
      stopReason: "no_more", count: 60,
    });
    document.body.innerHTML = "";
    const tooSlow = historyPane({ total: 60, loadDelayMs: 3500 });
    tooSlow.render();
    expect(await hist.loadHistory(document, { scrollUp: tooSlow.scrollUp, sleep: tooSlow.sleep, oldestMs: tooSlow.oldestMs })).toEqual({
      stopReason: "no_more", count: 25, scrolls: 1,
    });
  });

  it("stops at the 2,000-message cap", async () => {
    const p = historyPane({ total: 5000 });
    p.render();
    const r = await hist.loadHistory(document, { scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs: null });
    expect(r).toEqual({ stopReason: "cap", count: 2000, scrolls: 79 });
  });

  it("counts new msg-ids, not the number on screen: a list that drops its newest rows still loads", async () => {
    const p = historyPane({ total: 100, virtualized: true });
    p.render();
    const r = await hist.loadHistory(document, { scrollUp: p.scrollUp, sleep: p.sleep, oldestMs: p.oldestMs, floorMs: null });
    expect(r).toEqual({ stopReason: "no_more", count: 100, scrolls: 4 });
  });
});

describe("job runner: loads history before extracting a matched chat", () => {
  function historyJob(opts: {
    total: number;
    startDate: string | null;
    historyCap?: number;
    api?: (method: string, p: string, body?: Record<string, unknown>) => ApiReply | undefined;
  }) {
    const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const shown: string[] = [];
    let open = "";
    let page = mountDetails([]);
    let pane: ReturnType<typeof historyPane> | null = null;
    let clock = 0;
    document.body.innerHTML = LIST;
    const env = {
      doc: document,
      getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
      api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
        calls.push([method, p, body]);
        const custom = opts.api?.(method, p, body);
        if (custom) return custom;
        if (p.endsWith("/claim")) {
          return { ok: true, status: 200, body: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }], startDate: opts.startDate } };
        }
        if (p.endsWith("/match")) {
          const matched = body?.conversationId === "aaaaaaaaaaaaaaaaaaa";
          return { ok: true, status: 200, body: { matched, contactIds: matched ? ["c-1"] : [] } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      overlay: { show: (text: string) => shown.push(text) },
      sleep: async (ms: number) => {
        budget();
        clock += ms;
        if (pane) await pane.sleep(ms);
      },
      click: (el: Element) => page.click(el),
      scroll: () => {},
      scrollMessagesUp: () => pane?.scrollUp(),
      openConversation: async (conv: Conv) => {
        open = conv.conversationId;
        page = mountDetails(["(555) 555-0199"]);
        pane = open === "aaaaaaaaaaaaaaaaaaa" ? historyPane({ total: opts.total }) : null;
        pane?.render();
      },
      readImage: async (_src: string): Promise<{ mimeType: string; base64: string } | null> => null,
      messagesTimeoutMs: undefined as number | undefined,
      messagesStableMs: undefined as number | undefined,
      extract: extract.extractConversation,
      now: () => new Date(2026, 8, 21),
      historyCap: opts.historyCap,
      scan,
    };
    const sentIds = (): string[] => {
      const chat = calls.find(([, p]) => p.endsWith("/chat"));
      return ((chat?.[2]?.messages as Array<{ msgId: string }>) ?? []).map((m) => m.msgId);
    };
    const posts = (): string[] => calls.filter(([m]) => m === "POST").map(([, p]) => p.replace(`/job/${JOB}`, ""));
    return { JOB, env, shown, sentIds, posts, calls, clock: () => clock };
  }

  type HistoryOutcome = { outcome: string; history?: Array<{ conversationId: string; stopReason: string; count: number }> };

  it("the transaction's start date: sends every message back to the first one before it, and shows progress", async () => {
    const t = historyJob({ total: 200, startDate: new Date(2026, 8, 20 - 60).toISOString() });
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome;
    expect(outcome.outcome).toBe("finished");
    expect(outcome.history).toEqual([{ conversationId: "aaaaaaaaaaaaaaaaaaa", stopReason: "date_floor", count: 75 }]);
    const ids = t.sentIds();
    expect(ids).toHaveLength(75);
    expect(ids).toContain("h74");
    expect(ids).not.toContain("h75");
    expect(t.shown).toEqual(expect.arrayContaining(["Loading history… 25 messages", "Loading history… 50 messages", "Loading history… 75 messages"]));
  });

  it("no start date: loads until nothing new comes", async () => {
    const t = historyJob({ total: 120, startDate: null });
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome;
    expect(outcome.history).toEqual([{ conversationId: "aaaaaaaaaaaaaaaaaaa", stopReason: "no_more", count: 120 }]);
    expect(t.sentIds()).toHaveLength(120);
  });

  it("a cancel during the history load ends the run at the first checkpoint: no more scrolls, no /chat, no /finish", async () => {
    const t = historyJob({
      total: 500,
      startDate: null,
      api: (_m, p, body) =>
        p.endsWith("/progress") && String(body?.stage).startsWith("Loading history")
          ? { ok: false, status: 410, body: { error: "job_over" } }
          : undefined,
    });
    let scrolls = 0;
    const scrollUp = t.env.scrollMessagesUp;
    t.env.scrollMessagesUp = () => {
      scrolls += 1;
      return scrollUp();
    };
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome;
    expect(outcome.outcome).toBe("job_gone");
    expect(scrolls).toBe(1);
    expect(t.posts()).not.toContain("/chat");
    expect(t.posts()).not.toContain("/finish");
    expect(t.posts()).not.toContain("/error");
    // Each checkpoint carries the loaded count.
    const cp = t.calls.find(([, p, b]) => p.endsWith("/progress") && String(b?.stage).startsWith("Loading history"));
    expect(cp?.[2]?.stage).toBe("Loading history… 50 messages");
  });

  it("an image upload answering 410 ends the run: no further upload, no /finish", async () => {
    const t = historyJob({
      total: 1,
      startDate: null,
      api: (_m, p) => (p.endsWith("/attachment") ? { ok: false, status: 410, body: { error: "job_over" } } : undefined),
    });
    const open = t.env.openConversation;
    t.env.openConversation = async (conv: Conv) => {
      await open(conv);
      if (conv.conversationId === "aaaaaaaaaaaaaaaaaaa") {
        document
          .querySelector('mws-message-wrapper[msg-id="h0"] [data-e2e-message-wrapper-core]')
          ?.insertAdjacentHTML(
            "beforeend",
            `<mws-image-message-part aria-label="Test Contact A sent an image. Received on September 20, 2026 at 9:05 AM."><div data-e2e-message-image><img src="blob:https://messages.google.com/x-1"></div><div data-e2e-message-image><img src="blob:https://messages.google.com/x-2"></div></mws-image-message-part>`,
          );
      }
    };
    t.env.readImage = async (src: string) => ({ mimeType: "image/gif", base64: `B64(${src})` });
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome;
    expect(outcome.outcome).toBe("job_gone");
    expect(t.posts().filter((p) => p === "/attachment")).toHaveLength(1);
    expect(t.posts()).not.toContain("/finish");
    expect(t.posts()).not.toContain("/error");
  });

  it("a chat still changing (or emptied) after the history load is skipped as history_not_settled, not sent", async () => {
    const t = historyJob({ total: 30, startDate: null });
    t.env.messagesTimeoutMs = 1000;
    t.env.messagesStableMs = 500;
    // The first scroll empties the pane and it never refills.
    t.env.scrollMessagesUp = () => {
      document.getElementById("pane")!.innerHTML = "";
    };
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome & { skips: Array<{ reason: string }> };
    expect(outcome.outcome).toBe("finished");
    expect(outcome.skips).toEqual([{ conversationId: "aaaaaaaaaaaaaaaaaaa", reason: "history_not_settled" }]);
    expect(t.posts()).not.toContain("/chat");
    expect(t.posts()).toContain("/finish");
  });

  it("stops at the cap", async () => {
    const t = historyJob({ total: 500, startDate: null, historyCap: 50 });
    const outcome = (await job.runJob(t.JOB, t.env)) as HistoryOutcome;
    expect(outcome.history).toEqual([{ conversationId: "aaaaaaaaaaaaaaaaaaa", stopReason: "cap", count: 50 }]);
    expect(t.sentIds()).toHaveLength(50);
  });
});
