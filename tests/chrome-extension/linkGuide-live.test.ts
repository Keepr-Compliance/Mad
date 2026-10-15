/**
 * Founder (BoxNotLinked + LinkFlow mockups; SR-approved 2026-10-04): an
 * unlinked extension shows a guide card on the Messages page — top-right
 * under the toolbar, a yellow ↑, the brand mark, "Link with Keepr", a primary
 * "Link with Keepr" button and the hint line; × hides it for this page load.
 * The button (trusted clicks only) asks the worker for the extension's OWN
 * small window (link.html), where the link — and its code — starts. The code
 * never reaches the page.
 *
 * Mutations (each turns a test red):
 *   N1 the guide not shown when unlinked, or shown when linked        → "the guide card"
 *   N2 an untrusted (scripted) click opening the window              → "trusted clicks only"
 *   N3 two link windows / no rate limit                              → "one window at a time"
 *   N4 the code-bearing messages answered for a web page             → "the code stays off the page"
 *   N5 link.html not starting the link itself                        → "link.html starts the link"
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const popup = require("../../chrome-extension/popup.js") as Record<string, any>;
const EXT = path.join(__dirname, "..", "..", "chrome-extension");

afterEach(() => {
  document.body.innerHTML = "";
});

const render = (extras: Record<string, unknown>, io: Record<string, unknown> = {}) => {
  const box = document.createElement("div");
  document.body.appendChild(box);
  job.renderOverlay(box, "", false, extras, { copy: async () => true, theme: "light", ...io });
  return box;
};
const q = (box: HTMLElement, key: string) => box.querySelector(`[data-keepr="${key}"]`) as HTMLElement;

describe("the not-linked guide card on the page", () => {
  // SR (D02 storyboard): "Link this browser", the full-width "Link with
  // Keepr" button — no hint line, no ↑. × and the brand mark stay (founder
  // sign-off pending). Mutations: the hint line or ↑ back; the old heading;
  // the button not full width / 44 high → red.
  it("the guide card (D02): brand mark, 'Link this browser', the Link with Keepr button, ×", () => {
    const close = jest.fn();
    const box = render({ idle: { linked: false, guide: true } }, { close });
    expect(box.getAttribute("data-keepr-state")).toBe("not_linked");
    expect(box.style).toMatchObject({ width: "320px", padding: "16px", borderRadius: "16px", gap: "12px" });
    expect(box.style.boxShadow).toBe("0 8px 24px rgba(31,36,51,0.18)");
    expect(q(box, "drag-handle").querySelector('[data-keepr="brand-mark"]')).not.toBeNull();
    expect(q(box, "line").textContent).toBe("Link this browser");
    const link = q(box, "link-open");
    expect(link.textContent).toBe("Link with Keepr");
    expect(link.style).toMatchObject({ width: "100%", minHeight: "44px", fontSize: "14px", borderRadius: "10px" });
    expect(Array.from(box.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["header", "link-open"]);
    expect(q(box, "progress")).toBeNull();
    expect(q(box, "guide-arrow")).toBeNull();
    expect(box.textContent).not.toContain("Click the Keepr icon");
    // Founder (live 0.3.57): never pinned — its brand mark is the drag handle.
    expect(box.querySelectorAll('[data-keepr="drag-handle"]')).toHaveLength(1);
    q(box, "close").click();
    expect(close).toHaveBeenCalledTimes(1);
    // Linked (or dismissed): the normal K tab.
    expect(render({ idle: { linked: true } }).getAttribute("data-keepr-state")).toBe("idle");
    expect(job.guidePosition(320, 1280)).toEqual({ left: 480, top: 16 });
  });

  it("trusted clicks only open the link window", () => {
    const openLink = jest.fn();
    const box = render({ idle: { linked: false, guide: true } }, { openLink });
    q(box, "link-open").click(); // a scripted click: isTrusted false
    q(box, "link-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openLink).not.toHaveBeenCalled();
    // jsdom cannot make a trusted event: catch the button's click handler and
    // call it as the browser would for a real click.
    const handlers: Array<(e: unknown) => void> = [];
    const spy = jest.spyOn(HTMLElement.prototype, "addEventListener").mockImplementation(function (this: HTMLElement, type: string, fn: unknown) {
      if (type === "click" && this.getAttribute("data-keepr") === "link-open") handlers.push(fn as (e: unknown) => void);
    });
    render({ idle: { linked: false, guide: true } }, { openLink });
    spy.mockRestore();
    expect(handlers).toHaveLength(1);
    handlers[0]({ isTrusted: false });
    expect(openLink).not.toHaveBeenCalled();
    handlers[0]({ isTrusted: true });
    expect(openLink).toHaveBeenCalledTimes(1);
  });

  it("the page shows the guide while unlinked, until ×, and asks the worker for the window", () => {
    const src = fs.readFileSync(path.join(EXT, "job.js"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain("guide: idleLinked === false && !guideDismissed");
    // The page sends only the screen's numbers with it (D03/A06 placement).
    expect(src).toContain('type: "keepr-open-link-window",');
    expect(src).toContain("screen: { left: sc.availLeft, top: sc.availTop, width: sc.availWidth, height: sc.availHeight },");
  });

  it("no 6-digit code text in anything the page box renders, in any state", () => {
    const states: Array<[string, boolean, Record<string, unknown> | undefined]> = [
      ["", false, { idle: { linked: false, guide: true } }],
      ["", false, { idle: { linked: true } }],
      ["Chat 3 of 9…", false, { cancel: true }],
      [job.DONE_LINE, false, { details: "Scanned 3 chats", summary: "Scanned 3 chats", copy: "c" }],
      ["Keepr closed or restarted.", true, { retry: true }],
    ];
    for (const [text, err, extras] of states) {
      const box = render(extras as Record<string, unknown>, { expanded: true });
      void text;
      job.renderOverlay(box, text, err, extras, { copy: async () => true, theme: "light", expanded: true });
      expect([text, /\b\d{3} ?\d{3}\b/.test(box.textContent || "")]).toEqual([text, false]);
    }
    // No content script asks for the link (code-bearing) messages.
    for (const f of ["job.js", "content.js", "eyes.js", "scan.js", "extract.js"]) {
      const src = fs.readFileSync(path.join(EXT, f), "utf8");
      for (const t of ["keepr-link-start", "keepr-link-state", "keepr-popup-state"]) expect([f, t, src.includes(t)]).toEqual([f, t, false]);
    }
  });
});

describe("the worker's link window", () => {
  const SOURCE = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  type Listener = (m: Record<string, unknown>, s: Record<string, unknown>, r: (x: unknown) => void) => boolean;
  function worker(opts: { openPopup?: () => Promise<void> } = {}) {
    let listener: Listener | null = null;
    let removed: ((id: number) => void) | null = null;
    const created: unknown[] = [];
    const updated: unknown[] = [];
    let nextId = 50;
    const chromeStub = {
      runtime: {
        id: "ext",
        onMessage: { addListener: (fn: Listener) => (listener = fn) },
        getManifest: () => ({ version: "0.3.44" }),
        getURL: (p: string) => "chrome-extension://ext/" + p,
      },
      action: opts.openPopup ? { openPopup: opts.openPopup } : undefined,
      windows: {
        create: async (o: unknown) => {
          created.push(o);
          return { id: nextId++ };
        },
        update: async (id: number, o: unknown) => {
          if (id === -1) throw new Error("gone");
          updated.push([id, o]);
        },
        onRemoved: { addListener: (fn: (id: number) => void) => (removed = fn) },
      },
      tabs: { query: async () => [] },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", SOURCE)(chromeStub, async () => {
      throw new Error("offline");
    });
    const send = (m: Record<string, unknown>, sender: Record<string, unknown> = { id: "ext", url: "https://messages.google.com/web/conversations", tab: { id: 3 } }) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const async = listener!(m, sender, (r) => resolve(r as Record<string, unknown>));
        if (!async) resolve({ sync: true });
      });
    return { send, created, updated, closed: (id: number) => removed?.(id) };
  }

  // Founder Option 1: Keepr comes forward as soon as the code shows, and an
  // action popup closes when it loses focus — so ALWAYS the link window's small
  // window (it starts the link itself: no second click). Mutation: the
  // toolbar popup tried first → red.
  it("always the link window (popup.html?autolink=1) — never the toolbar popup", async () => {
    const openPopup = jest.fn(async () => undefined);
    const w = worker({ openPopup });
    expect(await w.send({ type: "keepr-open-link-window" })).toEqual({ ok: true, how: "window" });
    expect(openPopup).not.toHaveBeenCalled();
    expect(w.created).toEqual([{ url: "chrome-extension://ext/popup.html?autolink=1", type: "popup", width: 380, height: 380, focused: true }]);
  });

  it("one window at a time, and a rate limit", async () => {
    const w = worker();
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      expect(await w.send({ type: "keepr-open-link-window" })).toEqual({ ok: true, how: "window" });
      expect(await w.send({ type: "keepr-open-link-window" })).toEqual({ ok: false, error: "too_soon" });
      clock += 2_000;
      expect(await w.send({ type: "keepr-open-link-window" })).toEqual({ ok: true, how: "focused" });
      expect(w.created).toHaveLength(1);
      expect(w.updated).toEqual([[50, { focused: true }]]);
      w.closed(50);
      clock += 2_000;
      expect(await w.send({ type: "keepr-open-link-window" })).toEqual({ ok: true, how: "window" });
      expect(w.created).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("the code stays off the page: link messages refused for a web page's script", async () => {
    const w = worker();
    for (const type of ["keepr-popup-state", "keepr-link-start", "keepr-link-state", "keepr-link-cancel", "keepr-unlink"]) {
      expect(await w.send({ type })).toEqual({ ok: false, error: "not_allowed" });
    }
    // SR allow-list: only this extension AND a URL under its own origin.
    // Mutations: the sender id not checked; the URL not checked → red.
    const refused = [
      { id: "ext", url: "http://messages.google.com/web" },
      { id: "ext", url: "https://example.test/chrome-extension://ext/popup.html?autolink=1" },
      { id: "other-extension", url: "chrome-extension://ext/popup.html?autolink=1" },
      { id: "other-extension", url: "chrome-extension://other-extension/popup.html?autolink=1" },
      { id: "ext" }, // no URL
      { id: "ext", tab: { id: 9 } }, // a tab is no proof
    ];
    for (const sender of refused) {
      // Refused: "not_allowed", or (another extension) never answered at all.
      const r = await w.send({ type: "keepr-link-start" }, sender);
      expect([sender, r.ok === true || "link" in r]).toEqual([sender, false]);
      expect([sender, r.error === "not_allowed" || r.sync === true]).toEqual([sender, true]);
    }
    // The extension's own page (popup / link window — which has a tab) is answered.
    const own = await w.send({ type: "keepr-link-state" }, { id: "ext", url: "chrome-extension://ext/popup.html?autolink=1", tab: { id: 12 } });
    expect(own).toMatchObject({ ok: true });
  });
});

// SR clean-up: no link.html copy — the link window is popup.html?autolink=1.
// Mutations: the query not read; link.html back → red.
describe("the link window (popup.html?autolink=1) starts the link", () => {
  it("no link.html; the query starts the link itself once, when not linked", async () => {
    expect(fs.existsSync(path.join(EXT, "link.html"))).toBe(false);
    window.history.replaceState(null, "", "/popup.html?autolink=1");
    document.body.innerHTML = '<main id="keepr-popup"></main>';
    const asked: string[] = [];
    let state = "not_linked";
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
          asked.push(m.type);
          if (m.type === "keepr-link-start") state = "linking";
          cb(m.type === "keepr-popup-state" ? { state, link: { status: "waiting", code: "482913", expiresAt: Date.now() + 112_000 } } : { ok: true });
        },
      },
    };
    jest.useFakeTimers();
    try {
      await popup.start(document, chromeStub);
      await Promise.resolve();
      expect(asked.slice(0, 3)).toEqual(["keepr-popup-state", "keepr-link-start", "keepr-popup-state"]);
      expect(asked.filter((t) => t === "keepr-link-start")).toHaveLength(1);
      expect(document.querySelector('[data-keepr="code"]')!.textContent).toBe("482913"); // the gap is CSS: a selection copies the 6 digits
      expect(document.title).toBe("Link with Keepr");
    } finally {
      jest.useRealTimers();
      window.history.replaceState(null, "", "/");
    }
  });
});
