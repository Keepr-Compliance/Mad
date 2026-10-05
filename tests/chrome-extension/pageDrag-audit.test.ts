/**
 * Founder (live 0.3.57, repeated): NOTHING on the Google Messages page is
 * pinned, and nothing covers Google's own controls by default.
 *
 *   1. Every state of the page box has exactly ONE drag handle (the brand
 *      mark / badge / K tab: data-keepr="drag-handle", grab cursor).
 *   2. The not-linked card opens at the TOP CENTRE (top 16px), is dragged
 *      anywhere, and its place is remembered (its own key).
 *   3. Every other state's default is the right edge inside the safe band —
 *      below Google's top bar (account / menu), above the compose box — and
 *      never over the conversation list (Start chat is on the left).
 *
 * Mutation controls (each turns a test red):
 *   A1 a state without the drag handle (e.g. the guide's old "guide-mark")
 *   A2 the guide pinned again (free mode ignored)
 *   A3 the guide's default top-right (or not top 16)
 *   A4 the guide's drop not remembered / not restored
 *   A5 the safe band dropped (top 0 or into the compose box)
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const IO = { copy: async () => true, theme: "light" as const, focus: async () => true, cancel: async () => true, close: () => undefined, retry: () => undefined };

function rendered(text: string, isError: boolean, extras: Record<string, unknown>, io: Record<string, unknown> = {}): HTMLElement {
  const box = job.buildBox(document);
  job.renderOverlay(box, text, isError, extras, { ...IO, ...io });
  return box;
}

const STATES: Array<[string, () => HTMLElement]> = [
  ["not-linked card", () => rendered("", false, { idle: { linked: false, guide: true } })],
  ["idle K tab (closed)", () => rendered("", false, { idle: { linked: true } })],
  ["idle K tab (open)", () => rendered("", false, { idle: { linked: true } }, { expanded: true })],
  ["syncing", () => rendered("x", false, { cancel: true, run: { phase: "reading", index: 2, total: 9, done: 1 } })],
  ["stop confirm", () => rendered("x", false, { cancel: true, run: { phase: "reading", index: 2, total: 9, done: 1 } }, { stop: { state: "open", openedAt: Date.now() } })],
  ["paused", () => rendered(job.PAUSED_TEXT, false, { cancel: true })],
  ["done", () => rendered(job.DONE_LINE, false, { details: "d", copy: "c", summary: "2 chats" })],
  ["failed", () => rendered("Lost the connection to your phone.", true, { details: "d", copy: "c", retry: true })],
  ["stopped", () => rendered("", false, { stopped: true })],
  ["not signed in", () => rendered("", false, { signIn: true })],
];

describe("every page element is draggable (A1)", () => {
  it.each(STATES)("%s: exactly one drag handle, grab cursor", (_name, make) => {
    const box = make();
    const handles = box.querySelectorAll(job.DRAG_HANDLE);
    expect(handles).toHaveLength(1);
    expect((handles[0] as HTMLElement).style.cursor).toBe("grab");
  });

  it("done with its details open: still the one handle", () => {
    const box = rendered(job.DONE_LINE, false, { details: "d", copy: "c", summary: "2 chats" });
    const toggle = box.querySelector('[data-keepr="details-toggle"]') as HTMLElement;
    toggle.click();
    expect(box.textContent).toContain("d");
    expect(box.querySelectorAll(job.DRAG_HANDLE)).toHaveLength(1);
  });
});

function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
}

describe("the not-linked card: top centre, dragged anywhere, remembered (A2–A4)", () => {
  const VIEW = { width: 1400, height: 900 };
  const SIZE = { width: 320, height: 120 };
  function mount(loadFree: { left: number; top: number } | null) {
    document.body.innerHTML = "";
    const box = rendered("", false, { idle: { linked: false, guide: true } });
    document.body.appendChild(box);
    const saved: unknown[] = [];
    const mover = job.attachDrag(box, {
      handleSelector: job.DRAG_HANDLE,
      rightEdge: true,
      free: () => box.getAttribute("data-keepr-state") === "not_linked",
      freeDefault: () => job.guidePosition(SIZE.width, VIEW.width),
      loadFree: () => loadFree,
      saveFree: (p: unknown) => saved.push(p),
      load: () => null,
      save: () => undefined,
      view: () => VIEW,
      size: () => SIZE,
    });
    mover.keepOnScreen();
    const at = () => ({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) });
    return { box, mover, saved, at };
  }

  it("default: horizontally centred, 16px from the top", () => {
    expect(job.guidePosition(320, 1400)).toEqual({ left: 540, top: 16 });
    const m = mount(null);
    expect(m.at()).toEqual({ left: 540, top: 16 });
  });

  it("dragged by its mark anywhere (not snapped to the right edge), clamped, and remembered", () => {
    const m = mount(null);
    const handle = m.box.querySelector(job.DRAG_HANDLE) as HTMLElement;
    pointer(handle, "pointerdown", 560, 30);
    pointer(handle, "pointermove", 220, 430);
    expect(m.at()).toEqual({ left: 200, top: 416 });
    pointer(handle, "pointerup", 220, 430);
    expect(m.saved).toEqual([{ left: 200, top: 416 }]);
    // A re-render keeps it there (never pinned back).
    m.mover.keepOnScreen();
    expect(m.at()).toEqual({ left: 200, top: 416 });
  });

  it("the remembered place is restored (clamped to the view)", () => {
    expect(mount({ left: 200, top: 416 }).at()).toEqual({ left: 200, top: 416 });
    expect(mount({ left: 99999, top: 5 }).at()).toEqual({ left: VIEW.width - SIZE.width - 8, top: 8 });
  });

  it("the stored value is untrusted: only finite left / top, clamped", () => {
    expect(job.sanitizeFreePosition({ left: 12.4, top: 30, extra: "x" })).toEqual({ left: 12, top: 30 });
    expect(job.sanitizeFreePosition({ left: -5, top: 1e9 })).toEqual({ left: 0, top: 20000 });
    for (const bad of [null, "x", { left: "1", top: 2 }, { left: NaN, top: 1 }, { top: 1 }]) expect(job.sanitizeFreePosition(bad)).toBeNull();
  });
});

describe("other states' default never covers Google's controls (A5)", () => {
  it("right edge, below the top bar, above the compose box", () => {
    const view = { width: 1400, height: 900 };
    for (const size of [{ width: 40, height: 56 }, { width: 340, height: 220 }]) {
      for (const frac of [0, 0.5, 1]) {
        const p = job.tabPosition(frac, size, view);
        expect(p.top).toBeGreaterThanOrEqual(72); // Google's top bar (account / menu)
        expect(p.top + size.height).toBeLessThanOrEqual(view.height - 104); // the compose box
        expect(p.left).toBeGreaterThan(view.width / 2); // never over the list / Start chat
      }
    }
  });
});

// Founder clarification: the K tab and every card opened from it or during
// a Sync open at the RIGHT edge, vertically centred (in the safe band) —
// unless the user dragged it: then the remembered place, kept on screen. The
// not-linked card is the one exception (top centre). Mutations: a state
// opening elsewhere; the remembered place ignored → red.
describe("default place per state", () => {
  const VIEW = { width: 1400, height: 900 };
  const SIZE = { width: 340, height: 200 };
  function placeOf(make: () => HTMLElement, saved: { topFrac: number } | null) {
    document.body.innerHTML = "";
    const box = make();
    document.body.appendChild(box);
    const mover = job.attachDrag(box, {
      handleSelector: job.DRAG_HANDLE,
      rightEdge: true,
      rightGap: () => 18,
      free: () => box.getAttribute("data-keepr-state") === "not_linked",
      freeDefault: () => job.guidePosition(SIZE.width, VIEW.width),
      loadFree: () => null,
      saveFree: () => undefined,
      load: () => saved,
      save: () => undefined,
      view: () => VIEW,
      size: () => SIZE,
    });
    mover.keepOnScreen();
    return { left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
  }
  const centred = job.tabPosition(0.5, SIZE, VIEW, 18);

  it("right edge, vertically centred in the safe band — every state but the not-linked card", () => {
    expect(centred.left).toBe(VIEW.width - SIZE.width - 18);
    expect(centred.top).toBe(Math.round(72 + (VIEW.height - 104 - SIZE.height - 72) / 2));
    for (const [name, make] of STATES) {
      const expected = name === "not-linked card" ? job.guidePosition(SIZE.width, VIEW.width) : centred;
      expect([name, placeOf(make, null)]).toEqual([name, expected]);
    }
  });

  it("dragged before: the remembered place (on screen), never the default", () => {
    const remembered = job.tabPosition(0.2, SIZE, VIEW, 18);
    for (const [name, make] of STATES.filter(([n]) => n !== "not-linked card")) {
      expect([name, placeOf(make, { topFrac: 0.2 })]).toEqual([name, remembered]);
    }
  });
});
