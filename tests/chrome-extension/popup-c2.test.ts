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
    expect(linking.box.querySelector(".code")!.textContent).toBe("042 137");
    expect(linking.box.textContent).toContain(popup.COPY.linking);
    expect(linking.box.textContent).toContain("1:35");
    q(linking.box, "open-app")!.click();
    q(linking.box, "cancel")!.click();
    expect(linking.calls).toEqual(["openApp", "cancel"]);

    const linked = draw({ state: "linked", email: "a***@example.test", lastSyncAt: NOW - 5 * 60_000 });
    expect(linked.box.textContent).toContain("Linked to a***@example.test");
    expect(linked.box.textContent).toContain("Last sync: 5 min ago");
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
    expect(document.querySelector(".code")!.textContent).toBe("123 456");
    state = "linked";
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(asked).toEqual(["keepr-popup-state", "keepr-popup-state"]);
    jest.useRealTimers();
  });

  it("the toolbar button opens it (P5)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "manifest.json"), "utf8"));
    expect(manifest.action).toEqual({ default_title: "Keepr", default_popup: "popup.html" });
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "popup.html"), "utf8");
    expect(html).toContain('<script src="popup.js"></script>');
  });
});

// C2: the worker's "Go to Google Messages" and "Open Keepr" (keepr://link).
// Mutations: a second Messages tab opened when one exists → red; Open Keepr
// not via keepr://link → red.
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

  it("Open Keepr (not running, or linking): keepr://link", async () => {
    const w = worker([]);
    await w.send({ type: "keepr-open-app" });
    expect(w.calls[0]).toEqual(["create", "keepr://link"]);
  });
});
