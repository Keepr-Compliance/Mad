/**
 * C3 (UX redesign, founder 2026-10-03): with no Sync running, the page shows
 * only a small "K" tab on the right edge at mid-height (draggable up and down,
 * its place remembered). A tap opens ONE line + Open Keepr (/focus). Status
 * and linking live in the toolbar popup — never on the page; never a Sync
 * button on the page.
 *
 * Mutations that turn this suite red:
 *   I1 no Sync on page load → no idle tab (bootPlan without idle)       → "bootPlan"
 *   I2 the tab starts open, or shows text                              → "collapsed: the K tab"
 *   I3 Open Keepr not through /focus                                   → "a tap opens it"
 *   I4 a code field / pairing on the page                              → "nothing about linking on the page"
 *   I7 the worker does not note a finished Sync / notes a failed one    → "last sync"
 *   I8 a job's first line does not replace the idle tab                → "a job starts"
 *   T1 the tab not on the right edge / outside the safe band           → "the right edge, mid-height"
 *   T2 its place not remembered                                        → "the right edge, mid-height"
 *   T3 a drag taken for a tap (or a tap not opening it)                → "a tap opens it, a drag moves it"
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

describe("the idle K tab (C3)", () => {
  it("bootPlan: no Sync on page load shows the idle tab (I1)", () => {
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: null })).toMatchObject({ jobId: null, idle: true });
    expect(job.bootPlan({ hashJob: "j-1", storedJob: null, pendingJob: null }).idle).toBeUndefined();
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: "j-3" }).idle).toBeUndefined();
  });

  it("collapsed: the K tab only — the brand mark, no text, no button (I2)", () => {
    const box = render(idle());
    expect(box.getAttribute("data-keepr-state")).toBe("idle");
    const tab = q(box, "drag-handle")!;
    expect(tab.querySelector('[data-keepr="brand-mark"]')).not.toBeNull();
    expect(tab.textContent).toBe("");
    expect(tab.getAttribute("aria-expanded")).toBe("false");
    expect(q(box, "line")).toBeNull();
    expect(box.querySelectorAll("button")).toHaveLength(0);
  });

  it("a tap opens it: one line and Open Keepr (/focus) at the bottom-right, no version line (I3)", async () => {
    const onExpand = jest.fn();
    const closed = render(idle(), { onExpand });
    q(closed, "drag-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onExpand).toHaveBeenCalledWith(true);
    const focus = jest.fn(async () => true);
    const box = render(idle(), { expanded: true, focus });
    expect(q(box, "line")!.textContent).toBe(job.IDLE_TAB_LINE);
    expect(q(box, "version")).toBeNull();
    expect(box.textContent).not.toContain("0.3.19");
    const row = q(box, "bottom-row")!;
    expect(row.style.justifyContent).toBe("flex-end");
    expect(row.lastElementChild!.getAttribute("data-keepr")).toBe("open-keepr");
    expect(box.lastElementChild).toBe(row);
    q(box, "open-keepr")!.click();
    await flush();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("nothing about linking on the page; never a Sync button (I4)", () => {
    for (const expanded of [false, true]) {
      const box = render(idle(), { expanded, focus: async () => true });
      const labels = Array.from(box.querySelectorAll("button")).map((b) => b.textContent || "");
      expect(labels.some((l) => /sync|pair|link/i.test(l))).toBe(false);
      expect(box.querySelector("input")).toBeNull();
    }
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    expect(src).not.toMatch(/keepr-pair"|pair-code|Pair with Keepr/);
  });

  it("a job starts: its first line replaces the idle tab in the same box (I8)", () => {
    const box = render(idle());
    job.renderOverlay(box, "Reading chat 1 of 3", false, { cancel: true, run: { phase: "reading", index: 1, total: 3, done: 0 } }, { copy: async () => true });
    expect(box.getAttribute("data-keepr-state")).toBe("syncing");
    expect(q(box, "line")!.textContent).toBe("Syncing your texts");
    expect(q(box, "progress")!.textContent).toBe("Reading chat 1 of 3");
  });

  it("touches only its own box: nothing else is added to the page", () => {
    document.body.innerHTML = "<div id='app'>page</div>";
    render(idle(), { expanded: true });
    expect(document.body.children).toHaveLength(2);
  });
});

describe("the tab's place (C3)", () => {
  const view = { width: 1200, height: 800 };
  const size = { width: 38, height: 44 };

  it("the right edge, mid-height, inside the safe band (T1)", () => {
    const mid = job.tabPosition(0.5, size, view);
    expect(mid.left).toBe(1200 - 38 - 18);
    // Off the header (top) and the compose box (bottom).
    expect(job.tabPosition(0, size, view).top).toBe(72);
    expect(job.tabPosition(1, size, view).top).toBe(800 - 104 - 44);
    expect(mid.top).toBe(Math.round(72 + (800 - 104 - 44 - 72) / 2));
    expect(job.tabPosition(undefined, size, view)).toEqual(mid);
    expect(job.tabPosition(7, size, view).top).toBe(800 - 104 - 44);
  });

  it("a tap opens it, a drag moves it along the edge and its place is remembered (T2, T3)", () => {
    const box = document.createElement("div");
    const handle = document.createElement("div");
    handle.setAttribute("data-keepr", "drag-handle");
    box.appendChild(handle);
    document.body.appendChild(box);
    const saved: unknown[] = [];
    const onTap = jest.fn();
    const mover = job.attachDrag(box, {
      handleSelector: '[data-keepr="drag-handle"]',
      rightEdge: true,
      onTap,
      view: () => view,
      size: () => size,
      load: () => ({ topFrac: 0 }),
      save: (p: unknown) => saved.push(p),
    });
    expect(box.style.top).toBe("72px");
    const ev = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      handle.dispatchEvent(e);
    };
    // A tap: a pixel of jitter is not a drag.
    ev("pointerdown", 1170, 90);
    ev("pointermove", 1171, 91);
    ev("pointerup", 1171, 91);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    ev("pointerdown", 1170, 90);
    ev("pointermove", 400, 400);
    ev("pointerup", 400, 400);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(box.style.left).toBe(String(1200 - 38 - 18) + "px"); // stays on the right edge
    expect(saved).toHaveLength(1);
    expect((saved[0] as { topFrac: number }).topFrac).toBeGreaterThan(0);
    // The keyboard: top → middle → bottom → top.
    expect(mover.moveToNextCorner()).toBe(1);
  });

  // SR (2026-10-03): the place lives in the EXTENSION's storage, never the
  // page's (Google's scripts could read it); read back as untrusted.
  // Mutations: page localStorage used → red; no clamping → red.
  it("the page's box uses the right edge, remembered in the extension's storage", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    expect(src).toContain("        rightEdge: true,");
    expect(src).toContain("void chrome.storage.local.set(item);");
    expect(src).not.toMatch(/localStorage.(setItem|getItem)/);
  });

  it("the remembered place is untrusted: only a finite topFrac, clamped", () => {
    expect(job.sanitizeTabPosition({ topFrac: 0.3 })).toEqual({ topFrac: 0.3 });
    expect(job.sanitizeTabPosition({ topFrac: 9 })).toEqual({ topFrac: 1 });
    expect(job.sanitizeTabPosition({ topFrac: -2 })).toEqual({ topFrac: 0 });
    for (const bad of [null, "0.5", { topFrac: "0.5" }, { topFrac: Infinity }, { left: 3, top: 4 }]) {
      expect(job.sanitizeTabPosition(bad)).toBeNull();
    }
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
