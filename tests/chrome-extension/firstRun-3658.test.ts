/**
 * BACKLOG-3658 P3b; UX redesign C4 (founder 2026-10-03) — the extension's
 * first-run page is welcome.html (Pin · Link · Sync from Keepr), opened on
 * install only. The options page is information only: no code field
 * anywhere (linking lives in the toolbar popup and step 2 here).
 *
 * Mutations that turn this suite red:
 *   F1 the welcome page not opened on first install (or on every update) → "opens on install only"
 *   F3 a page claims to record consent                                  → "informational"
 *   F4 a code field (old pairing) on the options page                   → "no code field"
 *   F5 step 2 not linking like the popup                                → "step 2 links"
 */
export {};

import * as fs from "fs";
import * as path from "path";

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f: string) => fs.readFileSync(path.join(EXT, f), "utf8");
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const welcome = require("../../chrome-extension/welcome.js") as Record<string, any>;

describe("first-run (C4)", () => {
  it("opens the welcome page on install only (F1)", () => {
    let installed: ((d: { reason: string }) => void) | null = null;
    const created: string[] = [];
    const chromeStub = {
      runtime: {
        id: "x",
        onMessage: { addListener: () => undefined },
        onInstalled: { addListener: (fn: (d: { reason: string }) => void) => (installed = fn) },
        getURL: (p: string) => "chrome-extension://x/" + p,
        getManifest: () => ({ version: "9.9.9" }),
      },
      tabs: { query: jest.fn(async () => []), create: (o: { url: string }) => void created.push(o.url) },
    };
    const fetchStub = jest.fn(async () => ({ status: 404, json: async () => ({}) }));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", read("background.js"))(chromeStub, fetchStub);
    expect(installed).not.toBeNull();
    installed!({ reason: "update" });
    expect(created).toEqual([]);
    installed!({ reason: "install" });
    expect(created).toEqual(["chrome-extension://x/welcome.html"]);
    // The shared code area loads first (one copy for the popup and this page).
    expect(read("welcome.html")).toMatch(/<script src="linkcode\.js"><\/script>\r?\n<script src="welcome\.js"><\/script>/);
  });

  // Founder (2026-10-06): an update (incl. ↻ on an unpacked copy) reloads the
  // open Messages tabs so the new content script runs; install and Chrome's
  // own updates do not. Mutations: no reload on update; a reload on install /
  // chrome_update; other sites' tabs reloaded → red.
  it("an update reloads the open Messages tabs (only those); nothing else does", async () => {
    let installed: ((d: { reason: string }) => void) | null = null;
    const queried: unknown[] = [];
    const reloaded: number[] = [];
    const chromeStub = {
      runtime: {
        id: "x",
        onMessage: { addListener: () => undefined },
        onInstalled: { addListener: (fn: (d: { reason: string }) => void) => (installed = fn) },
        getURL: (p: string) => "chrome-extension://x/" + p,
        getManifest: () => ({ version: "9.9.9" }),
      },
      tabs: {
        query: jest.fn(async (q: { url?: string }) => {
          queried.push(q);
          return q.url === "https://messages.google.com/web/*" ? [{ id: 7 }, { id: 9 }] : [];
        }),
        reload: jest.fn(async (id: number) => void reloaded.push(id)),
        create: () => undefined,
      },
    };
    const fetchStub = jest.fn(async () => ({ status: 404, json: async () => ({}) }));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", read("background.js"))(chromeStub, fetchStub);
    queried.length = 0;
    for (const reason of ["install", "chrome_update", "shared_module_update"]) installed!({ reason });
    await new Promise((r) => setTimeout(r, 0));
    expect(reloaded).toEqual([]);
    installed!({ reason: "update" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(queried).toEqual([{ url: "https://messages.google.com/web/*" }]);
    expect(reloaded).toEqual([7, 9]);
    // No new permission: still "storage" only, the same host access.
    const manifest = JSON.parse(read("manifest.json"));
    expect(manifest.permissions).toEqual(["storage"]);
  });

  it("is informational: the agreement is given in Keepr (F3)", () => {
    // SR C7: the agreement is asked in Keepr before the first sync.
    expect(read("options.html")).toMatch(/Before your first sync, Keepr asks you to agree/);
    for (const f of ["options.js", "welcome.js"]) expect(read(f)).not.toMatch(/fetch\(|127\.0\.0\.1|consent/i);
  });

  it("no code field on the options page; the welcome page links through the worker (F4)", () => {
    const html = read("options.html");
    expect(html).not.toMatch(/<input|keepr-pair|Got it/);
    expect(read("options.js")).not.toMatch(/sendMessage/);
    const types = Array.from(read("welcome.js").matchAll(/type: "([a-z-]+)"/g)).map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(["keepr-link-start", "keepr-popup-state"]));
    // Live (founder): Open Keepr from this page itself (keepr://), never a worker tab.
    expect(read("welcome.js")).toContain('launchKeepr(doc, lastState === "linking" ? "keepr://link" : "keepr://open")');
  });

  it("step 2 links like the popup: Link → the code → linked (F5)", () => {
    const box = document.createElement("div");
    const calls: string[] = [];
    const io = { now: () => 0, link: () => calls.push("link"), openApp: () => calls.push("openApp"), copyCode: (t: string) => calls.push("copy " + t) };
    welcome.renderLinkStep(document, box, { state: "not_linked" }, io);
    // The mockup (Welcome.dc.html): the steps, then [Link with Keepr].
    expect(box.textContent).toBe("Link with Keepr");
    (box.querySelector('[data-keepr="link"]') as HTMLButtonElement).click();
    welcome.renderLinkStep(document, box, { state: "linking", link: { code: "042137", expiresAt: 95_000 } }, io);
    expect(box.querySelector(".code")!.textContent).toBe("042137");
    expect(box.textContent).toContain(welcome.COPY.linking);
    expect(box.querySelector('[data-keepr="open-app"]')).toBeNull();
    (box.querySelector('[data-keepr="copy-open"]') as HTMLButtonElement).click();
    welcome.renderLinkStep(document, box, { state: "linked" }, io);
    expect(box.textContent).toContain(welcome.COPY.linked);
    expect(box.querySelector("button")).toBeNull();
    welcome.renderLinkStep(document, box, { state: "keepr_down" }, io);
    expect(box.textContent).toContain(welcome.COPY.keeprDown);
    expect(calls).toEqual(["link", "copy 042137", "openApp"]);
  });

  // Founder (live): the welcome page's code area is the popup's (linkcode.js):
  // the countdown, "Code expired" + Get a new code (E01), Copy code and open
  // Keepr, and a selection that survives the every-second refresh.
  // Mutations: no countdown / expiry on this page; the copy not written or
  // with a space; the area re-drawn each second → red.
  it("the code area: countdown, expired + Get a new code, the copy button, the selection kept (F6)", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    let now = 0;
    const calls: string[] = [];
    const io = { now: () => now, link: () => calls.push("link"), openApp: () => calls.push("openApp"), copyCode: (t: string) => calls.push("copy " + t) };
    const view = { state: "linking", link: { status: "waiting", code: "123456", expiresAt: 95_000 } };
    welcome.renderLinkStep(document, box, view, io);
    expect(box.querySelector('[data-keepr="expires"]')!.textContent).toBe("Expires in 1:35");
    const code = box.querySelector(".code")!;
    const sel = window.getSelection()!;
    sel.selectAllChildren(code);
    now = 5_000;
    welcome.renderLinkStep(document, box, view, io);
    expect(box.querySelector(".code")).toBe(code);
    expect(sel.toString()).toBe("123456");
    expect(box.querySelector('[data-keepr="expires"]')!.textContent).toBe("Expires in 1:30");
    (box.querySelector('[data-keepr="copy-open"]') as HTMLButtonElement).click();
    expect(calls).toEqual(["copy 123456", "openApp"]);
    now = 95_000;
    welcome.renderLinkStep(document, box, view, io);
    expect(box.querySelector('[data-keepr="expired"]')!.textContent).toBe("Code expired");
    expect(box.textContent).not.toContain("123");
    (box.querySelector('[data-keepr="new-code"]') as HTMLButtonElement).click();
    expect(calls).toEqual(["copy 123456", "openApp", "link"]);
    box.remove();
  });

  it("the copy is a clipboard WRITE of the 6 digits, then keepr://link (F7)", async () => {
    document.body.innerHTML = '<div id="keepr-welcome-link"></div>';
    const written: string[] = [];
    const launched: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (written.push(t), Promise.resolve()) } });
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      launched.push(this.getAttribute("href") || "");
    });
    const chromeStub = {
      runtime: {
        lastError: undefined,
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) =>
          cb(m.type === "keepr-popup-state" ? { state: "linking", link: { status: "waiting", code: "123456", expiresAt: Date.now() + 60_000 } } : { ok: true }),
      },
    };
    await welcome.start(document, chromeStub);
    (document.querySelector('[data-keepr="copy-open"]') as HTMLButtonElement).click();
    expect(written).toEqual(["123456"]);
    expect(launched).toEqual(["keepr://link"]);
    jest.restoreAllMocks();
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    document.body.innerHTML = "";
  });

  it("one copy of the code area: no clipboard reads; the popup and this page use linkcode.js", () => {
    for (const f of ["linkcode.js", "popup.js", "welcome.js"]) expect(read(f)).not.toMatch(/readText|clipboard\.read\b|execCommand/);
    for (const f of ["popup.js", "welcome.js"]) {
      expect(read(f)).toContain('require("./linkcode.js")');
      // The strings live in linkcode.js only (comments aside).
      const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/"Expires in |"Copy code and open Keepr"|"Code expired"/);
    }
  });
});
