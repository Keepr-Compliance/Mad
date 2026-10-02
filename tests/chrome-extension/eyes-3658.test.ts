/**
 * BACKLOG-3658 P3c — the eye on each conversation-list row.
 *
 * Mutations that turn this suite red:
 *   Y1 the eye put inside the row's link (or more than one per row)   → "one eye per row"
 *   Y2 a click reaching the link (the chat opens)                    → "a click never opens the chat"
 *   Y3 a recycled row keeps the old chat's id                         → "a recycled row"
 *   Y4 the eye in the arrow-key order (no tabindex=-1) / no aria-label → "one eye per row"
 *   Y5 no gray overlay on a switched-off row / a text label back / wrong state → "states"
 *   Y8 the eye at a fixed offset over the timestamp, or not centred   → "placement"
 *   Y9 a pointer/mouse/focus event reaching the row or the list, or
 *      focus allowed to move (live: a real click opened the first chat) → "a real click sequence"
 *   Y6 the observer re-decorating its own eye forever                 → "observer"
 *   Y7 no per-batch cap                                               → "batches"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const eyes = require("../../chrome-extension/eyes.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

function row(id: string): HTMLElement {
  const item = document.createElement("mws-conversation-list-item");
  const a = document.createElement("a");
  a.setAttribute("data-e2e-conversation", "");
  a.setAttribute("href", `/web/conversations/${id}`);
  a.textContent = `row ${id}`;
  item.appendChild(a);
  return item;
}

function list(ids: string[]): HTMLElement {
  document.body.innerHTML = "";
  const l = document.createElement("div");
  l.setAttribute("mwskeynavigation", "");
  ids.forEach((id) => l.appendChild(row(id)));
  document.body.appendChild(l);
  return l;
}

function setup(excludedIds: string[] = []) {
  const excluded = new Set(excludedIds);
  const toggles: Array<[string, boolean]> = [];
  const tasks: Array<() => void> = [];
  const api = eyes.createEyes(document, {
    isExcluded: (id: string) => excluded.has(id),
    toggle: (id: string, off: boolean) => {
      toggles.push([id, off]);
      if (off) excluded.add(id);
      else excluded.delete(id);
    },
    theme: () => "light",
    schedule: (fn: () => void) => tasks.push(fn),
  });
  const flush = () => {
    let n = 0;
    while (tasks.length && n < 100) {
      tasks.shift()!();
      n += 1;
    }
    return n;
  };
  return { api, toggles, flush, tasks, excluded };
}

const eyeOf = (item: Element) => item.querySelector(`[${eyes.MARK}]`) as HTMLButtonElement | null;

describe("the eye on each row", () => {
  it("one eye per row, a SIBLING of the row's link, out of the arrow-key order, labelled (Y1, Y4)", () => {
    const l = list(["c1", "c2"]);
    const t = setup();
    t.api.scan(l);
    t.flush();
    t.api.scan(l); // again: still one per row
    t.flush();
    const items = Array.from(l.querySelectorAll("mws-conversation-list-item"));
    for (const item of items) {
      expect(item.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(1);
      const eye = eyeOf(item)!;
      expect(eye.parentElement).toBe(item);
      expect(item.querySelector("a")!.contains(eye)).toBe(false);
      expect(eye.getAttribute("tabindex")).toBe("-1");
      expect(eye.getAttribute("aria-label")).toBe(eyes.LABEL_ON);
      expect(eye.title).toContain(eyes.COPY);
      expect(parseInt(eye.style.minWidth, 10)).toBeGreaterThanOrEqual(24);
      expect(parseInt(eye.style.minHeight, 10)).toBeGreaterThanOrEqual(24);
    }
    expect(eyeOf(items[0])!.getAttribute(eyes.MARK)).toBe("c1");
  });

  it("a click never opens the chat; it toggles this chat (Y2)", () => {
    const l = list(["c1"]);
    const t = setup();
    t.api.scan(l);
    t.flush();
    const item = l.querySelector("mws-conversation-list-item")!;
    const link = item.querySelector("a")!;
    const seen: string[] = [];
    link.addEventListener("click", () => seen.push("link"));
    item.addEventListener("click", () => seen.push("row"));
    item.addEventListener("mousedown", () => seen.push("row-down"));
    const eye = eyeOf(item)!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    eye.dispatchEvent(down);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    eye.dispatchEvent(click);
    expect(seen).toEqual([]);
    expect(click.defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([["c1", true]]);
  });

  it("states: open by default; switched off = crossed out + a gray overlay on the row, no text label (Y5)", () => {
    const l = list(["c1", "c2"]);
    const t = setup(["c2"]);
    t.api.scan(l);
    t.flush();
    const [a, b] = Array.from(l.querySelectorAll("mws-conversation-list-item"));
    const overlayOf = (item: Element) => item.querySelector(`[${eyes.OVERLAY}]`) as HTMLElement | null;
    expect(eyeOf(a)!.getAttribute("aria-pressed")).toBe("false");
    expect(overlayOf(a)).toBeNull();
    expect(eyeOf(b)!.getAttribute("aria-label")).toBe(eyes.LABEL_OFF);
    expect(eyeOf(b)!.getAttribute("aria-label")).toMatch(/^Not synced/);
    expect(eyeOf(b)!.title).toMatch(/^Not synced/);
    expect(eyeOf(b)!.getAttribute("aria-pressed")).toBe("true");
    expect(eyeOf(b)!.querySelectorAll("path")).toHaveLength(2); // the eye + the strike
    // E3: no text label (it rendered in a serif box over the time).
    expect(eyeOf(b)!.textContent).toBe("");
    expect(eyeOf(b)!.style.fontFamily).toBe("inherit");
    // The overlay covers the whole row and lets clicks through (the row still opens).
    const layer = overlayOf(b)!;
    expect(layer.parentElement).toBe(b);
    expect(layer.style.pointerEvents).toBe("none");
    expect([layer.style.top, layer.style.right, layer.style.bottom, layer.style.left]).toEqual(["0px", "0px", "0px", "0px"]);
    expect(layer.style.background).not.toBe("");
    // Switched back on: the overlay goes.
    t.excluded.delete("c2");
    t.api.refresh();
    t.flush();
    expect(overlayOf(b)).toBeNull();
  });

  // Live 2026-10-01 (E1): a fixed offset covered the timestamp. Mutation: a
  // fixed right offset, or no vertical centring → red.
  it("placement: vertically centred, left of the timestamp's measured left edge (Y8)", () => {
    const l = list(["c1"]);
    const item = l.querySelector("mws-conversation-list-item") as HTMLElement;
    const ts = document.createElement("mws-relative-timestamp");
    ts.textContent = "3:38 PM";
    item.querySelector("a")!.appendChild(ts);
    const rect = (left: number, width: number) =>
      ({ left, right: left + width, width, top: 0, bottom: 72, height: 72, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    item.getBoundingClientRect = () => rect(0, 400);
    ts.getBoundingClientRect = () => rect(330, 45);
    const t = setup();
    t.api.scan(l);
    t.flush();
    const eye = eyeOf(item)!;
    expect(eye.style.top).toBe("50%");
    expect(eye.style.transform).toBe("translateY(-50%)");
    expect(eye.style.right).toBe("78px"); // 400 - 330 + 8: clear of the timestamp
    // A wider timestamp moves the eye further left.
    ts.getBoundingClientRect = () => rect(300, 75);
    t.api.refresh();
    t.flush();
    expect(eye.style.right).toBe("108px");
  });

  // Live 2026-10-01 (E2). Mutation: any of these events left unstopped, or
  // mousedown/pointerdown not prevented → red.
  it("a real click sequence (pointerdown → mousedown → focus → pointerup → mouseup → click) never reaches the row or the list (Y9)", () => {
    const l = list(["c1", "c2", "c3"]);
    const t = setup();
    t.api.scan(l);
    t.flush();
    const items = Array.from(l.querySelectorAll("mws-conversation-list-item"));
    const seen: string[] = [];
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "focusin", "keydown", "touchstart", "touchend"]) {
      l.addEventListener(type, () => seen.push(`list ${type}`));
      items[2].addEventListener(type, () => seen.push(`row ${type}`));
    }
    items.forEach((it, i) => it.querySelector("a")!.addEventListener("click", () => seen.push(`open ${i + 1}`)));
    const eye = eyeOf(items[2])!;
    const events = [
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      new FocusEvent("focus", { bubbles: false }),
      new FocusEvent("focusin", { bubbles: true }),
      new MouseEvent("pointerup", { bubbles: true, cancelable: true }),
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ];
    for (const e of events) eye.dispatchEvent(e);
    expect(seen).toEqual([]);
    // Focus never moves into the list: pointerdown / mousedown are prevented.
    expect(events[0].defaultPrevented).toBe(true);
    expect(events[1].defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([["c3", true]]);
    expect(eyes.STOPPED_EVENTS).toEqual(expect.arrayContaining(["pointerup", "mouseup", "focus", "focusin", "keydown"]));
  });

  it("a recycled row (Angular reuses it for another chat) gets that chat's id and state (Y3)", () => {
    const l = list(["c1"]);
    const t = setup(["c9"]);
    t.api.scan(l);
    t.flush();
    const item = l.querySelector("mws-conversation-list-item")!;
    item.querySelector("a")!.setAttribute("href", "/web/conversations/c9");
    t.api.scan(l);
    t.flush();
    expect(item.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(1);
    expect(eyeOf(item)!.getAttribute(eyes.MARK)).toBe("c9");
    expect(eyeOf(item)!.getAttribute("aria-label")).toBe(eyes.LABEL_OFF);
  });

  it("observer: new rows get an eye; the eye's own changes do not loop (Y6)", async () => {
    const l = list(["c1"]);
    const t = setup();
    t.api.observe(l);
    t.api.scan(l);
    t.flush();
    l.appendChild(row("c2"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.flush()).toBeGreaterThan(0);
    expect(eyeOf(l.querySelectorAll("mws-conversation-list-item")[1])!.getAttribute(eyes.MARK)).toBe("c2");
    // Repaint after a toggle: the observer settles (no endless re-queue).
    t.api.refresh();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      t.flush();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(t.tasks.length).toBe(0);
    t.api.disconnect();
    expect(l.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(0);
  });

  it("batches: at most BATCH rows per tick (Y7)", () => {
    const ids = Array.from({ length: eyes.BATCH + 7 }, (_, i) => `c${i}`);
    const l = list(ids);
    const t = setup();
    t.api.scan(l);
    t.tasks.shift()!();
    expect(l.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(eyes.BATCH);
    t.flush();
    expect(l.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(eyes.BATCH + 7);
  });

  // SR (optional): resize re-placement once per frame. Mutation: no debounce → red.
  it("debounceFrame: many resize events → one re-placement per animation frame", () => {
    const frames: Array<() => void> = [];
    const win = { requestAnimationFrame: (cb: () => void) => frames.push(cb) };
    let runs = 0;
    const onResize = eyes.debounceFrame(win, () => (runs += 1));
    onResize();
    onResize();
    onResize();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(runs).toBe(1);
    onResize();
    expect(frames).toHaveLength(1);
  });

  it("a row with no conversation address gets no eye", () => {
    document.body.innerHTML = "<div mwskeynavigation><mws-conversation-list-item><a data-e2e-conversation href='/web/settings'></a></mws-conversation-list-item></div>";
    const t = setup();
    t.api.scan(document.body);
    t.flush();
    expect(document.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(0);
  });
});
