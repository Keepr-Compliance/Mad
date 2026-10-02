/**
 * BACKLOG-3658 P3b — the extension's first-run page: informational, with a
 * LOCAL acknowledgement only (Keepr's consent record is the only gate).
 *
 * Mutations that turn this suite red:
 *   F1 the page not opened on first install (or on every update)  → "opens on install only"
 *   F2 the acknowledgement not kept                               → "Got it is remembered"
 *   F3 the page claims to record consent                          → "informational"
 */
export {};

import * as fs from "fs";
import * as path from "path";

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f: string) => fs.readFileSync(path.join(EXT, f), "utf8");

describe("first-run page", () => {
  it("opens on install only (F1)", () => {
    let installed: ((d: { reason: string }) => void) | null = null;
    const openOptionsPage = jest.fn(async () => undefined);
    const chromeStub = {
      runtime: {
        id: "x",
        onMessage: { addListener: () => undefined },
        onInstalled: { addListener: (fn: (d: { reason: string }) => void) => (installed = fn) },
        openOptionsPage,
        getManifest: () => ({ version: "9.9.9" }),
      },
      tabs: { query: jest.fn(async () => []) },
    };
    const fetchStub = jest.fn(async () => ({ status: 404, json: async () => ({}) }));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", read("background.js"))(chromeStub, fetchStub);
    expect(installed).not.toBeNull();
    installed!({ reason: "update" });
    expect(openOptionsPage).not.toHaveBeenCalled();
    installed!({ reason: "install" });
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(read("manifest.json")).options_ui).toEqual({ page: "options.html", open_in_tab: true });
  });

  it("Got it is remembered locally (F2)", () => {
    const html = read("options.html");
    document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
    localStorage.clear();
    new Function(read("options.js"))();
    const button = document.getElementById("keepr-ack") as HTMLButtonElement;
    expect(button.style.display).toBe("");
    button.click();
    expect(localStorage.getItem("keepr-ack-version")).toBe("1");
    expect(button.style.display).toBe("none");
    expect(document.getElementById("keepr-ack-state")?.textContent).toMatch(/go back to Keepr/);
    // Opened again later: already acknowledged.
    document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
    new Function(read("options.js"))();
    expect((document.getElementById("keepr-ack") as HTMLButtonElement).style.display).toBe("none");
  });

  it("is informational: the agreement is given in Keepr (F3)", () => {
    const html = read("options.html");
    expect(html).toMatch(/You agree to this in Keepr itself/);
    // Never the bridge itself. BACKLOG-3666: only the pairing messages to its own worker.
    const js = read("options.js");
    expect(js).not.toMatch(/fetch\(|127\.0\.0\.1/);
    const types = Array.from(js.matchAll(/sendMessage\(\{ type: "([a-z-]+)"/g)).map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(["keepr-pair-status", "keepr-pair"]));
  });
});
