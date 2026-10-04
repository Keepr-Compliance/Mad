/**
 * The founder-approved mockups (uxflow: Popup*, Box*, Welcome — 2026-10-03),
 * checked token by token without screenshots: sizes, spacing, colours and
 * the order of the buttons. Popup / welcome: their stylesheet's rules (the
 * light tokens on :root, the dark ones under prefers-color-scheme). Box: the
 * inline styles renderOverlay sets.
 *
 * Mutations (each turns a test red): a size / colour off the mockup; the
 * popup's buttons out of order; the brand mark missing; a dark token equal
 * to its light one.
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const popup = require("../../chrome-extension/popup.js") as Record<string, any>;

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const css = (file: string): string => {
  const html = fs.readFileSync(path.join(EXT, file), "utf8").replace(/\r\n/g, "\n");
  return /<style>([\s\S]*?)<\/style>/.exec(html)![1];
};

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): Record<string, string> {
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const sels = m[1].split(",").map((x) => x.trim());
    if (sels.includes(selector)) {
      const out: Record<string, string> = {};
      for (const d of m[2].split(";")) {
        const i = d.indexOf(":");
        if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      }
      return out;
    }
  }
  throw new Error("no rule " + selector);
}

/** The custom properties of the light :root, and of the dark one. */
function tokens(sheet: string): { light: Record<string, string>; dark: Record<string, string> } {
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = rule(flat, ":root");
  const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(flat)![1];
  const dark: Record<string, string> = {};
  for (const d of darkBlock.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) dark[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return { light, dark };
}
const resolve = (value: string, t: Record<string, string>): string => value.replace(/var\((--[a-z-]+)\)/g, (_m, name: string) => t[name]);

describe("the popup = the mockups (Popup*.dc.html)", () => {
  const sheet = css("popup.html");
  const t = tokens(sheet);

  // Founder G01: the popup fits its content — 320 wide, NO fixed height,
  // padding 16, gap 14; the status line is not stretched / centred.
  // Mutations: a fixed height back; the middle flex-grown → red.
  it("fits its content: 320 wide, no fixed height, padding 16, gap 14; a 36px brand mark and a 16px bold title", () => {
    const main = rule(sheet, "main");
    expect(main).toMatchObject({ width: "320px", padding: "16px", gap: "14px" });
    expect(main.height).toBeUndefined();
    expect(main["min-height"]).toBeUndefined();
    const middle = rule(sheet, ".middle");
    expect(middle["flex-grow"]).toBeUndefined();
    expect(middle["justify-content"]).toBeUndefined();
    expect(middle["align-items"]).toBe("flex-start");
    expect(rule(sheet, ".mark")).toMatchObject({ width: "36px", height: "36px" });
    expect(rule(sheet, ".title")).toMatchObject({ "font-size": "16px", "font-weight": "700" });
  });

  it("buttons: primary 48px / radius 10 / #4F46E5; secondary 44px outlined #CDD1DE; footer 12px", () => {
    const primary = rule(sheet, "button.primary");
    expect(primary).toMatchObject({ "min-height": "48px", "border-radius": "10px", "font-size": "15px", "font-weight": "700" });
    expect(resolve(primary.background, t.light)).toBe("#4F46E5");
    const secondary = rule(sheet, "button.secondary");
    expect(secondary).toMatchObject({ "min-height": "44px", "border-radius": "10px", "font-weight": "600" });
    expect(resolve(secondary.border, t.light)).toBe("1px solid #CDD1DE");
    expect(rule(sheet, ".foot")["font-size"]).toBe("12px");
  });

  it("the code: a #EEF0FF panel, 38px mono bold #312E81, radius 12", () => {
    const code = rule(sheet, ".code");
    expect(code).toMatchObject({ "font-size": "38px", "font-weight": "700", "border-radius": "12px", padding: "14px 0", "letter-spacing": "0.12em" });
    expect(resolve(code.background, t.light)).toBe("#EEF0FF");
    expect(resolve(code.color, t.light)).toBe("#312E81");
  });

  it("status colours: the pill #F1F2F5, linked #14532D, Keepr down #92400E", () => {
    expect(t.light["--pill-bg"]).toBe("#F1F2F5");
    expect(t.light["--ok-text"]).toBe("#14532D");
    expect(t.light["--warn-text"]).toBe("#92400E");
  });

  it("dark: derived, never the light colours (#202124 page, #6D5DF0 brand)", () => {
    expect(t.dark["--bg"]).toBe("#202124");
    expect(t.dark["--primary"]).toBe("#6D5DF0");
    for (const k of ["--bg", "--text", "--primary", "--code-bg", "--outline"]) expect(t.dark[k]).not.toBe(t.light[k]);
  });

  it("the order of each state: header, the middle, the buttons, the footer", () => {
    const draw = (view: Record<string, unknown>) => {
      const box = document.createElement("main");
      popup.renderPopup(document, box, view, { now: () => 0, link() {}, cancel() {}, openApp() {}, openKeepr() {}, openMessages() {}, unlink() {}, setConfirm() {}, confirmUnlink: false });
      return box;
    };
    const keys = (box: HTMLElement, sel: string) => Array.from(box.querySelectorAll(sel)).map((n) => n.getAttribute("data-keepr"));
    const notLinked = draw({ state: "not_linked", version: "0.3.41" });
    expect(Array.from(notLinked.children).map((c) => c.className)).toEqual(["head", "middle pill-gap", "actions", "foot"]);
    expect(notLinked.querySelector(".head img")!.getAttribute("src")).toBe("icons/keepr-mark.svg");
    expect(keys(notLinked, ".actions > *")).toEqual(["link", "open-messages"]);
    expect(notLinked.querySelector(".foot")!.textContent).toBe("Extension 0.3.41Help");
    const linked = draw({ state: "linked", email: "a***@example.test", version: "0.3.41" });
    expect(keys(linked, ".actions > *")).toEqual(["open-messages", "open-keepr"]);
    expect(linked.querySelector('[data-keepr="open-keepr"]')!.className).toBe("secondary");
    expect(linked.querySelector(".foot")!.textContent).toBe("UnlinkExtension 0.3.41");
    const linking = draw({ state: "linking", link: { code: "482913", expiresAt: 112_000 } });
    expect(linking.querySelector(".title")!.textContent).toBe("Link with Keepr");
    expect(linking.querySelector(".middle")!.textContent).toBe("Type this code in Keepr482 913Expires in 1:52");
    expect(keys(linking, ".actions > *")).toEqual(["open-app", "cancel"]);
    const down = draw({ state: "keepr_down", version: "0.3.41" });
    expect(down.querySelector(".status.warn")!.textContent).toBe("Keepr isn't running");
    expect(down.querySelector(".foot")!.textContent).toBe("Don't have Keepr?Extension 0.3.41");
  });
});

// Founder E01: an expired code shows "Code expired" + "Get a new code" —
// never the old digits (struck through or not). Mutations: the code drawn
// when expired; no Get a new code → red.
describe("the link window / popup: an expired code (E01)", () => {
  const draw = (view: Record<string, unknown>, now: number, calls: string[] = []) => {
    const box = document.createElement("main");
    popup.renderPopup(document, box, view, { now: () => now, link: () => calls.push("link"), cancel() {}, openApp() {}, openKeepr() {}, openMessages() {}, unlink() {}, setConfirm() {}, confirmUnlink: false });
    return box;
  };
  it("the countdown ran out: no 6-digit code; Code expired + Get a new code", () => {
    const calls: string[] = [];
    const box = draw({ state: "linking", link: { status: "waiting", code: "482913", expiresAt: 1_000 } }, 1_000, calls);
    expect(/\d{3}\s?\d{3}/.test(box.textContent || "")).toBe(false);
    expect(box.querySelector('[data-keepr="code"]')).toBeNull();
    expect(box.querySelector('[data-keepr="expired"]')!.textContent).toBe("Code expired");
    expect(box.querySelector(".title")!.textContent).toBe("Link with Keepr");
    const again = box.querySelector('[data-keepr="new-code"]') as HTMLButtonElement;
    expect(again.textContent).toBe("Get a new code");
    expect(again.className).toBe("primary");
    again.click();
    expect(calls).toEqual(["link"]);
  });
  it("the worker said expired: the same, and no code", () => {
    const box = draw({ state: "not_linked", link: { status: "failed", expired: true, error: "That code expired. Click Link for a new one." } }, 0);
    expect(box.querySelector('[data-keepr="expired"]')!.textContent).toBe("Code expired");
    expect(/\d{3}\s?\d{3}/.test(box.textContent || "")).toBe(false);
    expect(box.textContent).not.toContain("Not linked");
  });
  it("link.html is the popup page (same styles) with data-autolink", () => {
    const p = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
    const l = fs.readFileSync(path.join(EXT, "link.html"), "utf8");
    expect(l).toBe(p.replace('<main id="keepr-popup" aria-live="polite"></main>', '<main id="keepr-popup" data-autolink="1" aria-live="polite"></main>').replace("<title>Keepr</title>", "<title>Link with Keepr</title>"));
  });
});

describe("the welcome page = the mockup (Welcome.dc.html)", () => {
  const sheet = css("welcome.html");
  const t = tokens(sheet);
  const html = fs.readFileSync(path.join(EXT, "welcome.html"), "utf8");

  it("padding 48, gap 22; a 40px mark; 24px title; 28px step circles on #EEF0FF; a 48px button", () => {
    expect(rule(sheet, "main")).toMatchObject({ padding: "48px", gap: "22px" });
    expect(rule(sheet, ".mark")).toMatchObject({ width: "40px", height: "40px" });
    expect(rule(sheet, "h1")).toMatchObject({ "font-size": "24px", "line-height": "30px", "font-weight": "700" });
    const num = rule(sheet, ".num");
    expect(num).toMatchObject({ width: "28px", height: "28px" });
    expect(resolve(num.background, t.light)).toBe("#EEF0FF");
    expect(rule(sheet, "button.primary")).toMatchObject({ "min-height": "48px", padding: "0 24px", "border-radius": "10px" });
    expect(html).toContain("Keepr for Google Messages is installed");
    expect(html).toContain("<b>Pin Keepr</b> (puzzle icon, then the pin)");
    expect(html).toContain("Texts go only to Keepr on this computer, encrypted.");
  });
});

describe("the page box = the mockups (Box*.dc.html)", () => {
  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const render = (text: string, isError: boolean, extras: Record<string, unknown> | undefined, io: Record<string, unknown>) => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    job.renderOverlay(box, text, isError, extras, { copy: async () => true, ...io });
    return box;
  };
  const q = (box: HTMLElement, key: string) => box.querySelector(`[data-keepr="${key}"]`) as HTMLElement;

  it("syncing: a 320 card, padding 16, radius 16, a 6px bar, a 36px Stop sync at the right", () => {
    const box = render("x", false, { cancel: true, run: { phase: "reading", index: 12, total: 180, done: 11 } }, { theme: "light" });
    expect(box.style).toMatchObject({ width: "320px", padding: "16px", borderRadius: "16px", gap: "12px" });
    expect(box.style.border.toLowerCase()).toBe("1px solid #d6d9e4");
    expect(q(box, "progress-bar").style.height).toBe("6px");
    expect(q(box, "progress-fill").style.background).toBe(rgb("#4F46E5"));
    expect(q(box, "progress").textContent).toBe("Reading chat 12 of 180");
    // B03: the amber warning under the line.
    expect(q(box, "dont-click").textContent).toBe("Don't click in this tab. Use another Chrome window.");
    expect(q(box, "dont-click").style.color).toBe(rgb("#92400E"));
    const stop = q(box, "cancel");
    expect(stop.style).toMatchObject({ minHeight: "36px", padding: "0px 14px", borderRadius: "8px", alignSelf: "flex-end" });
    expect(q(box, "drag-handle").querySelector('[data-keepr="brand-mark"]')).not.toBeNull();
  });

  it("dark syncing: #2D2E31 card, #44464C border, #8B80F5 bar", () => {
    const box = render("x", false, { cancel: true, run: { phase: "reading", index: 12, total: 180, done: 11 } }, { theme: "dark" });
    expect(box.style.background).toBe(rgb("#2D2E31"));
    expect(box.style.border.toLowerCase()).toBe("1px solid #44464c");
    expect(q(box, "progress-fill").style.background).toBe(rgb("#8B80F5"));
  });

  it("stop confirm: Keep syncing (outlined) then Stop sync (#B42318) at the right", () => {
    const box = render("Chat 12 of 180…", false, { cancel: true }, { expanded: true, theme: "light", stop: { state: "open", openedAt: 0 } });
    const row = q(box, "stop-confirm").querySelector('[data-keepr="bottom-row"]') as HTMLElement;
    expect(Array.from(row.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["stop-no", "stop-yes"]);
    expect(row.style.justifyContent).toBe("flex-end");
    expect(q(box, "stop-yes").style.background).toBe(rgb("#B42318"));
    expect(q(box, "line").textContent).toBe("Stop the sync?");
  });

  it("done: a green ✓ badge, 'Sync done', See details left, Open Keepr bottom-right", () => {
    const box = render(job.DONE_LINE, false, { details: "d", summary: "13 chats · 323 messages", copy: "c" }, { theme: "light" });
    expect(q(box, "drag-handle").style.background).toBe(rgb("#15803D"));
    expect(q(box, "drag-handle").textContent).toBe("✓");
    expect(box.style.border.toLowerCase()).toBe("1px solid #c7d2fe");
    const row = q(box, "bottom-row");
    expect(box.lastElementChild).toBe(row);
    expect(Array.from(row.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["details-toggle", "open-keepr"]);
    expect(q(box, "open-keepr").style).toMatchObject({ minHeight: "36px", borderRadius: "8px", fontWeight: "700" });
  });

  // SR U4: Done ALWAYS has See details (left) + Open Keepr (right), even
  // with no details (See details then shows the summary / copy).
  // Mutations: the row only with details → red; an empty card → red.
  it("done with no details: still See details + Open Keepr; See details shows the summary", () => {
    const copied: string[] = [];
    const box = render(job.DONE_LINE, false, { summary: "13 chats · 323 messages" }, {
      theme: "light",
      copy: async (t: string) => {
        copied.push(t);
        return true;
      },
    });
    expect(box.getAttribute("data-keepr-state")).toBe("done");
    const row = q(box, "bottom-row");
    expect(Array.from(row.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["details-toggle", "open-keepr"]);
    q(box, "details-toggle").click();
    expect(q(box, "details").textContent).toBe("13 chats · 323 messages");
    q(box, "copy").click();
    expect(copied).toEqual(["13 chats · 323 messages"]);
    const bare = render(job.DONE_LINE, false, undefined, { theme: "light" });
    expect(Array.from(q(bare, "bottom-row").children).map((c) => c.getAttribute("data-keepr"))).toEqual(["details-toggle", "open-keepr"]);
    expect(q(bare, "details").textContent).toBe("Sync done");
  });

  it("failed (H01): an amber ! badge, #FCD9A8 border, the reason, Try again at the right — no See details", () => {
    const box = render("Lost the connection to your phone.", true, { retry: true }, { theme: "light", retry: async () => true });
    expect(q(box, "drag-handle").style.background).toBe(rgb("#B45309"));
    expect(box.style.border.toLowerCase()).toBe("1px solid #fcd9a8");
    expect(q(box, "line").textContent).toBe("Sync failed");
    expect(q(box, "bottom-row").style.justifyContent).toBe("flex-end");
    expect(q(box, "bottom-row").lastElementChild!.getAttribute("data-keepr")).toBe("try-again");
  });

  it("idle: a 40×56 tab, rounded on the left only; its label 'Keepr · linked' on hover", () => {
    const box = render("", false, { idle: { linked: true } }, { theme: "light" });
    expect([box.style.width, box.style.height]).toEqual(["40px", "56px"]);
    expect(box.style.borderRadius.replace(/0px/g, "0")).toBe("12px 0 0 12px");
    const label = q(box, "tab-label");
    expect(label.textContent).toBe("Keepr · linked");
    expect(label.style.display).toBe("none");
    q(box, "drag-handle").dispatchEvent(new MouseEvent("mouseenter"));
    expect(label.style.display).toBe("block");
    expect(label.style.background).toBe(rgb("#1F2433"));
    const dark = render("", false, { idle: { linked: false } }, { theme: "dark" });
    expect(dark.style.background).toBe(rgb("#6D5DF0"));
    expect(q(dark, "tab-label").textContent).toBe("Keepr · not linked");
  });

  // The approved storyboards (2026-10-04). Mutations: H01 with See details;
  // H03 without "skipping saved chats"; H07 not "Sync stopped" + Close;
  // I01 not its own card; A10 not the storyboard line → red.
  it("H01: a failed Sync that can try again — no See details, even with details", () => {
    const box = render("Lost the connection to your phone.", true, { retry: true, details: "d", copy: "c" }, { theme: "light", retry: async () => true });
    expect(q(box, "details-toggle")).toBeNull();
    expect(q(box, "details-card")).toBeNull();
    expect(Array.from(q(box, "bottom-row").children).map((c) => c.getAttribute("data-keepr"))).toEqual(["try-again"]);
  });

  it("H03: a Try again run — 'Reading chat 9 of 20 · skipping saved chats'", () => {
    const run = { phase: "reading", index: 9, total: 20, done: 8 };
    const box = render("x", false, { cancel: true, retrying: true, run }, { theme: "light" });
    expect(q(box, "progress").textContent).toBe("Reading chat 9 of 20 · skipping saved chats");
    const normal = render("x", false, { cancel: true, run }, { theme: "light" });
    expect(q(normal, "progress").textContent).toBe("Reading chat 9 of 20");
  });

  // Founder (P01–P03): the card per phase, from the run's state — never from
  // text. Mutations: the bar parsed from text; the bar going back; finding /
  // saving determinate; an animation under reduced motion; the warning or
  // Stop sync missing in a phase → red.
  const phaseCard = (run: Record<string, unknown>, extras: Record<string, unknown> = {}) =>
    render("Loading history… 150 messages", false, { cancel: true, run, ...extras }, { theme: "light" });

  it("P01 finding: 'Finding your chats · N so far', an indeterminate bar", () => {
    const box = phaseCard({ phase: "finding", found: 34 });
    expect(q(box, "progress").textContent).toBe("Finding your chats · 34 so far");
    expect(q(box, "progress-bar").getAttribute("data-indeterminate")).toBe("1");
    expect(q(phaseCard({ phase: "finding", found: 0 }), "progress").textContent).toBe("Finding your chats");
  });

  it("P02 reading: 'Reading chat i of M', the bar = chats completed / M (not the text)", () => {
    const box = phaseCard({ phase: "reading", index: 4, total: 20, done: 4 });
    expect(q(box, "progress").textContent).toBe("Reading chat 4 of 20");
    expect(q(box, "progress-bar").getAttribute("data-indeterminate")).toBeNull();
    expect(q(box, "progress-fill").style.width).toBe("20%");
  });

  it("P03 saving: 'Saving to Keepr', an indeterminate bar", () => {
    const box = phaseCard({ phase: "saving", index: 20, total: 20, done: 20 });
    expect(q(box, "progress").textContent).toBe("Saving to Keepr");
    expect(q(box, "progress-bar").getAttribute("data-indeterminate")).toBe("1");
  });

  it("every phase: the title, the bar, ONE status line, the warning, Stop sync — nothing else", () => {
    for (const run of [{ phase: "finding", found: 3 }, { phase: "reading", index: 2, total: 5, done: 1 }, { phase: "saving", total: 5, done: 5 }]) {
      const box = phaseCard(run);
      expect(Array.from(box.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["header", "progress-bar", "progress", "dont-click", "cancel", "stop-confirm"]);
      expect(q(box, "progress").style.whiteSpace).toBe("nowrap");
      expect(q(box, "progress").textContent).toMatch(/^(Finding your chats( · \d+ so far)?|Reading chat \d+ of \d+( · skipping saved chats)?|Saving to Keepr)$/);
    }
  });

  it("reduced motion: the indeterminate bar is a static partial bar (no animation)", () => {
    const animate = jest.fn();
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const had = proto.animate;
    proto.animate = animate;
    const mm = window.matchMedia;
    try {
      window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q })) as unknown as typeof window.matchMedia;
      const still = phaseCard({ phase: "finding", found: 1 });
      expect(q(still, "progress-fill").getAttribute("data-motion")).toBe("reduced");
      expect(animate).not.toHaveBeenCalled();
      window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
      const moving = phaseCard({ phase: "finding", found: 1 });
      expect(q(moving, "progress-fill").getAttribute("data-motion")).toBe("moving");
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = mm;
      proto.animate = had;
    }
  });

  it("H07: 'Sync stopped', 'Nothing from this run was saved.', a grey K, Close at the right", () => {
    const close = jest.fn();
    const box = render(job.STOPPED_TITLE, false, { stopped: true }, { theme: "light", close });
    expect(box.getAttribute("data-keepr-state")).toBe("stopped");
    expect(q(box, "line").textContent).toBe("Sync stopped");
    expect(q(box, "progress").textContent).toBe("Nothing from this run was saved.");
    const badge = q(box, "drag-handle");
    expect(badge.textContent).toBe("K");
    expect(badge.style.background).toBe(rgb("#6B7280"));
    const row = q(box, "bottom-row");
    expect(row.style.justifyContent).toBe("flex-end");
    expect(row.textContent).toBe("Close");
    (row.firstElementChild as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("I01: 'Sign in to Google Messages' and its one line — no button", () => {
    const box = render(job.SIGN_IN_TITLE, false, { signIn: true, details: "d", copy: "c" }, { theme: "light" });
    expect(box.getAttribute("data-keepr-state")).toBe("sign_in");
    expect(q(box, "line").textContent).toBe("Sign in to Google Messages");
    expect(q(box, "progress").textContent).toBe("Sign in or scan the QR code, then Sync now in Keepr.");
    expect(q(box, "progress").querySelector("b")!.textContent).toBe("Sync now");
    expect(box.querySelectorAll("button")).toHaveLength(0);
    expect(box.style.border.toLowerCase()).toBe("1px solid #d6d9e4");
  });

  it("A10: the done line as Keepr saved it", () => {
    expect(job.cacheSummaryLine({ chats: 20, messages: 412, newMessages: 38, photos: 64 })).toBe("20 chats · 412 messages (38 new) · 64 photos");
    expect(job.cacheSummaryLine({ chats: 1, messages: 1, newMessages: 0 })).toBe("1 chat · 1 message (0 new)");
  });

  it("every card's shadow is the storyboards' 0 8px 24px rgba(31,36,51,0.18)", () => {
    const box = render("Chat 1 of 3…", false, { cancel: true }, { expanded: true, theme: "light" });
    expect(box.style.boxShadow).toBe("0 8px 24px rgba(31,36,51,0.18)");
  });

});
