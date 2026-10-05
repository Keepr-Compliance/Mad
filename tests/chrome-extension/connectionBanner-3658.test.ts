/**
 * Google's connection banner (TRACED live, 0.3.18): `div.information-banner`
 * with a spinner and `h2.title` "Connecting" — or "Trying to reach your phone".
 * While it shows the Sync pauses; it resumes when the banner clears; past
 * RCS_CONNECTION_LOST_MS it ends with a named reason. Its spinner is never
 * "history loading".
 *
 * Mutations that turn this suite red:
 *   B1 the banner kinds mixed up / any banner read as connecting     → "kinds"
 *   B2 the banner's spinner counted as history loading               → "never history loading"
 *   B3 no pause while the banner shows                                → "pauses"
 *   B4 no give-up past the limit (the job waits forever)              → "phone_unreachable" (times out)
 *   B5 a chat loaded during the banner not loaded again               → "loaded again"
 *   B6 the time / occurrences not counted for telemetry              → "pauses"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const scan = require("../../chrome-extension/scan.js") as Record<string, any>;
const extract = require("../../chrome-extension/extract.js") as Record<string, any>;
(globalThis as Record<string, unknown>).KeeprScan = scan;
(globalThis as Record<string, unknown>).KeeprExtract = extract;
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

jest.setTimeout(10_000);

/** The live markup (no personal data in it). */
function banner(title: string, content = ""): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML =
    `<div class="information-banner single-line"><mws-spinner>` +
    `<mat-progress-spinner role="progressbar" aria-label="Loading"></mat-progress-spinner></mws-spinner>` +
    `<div class="content-container"><h2 class="title">${title}</h2><div class="content">${content}</div></div></div>`;
  return holder.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.querySelectorAll(".information-banner").forEach((b) => b.remove());
});

describe("connectionBanner (B1)", () => {
  it("kinds: connecting, phone_unreachable, any other title (length only); none / hidden → null", () => {
    expect(scan.connectionBanner(document)).toBeNull();
    document.body.appendChild(banner("Connecting"));
    expect(scan.connectionBanner(document)).toEqual({ kind: "connecting", titleLength: 10 });
    document.body.innerHTML = "";
    document.body.appendChild(banner("Trying to reach your phone", "Check that your phone is on and connected to Wi-Fi or your mobile network."));
    expect(scan.connectionBanner(document)).toMatchObject({ kind: "phone_unreachable" });
    document.body.innerHTML = "";
    document.body.appendChild(banner("Something else"));
    expect(scan.connectionBanner(document)).toEqual({ kind: "connection_banner", titleLength: 14 });
    document.body.innerHTML = "";
    const hidden = banner("Connecting");
    hidden.style.display = "none";
    document.body.appendChild(hidden);
    expect(scan.connectionBanner(document)).toBeNull();
  });

  it("the text alone is not a banner: no .information-banner, no match", () => {
    document.body.innerHTML = `<div><h2 class="title">Trying to reach your phone</h2></div>`;
    expect(scan.connectionBanner(document)).toBeNull();
  });
});

describe("the banner's spinner is never history loading (B2)", () => {
  it("a visible spinner in the pane counts; the banner's does not", () => {
    const rect = jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    try {
      document.body.innerHTML = `<mws-messages-list><mws-message-wrapper msg-id="m1"></mws-message-wrapper></mws-messages-list>`;
      const pane = document.querySelector("mws-messages-list")!;
      pane.appendChild(banner("Connecting"));
      expect(scan.loadingVisible(document, ['[role="progressbar"]', "mat-progress-spinner"])).toBe(false);
      pane.appendChild(document.createElement("mat-progress-spinner"));
      expect(scan.loadingVisible(document, ['[role="progressbar"]', "mat-progress-spinner"])).toBe(true);
    } finally {
      rect.mockRestore();
    }
  });
});

const JOB = "job-banner";
const SINCE = "2026-09-20T00:00:00.000Z";

/** A one-chat cache Sync; `onSleep(n)` runs on every sleep (to clear the banner). */
function bannerEnv(opts: { onSleep?: (n: number) => void; onLoad?: (n: number) => void; connectionLostMs?: number }) {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const shown: string[] = [];
  let sleeps = 0;
  let loads = 0;
  document.body.innerHTML =
    `<mws-conversations-list><mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/aaaaaaaaaaaaaaaaaaa">` +
    `<span data-e2e-conversation-name>Chat One</span><mws-relative-timestamp>3:45 PM</mws-relative-timestamp>` +
    `</a></mws-conversation-list-item></mws-conversations-list>`;
  const env = {
    doc: document,
    getLocation: () => ({ pathname: "/web/conversations", href: "https://messages.google.com/web/conversations" }),
    api: async (method: string, p: string, body?: Record<string, unknown>) => {
      calls.push([method, p, body]);
      if (p.endsWith("/claim")) return { ok: true, status: 200, body: { jobId: JOB, kind: "cache", contacts: [], since: SINCE, startDate: "2020-01-01T00:00:00.000Z" } };
      if (p.endsWith("/match")) return { ok: true, status: 200, body: { matched: true } };
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: { show: (t: string) => shown.push(t) },
    sleep: async () => {
      sleeps += 1;
      if (opts.onSleep) opts.onSleep(sleeps);
    },
    click: () => {},
    now: () => new Date(2026, 8, 30, 15, 0, 0),
    pageTimeoutMs: 0,
    connectionLostMs: opts.connectionLostMs,
    scan: {
      ...scan,
      collectConversations: async () => ({
        conversations: [{ conversationId: "aaaaaaaaaaaaaaaaaaa", name: "Chat One", href: "", timeMs: Date.now() }],
        stopReason: "since",
        scroll: {},
      }),
      waitForMessageSwap: async () => true,
      readParticipantsAndClose: async () => ["+15555550101"],
      messageIdSet: () => "",
      loadHistory: async () => {
        loads += 1;
        if (opts.onLoad) opts.onLoad(loads);
        return { stopReason: "no_more", count: 1, scrolls: 0, nudges: 0, confirmedBy: "first_page" };
      },
    },
    openConversation: async () => {},
    returnToList: async () => true,
    extract: () => ({
      conversationId: "aaaaaaaaaaaaaaaaaaa", title: "Chat One", skipped: { noDate: 0, noText: 0 },
      messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hi", sentAt: "2026-09-29T10:00:00.000Z", transport: "rcs", imageSrcs: [], files: [] }],
    }),
    readImage: async () => null,
  };
  return { env, calls, shown, loads: () => loads };
}

describe("the job pauses on the banner (B3, B4, B5, B6)", () => {
  it("pauses while 'Connecting' shows, resumes when it clears; time and count reported", async () => {
    document.documentElement.appendChild(banner("Connecting"));
    const t = bannerEnv({ onSleep: (n) => { if (n === 3) document.querySelectorAll(".information-banner").forEach((b) => b.remove()); } });
    const out = await job.runJob(JOB, t.env);
    expect(t.shown).toContain(job.CONNECTING_TEXT);
    expect(job.overlayState(job.CONNECTING_TEXT, false, { cancel: true })).toBe("paused");
    expect(out.outcome).not.toBe("connection_lost");
    const finish = t.calls.find(([, p]) => p.endsWith("/finish"));
    expect(finish).toBeDefined();
    expect(finish![2]!.connection).toMatchObject({ connecting: { count: 1, ms: 3000 }, phone_unreachable: { count: 0, ms: 0 } });
  });

  it("'Trying to reach your phone' past the limit ends the job as phone_unreachable, named", async () => {
    document.documentElement.appendChild(banner("Trying to reach your phone", "Check that your phone is on"));
    const t = bannerEnv({ onSleep: (n) => { if (n > 50) throw new Error("waited past the limit"); }, connectionLostMs: 5000 });
    const out = await job.runJob(JOB, t.env);
    expect(out.outcome).toBe("phone_unreachable");
    expect(t.shown).toContain(job.UNREACHABLE_TEXT);
    const err = t.calls.find(([, p]) => p.endsWith("/error"));
    expect(err![2]).toMatchObject({ code: "phone_unreachable", message: job.CONNECTION_LOST_TEXT.phone_unreachable });
    expect(t.calls.some(([, p]) => p.endsWith("/finish"))).toBe(false);
    expect(t.calls.some(([, p]) => p.endsWith("/chat"))).toBe(false);
  });

  it("'Connecting' past the limit is connection_lost", async () => {
    document.documentElement.appendChild(banner("Connecting"));
    const out = await job.runJob(JOB, bannerEnv({ onSleep: (n) => { if (n > 50) throw new Error("waited past the limit"); }, connectionLostMs: 2000 }).env);
    expect(out.outcome).toBe("connection_lost");
  });

  it("a banner that came up while a chat loaded: the chat's history is loaded again once it clears", async () => {
    const t = bannerEnv({
      onLoad: (n) => { if (n === 1) document.documentElement.appendChild(banner("Connecting")); },
      onSleep: () => document.querySelectorAll(".information-banner").forEach((b) => b.remove()),
    });
    await job.runJob(JOB, t.env);
    expect(t.loads()).toBe(2);
    expect(t.calls.some(([, p]) => p.endsWith("/chat"))).toBe(true);
  });

  it("the limit is 5 minutes", () => {
    expect(job.RCS_CONNECTION_LOST_MS).toBe(5 * 60000);
  });
});

/**
 * Live (2026-10-04): network off — Google showed "No internet connection /
 * Make sure your device is connected to the internet." and the run went on
 * and finished "Sync done" (a false complete). Now that is connection lost:
 * the same pause and grace, then the code pc_offline ("This computer is
 * offline."); and a run never finishes while a banner is unresolved.
 * Mutations: the offline title not matched; navigator.onLine ignored; the
 * fallback element not matched; no end-of-run check → red.
 */
describe("the computer is offline (pc_offline)", () => {
  const OFFLINE_CONTENT = "Make sure your device is connected to the internet.";

  it("kinds: the offline banner title, a status/alert element saying so, or navigator.onLine false", () => {
    document.body.appendChild(banner("No internet connection", OFFLINE_CONTENT));
    expect(scan.connectionBanner(document)).toMatchObject({ kind: "pc_offline" });
    document.body.innerHTML = "";
    document.querySelectorAll(".information-banner").forEach((b) => b.remove());
    document.body.innerHTML = `<div role="alert"><span>No internet connection</span><span>${OFFLINE_CONTENT}</span></div>`;
    expect(scan.connectionBanner(document)).toMatchObject({ kind: "pc_offline" });
    document.body.innerHTML = "";
    expect(scan.connectionBanner(document)).toBeNull();
    const online = jest.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      expect(scan.connectionBanner(document)).toEqual({ kind: "pc_offline", titleLength: 0 });
    } finally {
      online.mockRestore();
    }
  });

  it("offline past the limit: the job ends pc_offline — no chat saved, never 'done'", async () => {
    document.documentElement.appendChild(banner("No internet connection", OFFLINE_CONTENT));
    const t = bannerEnv({ onSleep: (n) => { if (n > 50) throw new Error("waited past the limit"); }, connectionLostMs: 3000 });
    const out = await job.runJob(JOB, t.env);
    expect(out.outcome).toBe("pc_offline");
    expect(t.shown).toContain(job.OFFLINE_TEXT);
    expect(job.overlayState(job.OFFLINE_TEXT, false, { cancel: true })).toBe("paused");
    const err = t.calls.find(([, p]) => p.endsWith("/error"));
    expect(err![2]).toMatchObject({ code: "pc_offline", message: job.CONNECTION_LOST_TEXT.pc_offline });
    expect(t.calls.some(([, p]) => p.endsWith("/finish"))).toBe(false);
    expect(job.failureLine("pc_offline")).toBe("This computer is offline.");
  });

  it("offline only once the chats were read: still never 'done' (waits, then pc_offline)", async () => {
    const t = bannerEnv({
      onLoad: () => undefined,
      onSleep: (n) => { if (n > 50) throw new Error("waited past the limit"); },
      connectionLostMs: 2000,
    });
    // The banner appears as the last chat's messages are sent.
    const api = t.env.api;
    t.env.api = async (m: string, p: string, b?: Record<string, unknown>) => {
      const r = await api(m, p, b);
      if (p.endsWith("/chat")) document.body.appendChild(banner("No internet connection", OFFLINE_CONTENT));
      return r;
    };
    const out = await job.runJob(JOB, t.env);
    expect(out.outcome).toBe("pc_offline");
    expect(t.calls.some(([, p]) => p.endsWith("/finish"))).toBe(false);
  });
});

/**
 * SR on 77efbfe8d: (1) the offline fallback is banner-scoped — a message or
 * a conversation saying "No internet connection…" is no banner, and a long
 * text is none; (2) a FLAPPING banner (gone at each poll, back at once)
 * still ends the run once the held time passes 2× the limit. Mutations: the
 * scope or the length check dropped; no total limit (the test times out) → red.
 */
describe("pc_offline: banner-scoped; a flapping banner still ends", () => {
  it("a message bubble or a conversation saying it: no trigger; a long alert: none", () => {
    document.body.innerHTML =
      `<mws-messages-list><mws-message-wrapper><div role="status">No internet connection at the cabin, call me</div></mws-message-wrapper></mws-messages-list>` +
      `<mws-conversations-list><mws-conversation-list-item><span role="status">No internet connection</span></mws-conversation-list-item></mws-conversations-list>`;
    expect(scan.connectionBanner(document)).toBeNull();
    document.body.innerHTML = `<div role="alert">No internet connection ${"x".repeat(90)}</div>`;
    expect(scan.connectionBanner(document)).toBeNull();
    document.body.innerHTML = `<div role="alert">No internet connection Make sure your device is connected to the internet.</div>`;
    expect(scan.connectionBanner(document)).toMatchObject({ kind: "pc_offline" });
  });

  it("a banner that is gone at every poll but back at once: pc_offline after 2× the limit", async () => {
    const t = bannerEnv({ onSleep: (n) => { if (n > 200) throw new Error("waited forever"); }, connectionLostMs: 3000 });
    let calls = 0;
    // Back on every other look: present at the loop's re-check, gone after each poll.
    (t.env.scan as Record<string, unknown>).connectionBanner = () => (++calls % 2 === 1 ? { kind: "pc_offline", titleLength: 22 } : null);
    const out = await job.runJob(JOB, t.env);
    expect(out.outcome).toBe("pc_offline");
    expect(t.calls.some(([, p]) => p.endsWith("/finish"))).toBe(false);
  });
});
