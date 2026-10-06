/**
 * C2 (UX redesign, founder 2026-10-03) — the toolbar popup is the extension's
 * home: one short line + a button per state.
 *
 * Mutations (each turns a test red):
 *   P1 a state drawn with the wrong line / button        → "each state"
 *   P2 Unlink without its confirm                       → "Unlink asks first"
 *   P3 the popup not asking the worker when it opens    → "asks the worker on open"
 *   P4 linking not asked again while it waits           → "linking: asked again"
 *   P5 the manifest without the popup                   → "the toolbar button opens it"
 *   P6 linking re-drawn every second (the selection lost) → "the code keeps its selection"
 *   P7 the copy button not copying, or copying "123 456"  → "Copy code and open Keepr"
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const popup = require("../../chrome-extension/popup.js") as Record<string, any>;

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const q = (box: HTMLElement, key: string) => box.querySelector(`[data-keepr="${key}"]`) as HTMLButtonElement | null;

function draw(view: Record<string, unknown>, io: Record<string, unknown> = {}) {
  const box = document.createElement("main");
  document.body.appendChild(box);
  const calls: string[] = [];
  const base = {
    now: () => NOW,
    link: () => calls.push("link"),
    cancel: () => calls.push("cancel"),
    openApp: () => calls.push("openApp"),
    copyCode: (t: string) => calls.push("copy " + t),
    openKeepr: () => calls.push("openKeepr"),
    openMessages: () => calls.push("openMessages"),
    unlink: () => calls.push("unlink"),
    setConfirm: (on: boolean) => calls.push("confirm " + on),
    confirmUnlink: false,
    ...io,
  };
  popup.renderPopup(document, box, view, base);
  return { box, calls };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the popup (C2)", () => {
  it("each state: one line and its button (P1)", () => {
    const down = draw({ state: "keepr_down", version: "0.3.32" });
    expect(down.box.textContent).toContain(popup.COPY.keepr_down);
    q(down.box, "open-app")!.click();
    expect(down.calls).toEqual(["openApp"]);

    const old = draw({ state: "out_of_date", version: "0.3.31", minVersion: "0.3.32" });
    expect(old.box.textContent).toContain(popup.COPY.out_of_date);
    expect(old.box.textContent).toContain("Keepr needs 0.3.32");

    const none = draw({ state: "not_linked", version: "0.3.32", link: { status: "none" } });
    expect(none.box.textContent).toContain(popup.COPY.not_linked);
    q(none.box, "link")!.click();
    expect(none.calls).toEqual(["link"]);

    const failed = draw({ state: "not_linked", link: { status: "failed", error: "That code expired. Click Link for a new one." } });
    expect(failed.box.textContent).toContain("That code expired.");

    const linking = draw({ state: "linking", link: { status: "waiting", code: "042137", expiresAt: NOW + 95_000 } });
    // Spaced by CSS (two halves): a selection copies the 6 digits.
    expect(linking.box.querySelector(".code")!.textContent).toBe("042137");
    expect(linking.box.querySelectorAll(".code span")).toHaveLength(2);
    expect(q(linking.box, "open-app")).toBeNull();
    expect(q(linking.box, "copy-open")!.textContent).toBe("Copy code and open Keepr");
    expect(linking.box.textContent).toContain(popup.COPY.linking);
    expect(linking.box.textContent).toContain("1:35");
    q(linking.box, "copy-open")!.click();
    q(linking.box, "cancel")!.click();
    expect(linking.calls).toEqual(["copy 042137", "openApp", "cancel"]);

    const linked = draw({ state: "linked", email: "a***@example.test", lastSyncAt: NOW - 5 * 60_000 });
    expect(linked.box.textContent).toContain(popup.COPY.linked);
    expect(linked.box.textContent).toContain("a***@example.test");
    expect(linked.box.textContent).toContain("Last sync 5 min ago");
    q(linked.box, "open-messages")!.click();
    q(linked.box, "open-keepr")!.click();
    expect(linked.calls).toEqual(["openMessages", "openKeepr"]);
  });

  it("Unlink asks first: 'Unlink from Keepr? You'll need to link again to sync' (P2)", () => {
    const linked = draw({ state: "linked", email: null, lastSyncAt: null });
    q(linked.box, "unlink")!.click();
    expect(linked.calls).toEqual(["confirm true"]);
    const asking = draw({ state: "linked" }, { confirmUnlink: true });
    expect(asking.box.textContent).toContain("Unlink from Keepr? You'll need to link again to sync");
    expect(q(asking.box, "open-messages")).toBeNull();
    q(asking.box, "unlink-no")!.click();
    q(asking.box, "unlink-yes")!.click();
    expect(asking.calls).toEqual(["confirm false", "unlink"]);
  });

  it("asks the worker on open; linking: asked again every second (P3, P4)", async () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<main id="keepr-popup"></main>';
    const asked: string[] = [];
    let state = "linking";
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
          asked.push(m.type);
          cb(m.type === "keepr-popup-state" ? { state, link: { status: "waiting", code: "123456", expiresAt: Date.now() + 60_000 } } : { ok: true });
        },
      },
    };
    await popup.start(document, chromeStub);
    expect(asked).toEqual(["keepr-popup-state"]);
    expect(document.querySelector(".code")!.textContent).toBe("123456");
    state = "linked";
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(asked).toEqual(["keepr-popup-state", "keepr-popup-state"]);
    jest.useRealTimers();
  });

  it("the toolbar button opens it (P5)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "manifest.json"), "utf8"));
    const icons = { "16": "icons/keepr-16.png", "32": "icons/keepr-32.png", "48": "icons/keepr-48.png", "128": "icons/keepr-128.png" };
    expect(manifest.action).toEqual({ default_title: "Keepr", default_popup: "popup.html", default_icon: icons });
    expect(manifest.icons).toEqual(icons);
    for (const p of Object.values(icons)) expect(fs.existsSync(path.join(__dirname, "..", "..", "chrome-extension", p))).toBe(true);
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "popup.html"), "utf8");
    expect(html).toContain('<script src="popup.js"></script>');
  });
});

// C2: the worker's "Go to Google Messages" and "Open Keepr" (keepr://link).
// Mutations: a second Messages tab opened when one exists → red; Open Keepr
// not via keepr://link → red.
// Live (founder 2026-10-03): the popup's Open Keepr. Linked + Keepr running:
// a signed /focus only, no tab. Keepr not running (or /focus refused):
// keepr://open from the popup itself — never a new tab. Linking: keepr://link.
// Mutations: a tab opened → red; no launch when /focus fails → red; a
// launch although /focus worked → red.
describe("the popup's Open Keepr (live)", () => {
  async function popupWith(state: Record<string, unknown>, focusOk: boolean) {
    document.body.innerHTML = '<main id="keepr-popup"></main>';
    const sent: string[] = [];
    const launched: string[] = [];
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      launched.push(this.getAttribute("href") || "");
    });
    const create = jest.fn();
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
          sent.push(m.type);
          cb(m.type === "keepr-popup-state" ? state : m.type === "keepr-focus" ? { ok: focusOk, launch: !focusOk } : { ok: true });
        },
      },
      tabs: { create },
    };
    await popup.start(document, chromeStub);
    return { sent, launched, click, create };
  }
  afterEach(() => jest.restoreAllMocks());

  it("linked, Keepr running: a signed /focus only", async () => {
    const p = await popupWith({ state: "linked" }, true);
    (document.querySelector('[data-keepr="open-keepr"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.sent).toContain("keepr-focus");
    expect(p.launched).toEqual([]);
    expect(p.create).not.toHaveBeenCalled();
  });

  it("linked, /focus refused or Keepr away: keepr://open from the popup", async () => {
    const p = await popupWith({ state: "linked" }, false);
    (document.querySelector('[data-keepr="open-keepr"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.launched).toEqual(["keepr://open"]);
    expect(p.create).not.toHaveBeenCalled();
  });

  it("linked, /focus refused but Keepr there: no launch (SR: only when unreachable)", async () => {
    document.body.innerHTML = '<main id="keepr-popup"></main>';
    const launched: string[] = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      launched.push(this.getAttribute("href") || "");
    });
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) =>
          cb(m.type === "keepr-popup-state" ? { state: "linked" } : m.type === "keepr-focus" ? { ok: false, launch: false } : { ok: true }),
      },
      tabs: { create: jest.fn() },
    };
    await popup.start(document, chromeStub);
    (document.querySelector('[data-keepr="open-keepr"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(launched).toEqual([]);
  });

  it("Keepr not running: keepr://open; linking: keepr://link — no worker tab", async () => {
    const down = await popupWith({ state: "keepr_down" }, false);
    (document.querySelector('[data-keepr="open-app"]') as HTMLButtonElement).click();
    expect(down.launched).toEqual(["keepr://open"]);
    expect(down.sent).not.toContain("keepr-open-app");
    jest.restoreAllMocks();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (written.push(t), Promise.resolve()) } });
    const linking = await popupWith({ state: "linking", link: { status: "waiting", code: "123456", expiresAt: Date.now() + 60_000 } }, false);
    (document.querySelector('[data-keepr="copy-open"]') as HTMLButtonElement).click();
    // P7: the 6 digits (Keepr's field submits a pasted code by itself), then Keepr.
    expect(written).toEqual(["123456"]);
    expect(linking.launched).toEqual(["keepr://link"]);
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  // Live (founder, 0.3.80): the code could be highlighted but Ctrl+C copied
  // nothing — the popup re-drew everything every second while linking, so
  // the selection was gone. Mutation P6: a full re-draw each second → red.
  it("linking: the code keeps its selection across the every-second refresh; a new code re-draws (P6)", async () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<main id="keepr-popup"></main>';
    let code = "123456";
    const expiresAt = Date.now() + 60_000;
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) =>
          cb(m.type === "keepr-popup-state" ? { state: "linking", link: { status: "waiting", code, expiresAt } } : { ok: true }),
      },
    };
    await popup.start(document, chromeStub);
    const first = document.querySelector(".code")!;
    const sel = window.getSelection()!;
    sel.selectAllChildren(first);
    expect(sel.toString()).toBe("123456");
    const before = document.querySelector('[data-keepr="expires"]')!.textContent;
    jest.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".code")).toBe(first);
    expect(first.isConnected).toBe(true);
    expect(sel.toString()).toBe("123456");
    expect(document.querySelector('[data-keepr="expires"]')!.textContent).not.toBe(before);
    code = "654321";
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".code")!.textContent).toBe("654321");
    expect(first.isConnected).toBe(false);
    jest.useRealTimers();
  });

  it("launchKeepr: only keepr://open and keepr://link", () => {
    const launched: string[] = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      launched.push(this.getAttribute("href") || "");
    });
    expect(popup.launchKeepr(document, "keepr://callback?access_token=x")).toBe(false);
    expect(popup.launchKeepr(document, "https://example.test")).toBe(false);
    expect(popup.launchKeepr(document, "keepr://open")).toBe(true);
    expect(launched).toEqual(["keepr://open"]);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("the popup's buttons, in the worker (C2)", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
  type Listener = (m: Record<string, unknown>, s: { id: string }, r: (x: unknown) => void) => boolean;
  function worker(existing: Array<{ id: number; windowId: number }>) {
    let listener: Listener | null = null;
    const calls: unknown[][] = [];
    const chromeStub = {
      runtime: { id: "ext", onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version: "0.3.32" }) },
      tabs: {
        query: async () => existing,
        update: async (...a: unknown[]) => void calls.push(["update", ...a]),
        create: async (o: { url: string }) => {
          calls.push(["create", o.url]);
          return { id: 99 };
        },
        remove: async () => undefined,
      },
      windows: { update: async (...a: unknown[]) => void calls.push(["window", ...a]) },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", SOURCE)(chromeStub, async () => { throw new Error("offline"); });
    const send = (m: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        listener!(m, { id: "ext" }, resolve);
      });
    return { send, calls };
  }

  it("Go to Google Messages: the open tab, else a new one", async () => {
    const one = worker([{ id: 7, windowId: 3 }]);
    await one.send({ type: "keepr-open-messages" });
    expect(one.calls).toEqual([["update", 7, { active: true }], ["window", 3, { focused: true }]]);
    const none = worker([]);
    await none.send({ type: "keepr-open-messages" });
    expect(none.calls).toEqual([["create", "https://messages.google.com/web/conversations"]]);
  });

  // Live (founder): the worker never opens a tab for Keepr any more.
  it("no keepr:// tab from the worker", async () => {
    const w = worker([]);
    void w.send({ type: "keepr-open-app" }); // no such message any more: never answered
    await new Promise((r) => setTimeout(r, 0));
    expect(w.calls).toEqual([]);
    expect(SOURCE).not.toMatch(/tabs[.](create|update)[(][^)]*keepr:/);
  });
});
