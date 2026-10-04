/**
 * BACKLOG-3658 / 3641 — the page's Keepr box, founder's design C ("collapsible
 * chip"), its auto theme, and the security-review H1 stopgap (a Sync Keepr did
 * not open the tab for asks first).
 *
 * Mutations that turn this suite red:
 *   D1 a dark page gets the light box (theme ignored / threshold inverted) → "auto theme"
 *   D2 a transparent page colour read as a theme (no fallback)            → "auto theme"
 *   D3 the syncing pill starts expanded, or ▾ does nothing                → "syncing: a collapsed pill"
 *   D4 paused or done not auto-expanded                                   → "paused" / "done"
 *   D5 green anywhere, or the details link underlined                     → "done"
 *   H1a a pending job (found on page load) runs without asking            → "bootPlan"
 *   H1b Start / Not now not wired                                         → "ask"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const IO = { copy: async () => true };
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

function render(text: string, isError: boolean, extras?: unknown, io: Record<string, unknown> = {}) {
  const box = document.createElement("div");
  document.body.appendChild(box);
  job.renderOverlay(box, text, isError, extras, { ...IO, ...io });
  return box;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.backgroundColor = "";
});

describe("auto theme (D1, D2)", () => {
  it("themeFromColor: dark and light page colours; transparent says nothing", () => {
    expect(job.themeFromColor("rgb(32, 33, 36)")).toBe("dark");
    expect(job.themeFromColor("rgb(255, 255, 255)")).toBe("light");
    expect(job.themeFromColor("rgb(241, 243, 244)")).toBe("light");
    expect(job.themeFromColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(job.themeFromColor("transparent")).toBeNull();
  });

  it("a dark Messages page gets the dark box; a light one the light box", () => {
    document.body.style.backgroundColor = "rgb(32, 33, 36)";
    expect(job.pageTheme(document)).toBe("dark");
    const dark = render(job.DONE_LINE, false, { details: "d", copy: "c" });
    expect(dark.getAttribute("data-keepr-theme")).toBe("dark");
    expect(dark.style.background).toBe(rgb(job.PALETTE.dark.card));
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    expect(job.pageTheme(document)).toBe("light");
    expect(render(job.DONE_LINE, false, { details: "d", copy: "c" }).style.background).toBe(rgb(job.PALETTE.light.card));
  });

  it("no page colour: the system preference, else light", () => {
    expect(job.pageTheme(document)).toBe("light");
    const original = window.matchMedia;
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes("dark") });
    try {
      expect(job.pageTheme(document)).toBe("dark");
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = original;
    }
  });
});

describe("states (design C)", () => {
  it("syncing: a collapsed pill 'Keepr · syncing 8 of 21 — keep this tab open' with ▾; ▾ asks to expand; expanded shows progress + Cancel (D3)", () => {
    const onExpand = jest.fn();
    const pill = render("Chat 8 of 21…", false, { cancel: true }, { onExpand, theme: "light" });
    expect(pill.getAttribute("data-keepr-state")).toBe("syncing");
    expect(pill.style.borderRadius).toBe("999px");
    // Founder (2026-10-01): the keep-on-screen hint from the first second.
    // Mutation: the hint only once paused → red.
    expect(pill.querySelector('[data-keepr="line"]')?.textContent).toBe("Keepr · syncing 8 of 21 — keep this tab open");
    expect(pill.querySelector('[data-keepr="hint"]')).toBeNull();
    expect(pill.querySelector('[data-keepr="cancel"]')).toBeNull();
    const expand = pill.querySelector('[data-keepr="expand"]') as HTMLButtonElement;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expand.click();
    expect(onExpand).toHaveBeenCalledWith(true);
    const card = render("Chat 8 of 21…", false, { cancel: true }, { expanded: true, theme: "light" });
    expect(card.style.borderRadius).toBe("16px");
    // The mockup (BoxSyncing): title, a 6px bar (8 of 21 = 38%), the line, Stop sync right.
    expect(card.querySelector('[data-keepr="line"]')?.textContent).toBe("Syncing your texts");
    expect((card.querySelector('[data-keepr="progress-fill"]') as HTMLElement).style.width).toBe("38%");
    expect(card.querySelector('[data-keepr="progress"]')?.textContent).toBe("Chat 8 of 21 · keep this tab open");
    expect(card.querySelector('[data-keepr="hint"]')).toBeNull();
    expect(card.querySelector('[data-keepr="cancel"]')).not.toBeNull();
    // A line that is not "n of m" keeps its words.
    const waiting = render("Saving in Keepr…", false, undefined, { theme: "light" });
    expect(waiting.querySelector('[data-keepr="line"]')?.textContent).toBe("Keepr · Saving in Keepr — keep this tab open");
  });

  it("paused: auto-expanded, amber, says what to do, keeps Cancel (D4)", () => {
    const box = render(job.PAUSED_TEXT, false, { cancel: true }, { theme: "dark" });
    expect(box.getAttribute("data-keepr-state")).toBe("paused");
    expect(box.style.width).toBe("320px");
    expect(box.style.border.toLowerCase()).toMatch(/#8a6a2f|rgb\(138, 106, 47\)/);
    expect(box.querySelector('[data-keepr="line"]')?.textContent).toBe("Sync paused");
    expect(box.querySelector('[data-keepr="progress"]')?.textContent).toBe("Keep this Chrome window visible — Sync continues when it's back.");
    expect(box.querySelector('[data-keepr="hint"]')).toBeNull();
    expect(box.querySelector('[data-keepr="cancel"]')).not.toBeNull();
  });

  it("done: auto-expanded with ✓, link not underlined, Open Keepr primary, closable; no green (D4, D5)", () => {
    const close = jest.fn();
    const box = render(job.DONE_LINE, false, { details: "d", copy: "c" }, { close, theme: "light" });
    expect(box.getAttribute("data-keepr-state")).toBe("done");
    expect(box.querySelector('[data-keepr="drag-handle"]')?.textContent).toBe("✓");
    expect((box.querySelector('[data-keepr="details-toggle"]') as HTMLElement).style.textDecoration).toBe("none");
    expect((box.querySelector('[data-keepr="open-keepr"]') as HTMLElement).style.background).toBe(rgb("#4F46E5"));
    (box.querySelector('[data-keepr="close"]') as HTMLElement).click();
    expect(close).toHaveBeenCalledTimes(1);
    for (const theme of ["light", "dark"]) {
      const html = render(job.DONE_LINE, false, { details: "d", copy: "c" }, { theme }).outerHTML;
      expect(html).not.toMatch(/#(?:16a34a|22c55e|dcfce7|166534)|rgb\(\s*(?:22, 163, 74|34, 197, 94|220, 252, 231|22, 101, 52)\s*\)/i);
    }
  });
});

describe("security H1: a Sync Keepr did not open the tab for asks first", () => {
  it("bootPlan: the hash or its kept copy run at once; a pending job asks (H1a)", () => {
    expect(job.bootPlan({ hashJob: "j-1", storedJob: null, pendingJob: null })).toEqual({ jobId: "j-1", ask: false });
    expect(job.bootPlan({ hashJob: null, storedJob: "j-2", pendingJob: null })).toEqual({ jobId: "j-2", ask: false });
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: "j-3" })).toEqual({ jobId: "j-3", ask: true });
    expect(job.bootPlan({ hashJob: null, storedJob: null, pendingJob: null })).toEqual({ jobId: null, ask: false, idle: true }); // no Sync: the idle chip
  });

  it("ask: 'Keepr wants to sync your texts' — Start runs it, Not now does not (H1b)", () => {
    const start = jest.fn();
    const later = jest.fn();
    const box = render(job.ASK_TITLE, false, { ask: { start, later } }, { theme: "light" });
    expect(box.getAttribute("data-keepr-state")).toBe("ask");
    expect(box.querySelector('[data-keepr="line"]')?.textContent).toBe("Keepr wants to sync your texts");
    expect(start).not.toHaveBeenCalled();
    (box.querySelector('[data-keepr="ask-later"]') as HTMLElement).click();
    expect(later).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    (box.querySelector('[data-keepr="ask-start"]') as HTMLElement).click();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
