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
    expect(read("welcome.html")).toContain('<script src="welcome.js"></script>');
  });

  it("is informational: the agreement is given in Keepr (F3)", () => {
    expect(read("options.html")).toMatch(/You agree to this in Keepr itself/);
    for (const f of ["options.js", "welcome.js"]) expect(read(f)).not.toMatch(/fetch\(|127\.0\.0\.1|consent/i);
  });

  it("no code field on the options page; the welcome page links through the worker (F4)", () => {
    const html = read("options.html");
    expect(html).not.toMatch(/<input|keepr-pair|Got it/);
    expect(read("options.js")).not.toMatch(/sendMessage/);
    const types = Array.from(read("welcome.js").matchAll(/type: "([a-z-]+)"/g)).map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(["keepr-link-start", "keepr-open-app", "keepr-popup-state"]));
  });

  it("step 2 links like the popup: Link → the code → linked (F5)", () => {
    const box = document.createElement("div");
    const calls: string[] = [];
    const io = { link: () => calls.push("link"), openApp: () => calls.push("openApp") };
    welcome.renderLinkStep(document, box, { state: "not_linked" }, io);
    expect(box.textContent).toContain(welcome.COPY.notLinked);
    (box.querySelector('[data-keepr="link"]') as HTMLButtonElement).click();
    welcome.renderLinkStep(document, box, { state: "linking", link: { code: "042137" } }, io);
    expect(box.querySelector(".code")!.textContent).toBe("042 137");
    expect(box.textContent).toContain(welcome.COPY.linking);
    (box.querySelector('[data-keepr="open-app"]') as HTMLButtonElement).click();
    welcome.renderLinkStep(document, box, { state: "linked" }, io);
    expect(box.textContent).toContain(welcome.COPY.linked);
    expect(box.querySelector("button")).toBeNull();
    welcome.renderLinkStep(document, box, { state: "keepr_down" }, io);
    expect(box.textContent).toContain(welcome.COPY.keeprDown);
    expect(calls).toEqual(["link", "openApp"]);
  });
});
