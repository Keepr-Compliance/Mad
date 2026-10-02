/**
 * Founder (2026-10-02; reverses "nothing on the page while idle"): with no
 * Sync running, the Keepr box sits on Messages for Web as its COLLAPSED chip,
 * "Keepr · Open Keepr to sync". The chip (or Open Keepr in the expanded view)
 * calls the existing /focus route; when Keepr is not reachable (bridge down /
 * signed out) it reads "Keepr · Start the Keepr app to sync" and there is no
 * button. NEVER a Sync button on the page. Expanded: how to start a Sync,
 * the last sync time if known (this extension's own record), the version.
 *
 * Mutations that turn this suite red:
 *   I1 no Sync on page load → no idle chip (bootPlan without idle)      → "bootPlan"
 *   I2 the idle chip starts expanded                                    → "collapsed chip"
 *   I3 the chip does not open Keepr (no /focus)                         → "the chip opens Keepr"
 *   I4 an unreachable Keepr still gets the Open Keepr button / wrong line → "unreachable"
 *   I5 a 403 (signed out) read as reachable                             → "reachability"
 *   I6 a failed /focus does not switch to the "Start the Keepr app" chip → "a failed /focus"
 *   I7 the worker does not note a finished Sync / notes a failed one    → "last sync"
 *   I8 a job's first line does not replace the idle chip                → "a job starts"
 */
export {};

import * as fs from "fs";
import { installPairing, signedReply, uninstallPairing } from "./helpers/pairedWorker";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);

function render(extras: unknown, io: Record<string, unknown> = {}) {
  const box = document.createElement("div");
  document.body.appendChild(box);
  job.renderOverlay(box, "", false, extras, { copy: async () => true, ...io });
  return box;
}
const q = (box: HTMLElement, key: string) => box.querySelector(`[data-keepr="${key}"]`) as HTMLElement | null;
const idle = (over: Record<string, unknown> = {}) => ({ idle: { reachable: true, lastSyncAt: null, nowMs: NOW, ...over }, version: "0.3.19" });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
  uninstallPairing();
});

describe("the idle chip", () => {
  it("bootPlan: no Sync on page load shows the idle chip (I1)", () => {
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: null })).toMatchObject({ jobId: null, idle: true });
    expect(job.bootPlan({ hashJob: "j-1", storedJob: null, pendingJob: null }).idle).toBeUndefined();
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: "j-3" }).idle).toBeUndefined();
  });

  it("collapsed chip: 'Keepr · Open Keepr to sync', a ▾, no body (I2)", () => {
    const box = render(idle());
    expect(box.getAttribute("data-keepr-state")).toBe("idle");
    expect(q(box, "line")!.textContent).toBe("Keepr · Open Keepr to sync");
    expect(q(box, "expand")!.getAttribute("aria-expanded")).toBe("false");
    expect(q(box, "idle-how")).toBeNull();
    expect(q(box, "drag-handle")).not.toBeNull(); // draggable like every state
    expect(box.style.borderRadius).toBe("999px");
  });

  it("the chip opens Keepr through /focus (I3)", async () => {
    const focus = jest.fn(async () => true);
    const box = render(idle(), { focus });
    q(box, "line")!.click();
    await flush();
    expect(focus).toHaveBeenCalledTimes(1);
    q(box, "line")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("▾ asks to expand; expanded: how to start, last sync, Open Keepr, version", async () => {
    const onExpand = jest.fn();
    render(idle(), { onExpand }).querySelector<HTMLElement>('[data-keepr="expand"]')!.click();
    expect(onExpand).toHaveBeenCalledWith(true);
    const focus = jest.fn(async () => true);
    const box = render(idle({ lastSyncAt: NOW - 5 * 60000 }), { expanded: true, focus });
    expect(q(box, "idle-how")!.textContent).toBe("Start a sync from Keepr: Dashboard → Sync Android");
    expect(q(box, "last-sync")!.textContent).toBe("Last sync: 5 min ago");
    expect(q(box, "version")!.textContent).toBe("Keepr extension 0.3.19");
    q(box, "open-keepr")!.click();
    await flush();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("no last sync known: no time line", () => {
    expect(q(render(idle(), { expanded: true }), "last-sync")).toBeNull();
  });

  it("unreachable: 'Keepr · Start the Keepr app to sync', no button, the chip opens nothing (I4)", async () => {
    const focus = jest.fn(async () => true);
    const box = render(idle({ reachable: false }), { expanded: true, focus });
    expect(q(box, "line")!.textContent).toBe("Keepr · Start the Keepr app to sync");
    expect(q(box, "open-keepr")).toBeNull();
    q(box, "line")!.click();
    await flush();
    expect(focus).not.toHaveBeenCalled();
  });

  it("a failed /focus switches to the 'Start the Keepr app' chip (I6)", async () => {
    const onUnreachable = jest.fn();
    const box = render(idle({ onUnreachable }), { focus: async () => false });
    q(box, "line")!.click();
    await flush();
    expect(onUnreachable).toHaveBeenCalledTimes(1);
  });

  it("never a Sync button on the page, collapsed or expanded, reachable or not", () => {
    for (const reachable of [true, false]) {
      for (const expanded of [false, true]) {
        const box = render(idle({ reachable }), { expanded, focus: async () => true });
        const labels = Array.from(box.querySelectorAll("button")).map((b) => b.textContent || "");
        expect(labels.some((l) => /sync/i.test(l))).toBe(false);
      }
    }
  });

  it("a job starts: its first line replaces the idle chip in the same box (I8)", () => {
    const box = render(idle());
    job.renderOverlay(box, "Checking chat 1 of 3…", false, { cancel: true }, { copy: async () => true });
    expect(box.getAttribute("data-keepr-state")).toBe("syncing");
    expect(q(box, "line")!.textContent).toContain("syncing 1 of 3");
  });

  it("touches only its own box: nothing else is added to the page", () => {
    document.body.innerHTML = "<div id='app'>page</div>";
    const box = render(idle(), { expanded: true });
    expect(document.body.children).toHaveLength(2);
    expect(box.contains(q(box, "idle-how"))).toBe(true);
    expect(box.style.pointerEvents).not.toBe("none");
  });
});

describe("reachability and last sync text", () => {
  it("reachability from the existing /exclusions/list reply (I5)", () => {
    expect(job.idleReachability({ ok: true, status: 200, body: { conversationIds: [] } })).toBe("ready");
    expect(job.idleReachability({ ok: false, status: 501 })).toBe("ready");
    expect(job.idleReachability({ ok: false, status: 403 })).toBe("signed_out");
    // SR B1: Keepr wants signed requests (this extension lost its pairing): reachable → the pair chip.
    expect(job.idleReachability({ ok: false, status: 401, body: { error: "signature_required" } })).toBe("ready");
    expect(job.idleReachability({ ok: false, status: 401, body: { error: "other" } })).toBe("down");
    expect(job.idleReachability({ ok: false, status: 0 })).toBe("down");
    expect(job.idleReachability(null)).toBe("down");
  });

  it("lastSyncText: just now, minutes, hours, yesterday, days; unknown → null", () => {
    expect(job.lastSyncText(NOW - 10_000, NOW)).toBe("Last sync: just now");
    expect(job.lastSyncText(NOW - 42 * 60000, NOW)).toBe("Last sync: 42 min ago");
    expect(job.lastSyncText(NOW - 3 * 3600000, NOW)).toBe("Last sync: 3 h ago");
    expect(job.lastSyncText(NOW - 30 * 3600000, NOW)).toBe("Last sync: yesterday");
    expect(job.lastSyncText(NOW - 5 * 86400000, NOW)).toBe("Last sync: 5 days ago");
    expect(job.lastSyncText(null, NOW)).toBeNull();
  });
});

describe("the worker's last sync record (I7)", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
  const ID = "nlfohmjehedijceeelokclkglmjnlonj";
  type Listener = (m: Record<string, unknown>, s: { id: string }, r: (x: unknown) => void) => boolean;

  async function worker(status: number) {
    let listener: Listener | null = null;
    const local: Record<string, unknown> = {};
    const chromeStub = {
      runtime: { id: ID, onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version: "9.9.9" }) },
      storage: {
        local: {
          get: async (key: string) => (key in local ? { [key]: local[key] } : {}),
          set: async (items: Record<string, unknown>) => void Object.assign(local, items),
        },
      },
      tabs: { query: jest.fn(async () => []) },
      windows: { update: jest.fn() },
    };
    // BACKLOG-3666: job calls need a pairing; replies signed as Keepr signs them.
    await installPairing(true);
    const fetchStub = jest.fn(async (url: string, init: { headers?: Record<string, string> }) => signedReply(url, init, status, {}));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "fetch", SOURCE)(chromeStub, fetchStub);
    const send = (m: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => listener!(m, { id: ID }, (x) => resolve(x as Record<string, unknown>)));
    await flush();
    return { send, local };
  }
  const finish = { type: "keepr-job-api", method: "POST", path: "/job/job-1/finish", body: {} };

  it("a finish Keepr answered is noted; the chip reads it back", async () => {
    const w = await worker(200);
    expect(await w.send({ type: "keepr-last-sync" })).toEqual({ ok: true, at: null });
    const before = Date.now();
    await w.send(finish);
    const r = await w.send({ type: "keepr-last-sync" });
    expect(typeof r.at).toBe("number");
    expect(r.at as number).toBeGreaterThanOrEqual(before);
  });

  it("a failed finish, or any other job call, is not noted", async () => {
    const failed = await worker(500);
    await failed.send(finish);
    expect(failed.local).toEqual({});
    const other = await worker(200);
    await other.send({ ...finish, path: "/job/job-1/chat" });
    expect(other.local).toEqual({});
  });
});

// BACKLOG-3666: Keepr is there but this extension is not paired → the chip
// says "Pair with Keepr" and expands to the code field (never a Sync button).
// Mutations: the pair chip not shown → red; the code not sent → red; typing
// reaching Google's shortcuts → red; a failed pair claiming success → red.
describe("the idle chip when unpaired (BACKLOG-3666)", () => {
  const unpaired = (over: Record<string, unknown> = {}) => idle({ paired: false, ...over });

  it("collapsed: 'Keepr · Pair with Keepr'; clicking it opens the code field, not Keepr", async () => {
    const focus = jest.fn(async () => true);
    const onExpand = jest.fn();
    const box = render(unpaired(), { focus, onExpand });
    expect(q(box, "line")!.textContent).toBe("Keepr · Pair with Keepr");
    q(box, "line")!.click();
    expect(onExpand).toHaveBeenCalledWith(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("expanded: the code field and Pair; the right code pairs", async () => {
    const pair = jest.fn(async () => ({ ok: true }));
    const onPaired = jest.fn();
    const box = render(unpaired({ pair, onPaired }), { expanded: true });
    expect(q(box, "open-keepr")).toBeNull();
    const input = q(box, "pair-code") as HTMLInputElement;
    input.value = "ab3d-ef7h";
    q(box, "pair")!.click();
    await flush();
    expect(pair).toHaveBeenCalledWith("ab3d-ef7h");
    expect(q(box, "pair-result")!.textContent).toBe("Paired with Keepr.");
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it("a refused code shows why and lets the user try again", async () => {
    const box = render(unpaired({ pair: async () => ({ ok: false, error: "That code didn't match." }) }), { expanded: true });
    q(box, "pair")!.click();
    await flush();
    expect(q(box, "pair-result")!.textContent).toBe("That code didn't match.");
    expect((q(box, "pair") as HTMLButtonElement).disabled).toBe(false);
  });

  it("typing the code never reaches the page's keyboard shortcuts", () => {
    const box = render(unpaired(), { expanded: true });
    const seen = jest.fn();
    document.addEventListener("keydown", seen);
    q(box, "pair-code")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    document.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it("paired: the usual chip", () => {
    expect(q(render(idle({ paired: true })), "line")!.textContent).toBe("Keepr · Open Keepr to sync");
  });
});
