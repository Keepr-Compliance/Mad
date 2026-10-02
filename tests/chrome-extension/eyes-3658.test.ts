/**
 * BACKLOG-3658 P3c — the eye on each conversation-list row.
 *
 * Mutations that turn this suite red:
 *   Y1 the eye put inside the row's link (or more than one per row)   → "one eye per row"
 *   Y2 a click reaching the link (the chat opens)                    → "a click never opens the chat"
 *   Y3 a recycled row keeps the old chat's id                         → "a recycled row"
 *   Y4 the eye in the arrow-key order (no tabindex=-1) / no aria-label → "one eye per row"
 *   Y5 no "Not synced" mark / wrong state                            → "states"
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

  it("states: open by default; switched off = crossed out + 'Not synced' (Y5)", () => {
    const l = list(["c1", "c2"]);
    const t = setup(["c2"]);
    t.api.scan(l);
    t.flush();
    const [a, b] = Array.from(l.querySelectorAll("mws-conversation-list-item"));
    expect(eyeOf(a)!.getAttribute("aria-pressed")).toBe("false");
    expect(eyeOf(a)!.querySelector('[data-keepr="not-synced"]')).toBeNull();
    expect(eyeOf(b)!.getAttribute("aria-label")).toBe(eyes.LABEL_OFF);
    expect(eyeOf(b)!.getAttribute("aria-pressed")).toBe("true");
    expect(eyeOf(b)!.querySelector('[data-keepr="not-synced"]')?.textContent).toBe("Not synced");
    expect(eyeOf(b)!.querySelectorAll("path")).toHaveLength(2); // the eye + the strike
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

  it("a row with no conversation address gets no eye", () => {
    document.body.innerHTML = "<div mwskeynavigation><mws-conversation-list-item><a data-e2e-conversation href='/web/settings'></a></mws-conversation-list-item></div>";
    const t = setup();
    t.api.scan(document.body);
    t.flush();
    expect(document.querySelectorAll(`[${eyes.MARK}]`)).toHaveLength(0);
  });
});
