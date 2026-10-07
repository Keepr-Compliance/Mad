/**
 * The job's reporting over a stubbed page (cache Syncs — the only kind since
 * 2026-10-05; the per-transaction name planning, planChecks, was removed with
 * the per-transaction Sync):
 * BACKLOG-3641 — the founder's finished overlay: one line + Details + Copy;
 * the Copy text carries no name, number or message text.
 *
 * Mutation controls (each turns at least one test red):
 *   P5 notChecked not sent / not in Details           → "the job reports what it did not check"
 *   P6 Copy uses real names                           → "Copy text: no names"
 *   P7 overlay renders more than its one line         → "one line + Details + Copy"
 *   P8 Details via innerHTML                          → "page text never becomes markup"
 *   P9 a non-cache (older Keepr) claim run            → "an older Keepr's claim"
 */

interface Conv {
  conversationId: string;
  name: string;
  href: string;
}

interface ScanModule {
  [key: string]: unknown;
}

interface ApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

interface JobModule {
  DONE_LINE: string;
  CACHE_CHECK_MAX: number;
  runJob: (jobId: string, env: Record<string, unknown>) => Promise<{ outcome: string }>;
  renderOverlay: (
    panel: HTMLElement,
    text: string,
    isError: boolean,
    extras: { details?: string; copy?: string; summary?: string; run?: Record<string, unknown> } | undefined,
    io: { copy: (text: string) => Promise<boolean>; focus?: () => Promise<boolean> },
  ) => void;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as ScanModule;
const job = require("../../chrome-extension/job.js") as JobModule;
/* eslint-enable @typescript-eslint/no-require-imports */

const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row

function conv(i: number, name: string): Conv {
  const id = `conv${String(i).padStart(15, "0")}`;
  return { conversationId: id, name, href: `/web/conversations/${id}` };
}

/** A list of `n` chats (invented names; one number-only). */
function list(n: number, extra: Conv[] = []): Conv[] {
  const out: Conv[] = [conv(0, "Sample Person 0"), conv(1, "Test Contact"), conv(2, "(555) 555-0100")];
  for (let i = 3; i < n; i++) out.push(conv(i, `Sample Person ${i}`));
  return out.concat(extra);
}

/** A Sync over a stubbed page: every chat shows a number, none matches. */
function planJob(chats: Conv[], opts: { throwFor?: string; claimBody?: Record<string, unknown> } = {}) {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const shown: Array<{ text: string; extras?: { details: string; copy: string } }> = [];
  document.body.innerHTML = "<mws-conversation-list-item></mws-conversation-list-item>";
  let open = "";
  const env = {
    doc: document,
    getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
    api: async (method: string, p: string, body?: Record<string, unknown>): Promise<ApiReply> => {
      calls.push([method, p, body]);
      if (p.endsWith("/claim")) {
        return { ok: true, status: 200, body: opts.claimBody ?? { jobId: JOB, kind: "cache", since: "2026-01-01T00:00:00.000Z" } };
      }
      if (p.endsWith("/match")) return { ok: true, status: 200, body: { matched: false, contactIds: [] } };
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: {
      show: (text: string, _isError?: boolean, extras?: { details: string; copy: string }) => shown.push({ text, extras }),
    },
    log: () => {},
    salt: "fixed",
    sleep: () => Promise.resolve(),
    click: () => {},
    scroll: () => {},
    openConversation: async (c: Conv) => {
      if (c.name === opts.throwFor) throw new Error("Timed out waiting for the chat to open");
      open = c.conversationId;
    },
    returnToList: async () => true,
    readImage: async () => null,
    extract: () => ({ title: "x", messages: [] }),
    scan: {
      ...scan,
      collectConversations: async () => ({ conversations: chats, stopReason: "stable", scroll: null }),
      readParticipantsAndClose: async () => ["(555) 555-0199"],
      messageIdSet: () => "",
    },
  };
  return { env, calls, shown };
}

describe("the job reports what it did not check (P5)", () => {
  it("over the cache cap: notChecked goes to /progress and /finish, and Details says it", async () => {
    const n = job.CACHE_CHECK_MAX + 5;
    const t = planJob(list(n));
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(t.calls.filter(([, p]) => p.endsWith("/match"))).toHaveLength(job.CACHE_CHECK_MAX);
    const finish = t.calls.find(([, p]) => p.endsWith("/finish"))?.[2];
    expect(finish).toMatchObject({ notChecked: 5 });
    const progress = t.calls.filter(([, p]) => p.endsWith("/progress")).map(([, , b]) => b);
    expect(progress[0]).toMatchObject({ listed: n, candidates: job.CACHE_CHECK_MAX, notChecked: 5, stage: `Reading chat 1 of ${job.CACHE_CHECK_MAX}` });
    const last = t.shown[t.shown.length - 1];
    expect(last.text).toBe(job.DONE_LINE);
    expect(last.extras?.details).toContain(`Scanned ${n} chats`);
    expect(last.extras?.details).toContain("Not checked: 5 chats (over this Sync's limit)");
  });

  it("under the cap: every chat is checked and nothing is 'not checked'", async () => {
    const t = planJob(list(19));
    await job.runJob(JOB, t.env);
    expect(t.calls.filter(([, p]) => p.endsWith("/match"))).toHaveLength(19);
    expect(t.calls.find(([, p]) => p.endsWith("/finish"))?.[2]).toMatchObject({ notChecked: 0 });
    expect(t.shown[t.shown.length - 1].extras?.details).not.toContain("Not checked");
  });
});

describe("Copy text (BACKLOG-3641, SR ruling 2)", () => {
  it("Copy text: no names, no numbers, no message text — salted tags, reasons and counts only (P6)", async () => {
    const t = planJob(list(19), { throwFor: "Sample Person 5" });
    await job.runJob(JOB, t.env);
    const last = t.shown[t.shown.length - 1];
    const copy = last.extras?.copy ?? "";
    const details = last.extras?.details ?? "";
    // On screen: the real names.
    expect(details).toContain("Sample Person 5 (could not be opened)");
    // Copied: tags, reasons and counts.
    expect(copy).toContain("Keepr Sync diagnostics");
    expect(copy).toContain("Scanned 19 chats");
    expect(copy).toContain("Checked 18 · matched 0 · sent 0 chats / 0 messages / 0 reactions");
    expect(copy).toMatch(/• #[0-9a-f]{6} \(could not be opened\)/);
    expect(copy).toContain("--- step log ---");
    for (const forbidden of ["Sample", "Test Contact", "555", "0199", "0100"]) {
      expect([forbidden, copy.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });
});

// Founder (2026-10-05): the per-transaction Sync is gone. A claim that is not
// a cache Sync (an older Keepr) is refused with its line — never run, and no
// contact name it carries reaches the page. Mutation: run it anyway → red.
describe("an older Keepr's claim (P9)", () => {
  it("a non-cache claim: 'claim refused' with 'Update Keepr', nothing checked, no name on the page", async () => {
    const t = planJob(list(5), {
      claimBody: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Sample Nophone" }], contactsWithoutPhone: ["Sample Nophone"] },
    });
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("claim_refused");
    expect(t.calls.filter(([, p]) => p.endsWith("/match"))).toHaveLength(0);
    const last = t.shown[t.shown.length - 1];
    expect(last.text).toBe("Keepr couldn't start this Sync.");
    expect(last.extras?.details).toContain("Update Keepr, then Sync again.");
    expect(JSON.stringify(t.shown)).not.toContain("Nophone");
  });
});

describe("the overlay panel (BACKLOG-3641 founder UX)", () => {
  function panel(): HTMLElement {
    document.body.innerHTML = "<div id='p'></div>";
    return document.getElementById("p") as HTMLElement;
  }

  // The approved mockup (BoxDone, 2026-10-03): "Sync done", the counts, then
  // the row — "See details" left, Open Keepr at the box's BOTTOM-RIGHT (the
  // details card opens above the row). Mutations: the card below the row (or
  // the row order swapped); the link text not switching; Copy details outside
  // the card; Open Keepr not asking Keepr to come forward.
  it("'Sync done' + the counts; bottom row = 'See details' left, 'Open Keepr' bottom-right; the card opens ABOVE the row (P7)", async () => {
    const el = panel();
    const copied: string[] = [];
    let focused = 0;
    job.renderOverlay(el, job.DONE_LINE, false, { details: "Scanned 3 chats", summary: "Scanned 3 chats", copy: "COPY TEXT" }, {
      copy: async (text) => {
        copied.push(text);
        return true;
      },
      focus: async () => {
        focused += 1;
        return true;
      },
    });
    const kids = Array.from(el.children).map((c) => c.getAttribute("data-keepr"));
    expect(kids).toEqual(["header", "progress", "details-card", "bottom-row"]);
    expect(el.querySelector("[data-keepr=line]")?.textContent).toBe("Sync done");
    expect(el.querySelector("[data-keepr=progress]")?.textContent).toBe("Scanned 3 chats");
    const row = el.querySelector("[data-keepr=bottom-row]") as HTMLElement;
    expect(Array.from(row.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["details-toggle", "open-keepr"]);
    expect(row.style.justifyContent).toBe("space-between");
    const toggle = el.querySelector("[data-keepr=details-toggle]") as HTMLElement;
    const card = el.querySelector("[data-keepr=details-card]") as HTMLElement;
    expect(toggle.textContent).toBe("See details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.style.display).toBe("none");
    expect(card.querySelector("[data-keepr=copy]")?.textContent).toBe("Copy details");

    toggle.click();
    expect(card.style.display).toBe("block");
    expect(toggle.textContent).toBe("Hide details");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector("[data-keepr=details]")?.textContent).toBe("Scanned 3 chats");

    (card.querySelector("[data-keepr=copy]") as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual(["COPY TEXT"]);
    expect(card.querySelector("[data-keepr=copy]")?.textContent).toBe("Copied");

    (el.querySelector("[data-keepr=open-keepr]") as HTMLElement).click();
    expect(focused).toBe(1);

    toggle.click();
    expect(card.style.display).toBe("none");
    expect(toggle.textContent).toBe("See details");

    // A progress line replaces everything: the syncing card, no stale buttons.
    job.renderOverlay(el, "Reading chat 2 of 9", false, { run: { phase: "reading", index: 2, total: 9, done: 1 } }, { copy: async () => true });
    expect(el.querySelector("[data-keepr=line]")?.textContent).toBe("Syncing your texts");
    expect(el.querySelector("[data-keepr=progress]")?.textContent).toBe("Reading chat 2 of 9");
    expect(el.querySelector("[data-keepr=open-keepr]")).toBeNull();
    expect(el.querySelector("[data-keepr=details-card]")).toBeNull();
  });

  it("a failure: 'Sync failed', the reason on one line, the same bottom row (BoxCancelled)", () => {
    const el = panel();
    job.renderOverlay(el, "Sign in to Google Messages, then click Sync in Keepr again", true, { details: "d", copy: "c" }, {
      copy: async () => true,
      focus: async () => true,
    });
    expect(Array.from(el.children).map((c) => c.getAttribute("data-keepr"))).toEqual(["header", "progress", "details-card", "bottom-row"]);
    expect(el.querySelector("[data-keepr=line]")?.textContent).toBe("Sync failed");
    expect(el.querySelector("[data-keepr=progress]")?.textContent).toBe("Sign in to Google Messages, then click Sync in Keepr again");
  });

  // Live (founder): a refused /focus falls back to keepr://open (the page's
  // focusKeepr) — the button never sends the user to the taskbar.
  it("Open Keepr that Keepr could not honour keeps its words", async () => {
    const el = panel();
    job.renderOverlay(el, job.DONE_LINE, false, { details: "d", copy: "c" }, { copy: async () => true, focus: async () => false });
    (el.querySelector("[data-keepr=open-keepr]") as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.querySelector("[data-keepr=open-keepr]")?.textContent).toBe("Open Keepr");
  });

  it("page text never becomes markup (P8)", () => {
    const el = panel();
    const hostile = "<img src=x onerror=alert(1)><b>bold</b>";
    job.renderOverlay(el, hostile, true, { details: hostile, copy: hostile }, { copy: async () => true });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("[data-keepr=details]")?.textContent).toBe(hostile);
  });
});
