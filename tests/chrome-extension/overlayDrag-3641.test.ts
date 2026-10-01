/**
 * BACKLOG-3641 (founder) — the page's Keepr box can be moved: dragged with the
 * pointer, or sent corner to corner with its Move button (keyboard); it stays
 * on screen and its place is remembered for the tab's session.
 *
 * Mutations that turn this suite red:
 *   O1 no clamp (the box can leave the screen)        → "stays on screen"
 *   O2 a drag that starts on a button moves the box   → "buttons keep working"
 *   O3 the place not saved at the end of a drag       → "remembers"
 *   O4 a saved place not restored (or not clamped)    → "restores"
 *   O5 the corner cycle stuck / wrong order           → "Move button cycles"
 *   O6 a drag that starts on the box body (not the grip) → "only the grip drags"
 *   O7 the grab cursor on the whole box                 → "only the grip drags"
 *   O8 a stale box of an older extension instance kept,
 *      or an older instance still showing             → "never two Keepr boxes"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const VIEW = { width: 1000, height: 800 };
const SIZE = { width: 300, height: 100 };

function pointer(type: string, x: number, y: number, target?: Element): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  (target ?? box).dispatchEvent(e);
}

let box: HTMLElement;
let saved: Array<{ left: number; top: number }>;

let handle: HTMLElement | undefined;

function setup(load: { left: number; top: number } | null = null, withHandle = false) {
  document.body.innerHTML = "";
  box = document.createElement("div");
  const button = document.createElement("button");
  button.textContent = "Cancel";
  handle = undefined;
  if (withHandle) {
    handle = document.createElement("div");
    box.appendChild(handle);
  }
  const text = document.createElement("div");
  text.textContent = "Keepr: Chat 1 of 9";
  box.appendChild(text);
  box.appendChild(button);
  document.body.appendChild(box);
  saved = [];
  const mover = job.attachDrag(box, {
    view: () => VIEW,
    size: () => SIZE,
    load: () => load,
    save: (p: { left: number; top: number }) => saved.push(p),
    ...(handle ? { handle } : {}),
  });
  return { mover, button, text };
}

const at = () => ({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) });

describe("the Keepr box can be dragged", () => {
  it("follows the pointer and remembers where it was dropped (O3)", () => {
    setup();
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 450, 350);
    expect(at()).toEqual({ left: 400, top: 300 });
    pointer("pointerup", 450, 350);
    expect(saved).toEqual([{ left: 400, top: 300 }]);
    // Moving without a press does nothing.
    pointer("pointermove", 10, 10);
    expect(at()).toEqual({ left: 400, top: 300 });
  });

  it("stays on screen whatever the pointer does (O1)", () => {
    setup();
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 5000, 5000);
    expect(at()).toEqual({ left: VIEW.width - SIZE.width - 8, top: VIEW.height - SIZE.height - 8 });
    pointer("pointermove", -400, -400);
    expect(at()).toEqual({ left: 8, top: 8 });
  });

  it("buttons keep working: a press on a button does not start a drag (O2)", () => {
    const { button } = setup();
    pointer("pointerdown", 20, 20, button);
    pointer("pointermove", 600, 600);
    pointer("pointerup", 600, 600);
    expect(box.style.left).toBe("");
    expect(saved).toEqual([]);
  });

  it("restores the saved place, clamped to the screen (O4)", () => {
    setup({ left: 5000, top: -20 });
    expect(at()).toEqual({ left: VIEW.width - SIZE.width - 8, top: 8 });
  });
});

// Founder: drag ONLY by the grip; the rest of the box is a normal box.
describe("only the grip drags (O6, O7)", () => {
  it("a press on the grip drags; a press on the text or a button does not", () => {
    const { text, button } = setup(null, true);
    pointer("pointerdown", 50, 50, text);
    pointer("pointermove", 450, 350, text);
    pointer("pointerup", 450, 350, text);
    pointer("pointerdown", 50, 50, button);
    pointer("pointerup", 450, 350, button);
    expect(box.style.left).toBe("");
    expect(saved).toEqual([]);
    pointer("pointerdown", 50, 50, handle);
    pointer("pointermove", 450, 350, handle);
    pointer("pointerup", 450, 350, handle);
    expect(at()).toEqual({ left: 400, top: 300 });
    expect(saved).toEqual([{ left: 400, top: 300 }]);
  });

  it("the real box: the grab cursor is on the badge only; Move stays a button", () => {
    const built = job.buildBox(document);
    expect(built.id).toBe(job.OVERLAY_ID);
    const move = jest.fn();
    job.renderOverlay(built, job.DONE_LINE, false, { details: "d", copy: "c" }, { copy: async () => true, move, theme: "light" });
    expect(built.style.cursor).toBe("");
    const badge = built.querySelector(job.DRAG_HANDLE) as HTMLElement;
    expect(badge.style.cursor).toBe("grab");
    const others = Array.from(built.querySelectorAll("*")).filter((n) => n !== badge && (n as HTMLElement).style.cursor === "grab");
    expect(others).toEqual([]);
    const moveButton = built.querySelector('[data-keepr="move"]') as HTMLButtonElement;
    expect(moveButton.tagName).toBe("BUTTON");
    moveButton.click();
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("with a handle selector, only the (re-rendered) badge starts a drag", () => {
    document.body.innerHTML = "";
    box = job.buildBox(document);
    document.body.appendChild(box);
    saved = [];
    job.attachDrag(box, {
      view: () => VIEW, size: () => SIZE, load: () => null,
      save: (p: { left: number; top: number }) => saved.push(p),
      handleSelector: job.DRAG_HANDLE,
    });
    job.renderOverlay(box, "Chat 8 of 21…", false, { cancel: true }, { copy: async () => true, theme: "light" });
    const line = box.querySelector('[data-keepr="line"]') as HTMLElement;
    pointer("pointerdown", 50, 50, line);
    pointer("pointermove", 450, 350, line);
    pointer("pointerup", 450, 350, line);
    expect(saved).toEqual([]);
    // A new render replaces the badge: dragging still works.
    job.renderOverlay(box, "Chat 9 of 21…", false, { cancel: true }, { copy: async () => true, theme: "light" });
    const badge = box.querySelector(job.DRAG_HANDLE) as HTMLElement;
    pointer("pointerdown", 50, 50, badge);
    pointer("pointermove", 450, 350, badge);
    pointer("pointerup", 450, 350, badge);
    expect(saved).toEqual([{ left: 400, top: 300 }]);
  });
});

// Founder saw two Keepr elements: an extension reload leaves the old content
// scripts running in the tab (another isolated world). The newest instance
// owns the page.
describe("never two Keepr boxes (O8)", () => {
  it("a newer instance removes a stale box and owns the page; the older one steps aside", () => {
    document.body.innerHTML = "";
    job.claimPage(document, "old");
    const stale = job.buildBox(document);
    document.body.appendChild(stale);
    expect(job.ownsPage(document, "old")).toBe(true);
    job.claimPage(document, "new");
    expect(document.getElementById(job.OVERLAY_ID)).toBeNull();
    expect(job.ownsPage(document, "new")).toBe(true);
    expect(job.ownsPage(document, "old")).toBe(false);
  });

  it("content.js: a second instance removes the first one's Send container; the first then stops", () => {
    jest.useFakeTimers();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs") as typeof import("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("path") as typeof import("path");
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "content.js"), "utf8");
      document.body.innerHTML = "";
      (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: () => undefined, lastError: undefined } };
      const runInstance = () => {
        // Each extension instance runs in its own isolated world: its own flag.
        delete (window as unknown as Record<string, unknown>).__keeprSendInstalled;
        new Function(src)();
      };
      runInstance();
      jest.advanceTimersByTime(1100);
      expect(document.querySelectorAll("#keepr-send-container")).toHaveLength(1);
      const first = document.getElementById("keepr-send-container");
      runInstance();
      expect(first?.isConnected).toBe(false);
      jest.advanceTimersByTime(3100);
      expect(document.querySelectorAll("#keepr-send-container")).toHaveLength(1);
      expect(document.getElementById("keepr-send-container")).not.toBe(first);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      delete (globalThis as Record<string, unknown>).chrome;
    }
  });
});

describe("the Move button (keyboard alternative)", () => {
  it("cycles the corners clockwise from top-right and remembers each (O5)", () => {
    const { mover } = setup();
    expect(mover.moveToNextCorner()).toBe("bottom-right");
    expect(at()).toEqual({ left: 1000 - 300 - 16, top: 800 - 100 - 16 });
    expect(mover.moveToNextCorner()).toBe("bottom-left");
    expect(at()).toEqual({ left: 16, top: 684 });
    expect(mover.moveToNextCorner()).toBe("top-left");
    expect(at()).toEqual({ left: 16, top: 16 });
    expect(mover.moveToNextCorner()).toBe("top-right");
    expect(at()).toEqual({ left: 684, top: 16 });
    expect(saved).toHaveLength(4);
  });

  it("clampPosition: a box bigger than the view sits at the margin", () => {
    expect(job.clampPosition({ left: 50, top: 50 }, { width: 2000, height: 2000 }, VIEW)).toEqual({ left: 8, top: 8 });
  });
});

// BACKLOG-3658 (founder): one box; it becomes the result card and can then be
// closed. Mutations: C1 no close on the result card / a failure; C2 a close on
// a running Sync's progress line; C3 the close does nothing.
describe("closing the box when the Sync is over", () => {
  function render(text: string, isError: boolean, extras?: unknown) {
    const panel = document.createElement("div");
    const close = jest.fn();
    job.renderOverlay(panel, text, isError, extras, { copy: async () => true, close });
    return { panel, close };
  }

  it("the result card and a failure have a Close (C1, C3)", () => {
    const card = render(job.DONE_LINE, false, { details: "d", copy: "c" });
    const button = card.panel.querySelector('[data-keepr="close"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Close");
    button.click();
    expect(card.close).toHaveBeenCalledTimes(1);
    expect(render("Sync cancelled in Keepr", true).panel.querySelector('[data-keepr="close"]')).not.toBeNull();
  });

  it("a running Sync's progress line has none (C2)", () => {
    expect(render("Chat 1 of 9…", false, { cancel: true }).panel.querySelector('[data-keepr="close"]')).toBeNull();
    expect(render("Loading your conversation list…", false).panel.querySelector('[data-keepr="close"]')).toBeNull();
  });
});
