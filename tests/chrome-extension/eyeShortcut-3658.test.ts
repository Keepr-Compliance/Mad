/**
 * SR K (2026-10-02): the eye's keyboard path. The "toggle-eye" command
 * (Alt+Shift+E by default, remappable) switches the eye of the focused, else
 * the selected, else the open chat; a polite live region says only "synced" /
 * "not synced" — never a name.
 *
 * Mutations that turn this red:
 *   K1 no command in the manifest / the worker not routing it      → "manifest", "worker"
 *   K2 the wrong row picked (focus not first, URL ignored)          → "eyeTarget"
 *   K3 the live region naming the chat, or not polite              → "announce"
 *   K4 the shortcut missing from the tooltip / options page         → "documented"
 */
export {};

import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const eyes = require("../../chrome-extension/eyes.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const ID = (c: string) => c.repeat(19);

function list(selectedIndex: number | null = null): void {
  document.body.innerHTML = `<div mwskeynavigation>${["a", "b", "c"]
    .map(
      (c, i) =>
        `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${ID(c)}"${
          i === selectedIndex ? ' aria-selected="true"' : ""
        } tabindex="0"><span data-e2e-conversation-name>Test Contact ${c.toUpperCase()}</span></a></mws-conversation-list-item>`,
    )
    .join("")}</div>`;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("eyeTarget (K2)", () => {
  it("the focused row first", () => {
    list(0);
    (document.querySelectorAll("a[data-e2e-conversation]")[2] as HTMLElement).focus();
    expect(eyes.eyeTarget(document, `/web/conversations/${ID("b")}`)).toBe(ID("c"));
  });

  it("else the selected row", () => {
    list(1);
    expect(eyes.eyeTarget(document, "/web/conversations")).toBe(ID("b"));
  });

  it("else the chat open in the URL; nothing matching → null", () => {
    list();
    expect(eyes.eyeTarget(document, `/web/conversations/${ID("a")}`)).toBe(ID("a"));
    expect(eyes.eyeTarget(document, "/web/conversations")).toBeNull();
  });
});

describe("announce (K3)", () => {
  it("says only the state, in a polite live region, never a name", () => {
    list();
    const live = eyes.announce(document, eyes.eyeAnnouncement(true)) as HTMLElement;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("not synced");
    eyes.announce(document, eyes.eyeAnnouncement(false));
    expect(document.querySelectorAll("#keepr-eye-live")).toHaveLength(1);
    expect(live.textContent).toBe("synced");
    expect(live.textContent).not.toMatch(/Test Contact/);
  });
});

describe("the command (K1)", () => {
  it("manifest: toggle-eye, Alt+Shift+E by default", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
    expect(manifest.commands["toggle-eye"].suggested_key.default).toBe("Alt+Shift+E");
    expect(eyes.SHORTCUT).toBe("Alt+Shift+E");
  });

  it("worker: the command goes to the active Google Messages tab", async () => {
    let onCommand: ((c: string) => void) | null = null;
    const sent: Array<[number, unknown]> = [];
    const chromeStub = {
      runtime: { id: "x", onMessage: { addListener: () => {} }, getManifest: () => ({ version: "9.9.9" }), lastError: undefined },
      commands: { onCommand: { addListener: (fn: (c: string) => void) => (onCommand = fn) } },
      tabs: {
        query: jest.fn(async () => [{ id: 7 }]),
        sendMessage: (id: number, m: unknown, cb?: () => void) => {
          sent.push([id, m]);
          if (cb) cb();
        },
      },
    };
    const fetchStub = jest.fn(async () => ({ status: 404, json: async () => ({}) }));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", fs.readFileSync(path.join(EXT, "background.js"), "utf8"))(chromeStub, fetchStub);
    expect(onCommand).not.toBeNull();
    onCommand!("toggle-eye");
    await new Promise((r) => setTimeout(r, 0));
    expect(chromeStub.tabs.query).toHaveBeenCalledWith(expect.objectContaining({ active: true, url: "https://messages.google.com/web/*" }));
    expect(sent).toEqual([[7, { type: "keepr-eye-toggle" }]]);
    onCommand!("something-else");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
  });
});

describe("documented (K4)", () => {
  it("in the eye's tooltip and on the options page", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    eyes.paint(button, false, "light");
    expect(button.title).toContain("Alt+Shift+E");
    expect(button.title).toContain("chrome://extensions/shortcuts");
    expect(fs.readFileSync(path.join(EXT, "options.html"), "utf8")).toContain("Alt+Shift+E");
  });
});
