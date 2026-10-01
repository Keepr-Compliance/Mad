/**
 * BACKLOG-3645 — a contact's name never hides a chat: the phone number is the
 * gate, a name only orders the queue.
 * BACKLOG-3641 — the founder's finished overlay: one line + Details + Copy;
 * the Copy text carries no name, number or message text.
 *
 * Live regression (Windows, 2026-09-30, restated with INVENTED names): the
 * Keepr contact "Test Contact Lee" and the phone's chat "Test Contact" never
 * became a candidate, so its number was never checked and Sync imported 0.
 *
 * Mutation controls (each turns at least one test red):
 *   P1 over-cap path always (no "check every chat")   → "under the cap: every chat"
 *   P2 queue not sorted by reason                     → "names first"
 *   P3 no shared-token (3+ letters) rule              → "over the cap: a shared word"
 *   P4 no accent folding                              → "over the cap: accents"
 *   P5 notChecked not sent / not in Details           → "the job reports what it did not check"
 *   P6 Copy uses real names                           → "Copy text: no names"
 *   P7 overlay renders more than its one line         → "one line + Details + Copy"
 *   P8 Details via innerHTML                          → "page text never becomes markup"
 */

interface Conv {
  conversationId: string;
  name: string;
  href: string;
}

interface Plan {
  queue: Array<{ conversation: Conv; reason: string }>;
  notChecked: number;
  checkAll: boolean;
}

interface ScanModule {
  CHECK_ALL_MAX: number;
  planChecks: (conversations: Conv[], contacts: Array<{ displayName: string }>, opts?: { checkAllMax?: number }) => Plan;
  [key: string]: unknown;
}

interface ApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

interface JobModule {
  DONE_LINE: string;
  runJob: (jobId: string, env: Record<string, unknown>) => Promise<{ outcome: string }>;
  renderOverlay: (
    panel: HTMLElement,
    text: string,
    isError: boolean,
    extras: { details: string; copy: string } | undefined,
    io: { copy: (text: string) => Promise<boolean> },
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

/** A list of `n` chats: the regression chat, a number-only chat, the rest invented names. */
function list(n: number, extra: Conv[] = []): Conv[] {
  const out: Conv[] = [conv(0, "Sample Person 0"), conv(1, "Test Contact"), conv(2, "(555) 555-0100")];
  for (let i = 3; i < n; i++) out.push(conv(i, `Sample Person ${i}`));
  return out.concat(extra);
}

const CONTACTS = [{ displayName: "Test Contact Lee" }];

describe("planChecks (BACKLOG-3645)", () => {
  it("the cap is a named constant of 50", () => {
    expect(scan.CHECK_ALL_MAX).toBe(50);
  });

  it("under the cap: every chat is checked — the 'Test Contact Lee' vs 'Test Contact' chat included (P1)", () => {
    const plan = scan.planChecks(list(19), CONTACTS);
    expect(plan.checkAll).toBe(true);
    expect(plan.notChecked).toBe(0);
    expect(plan.queue).toHaveLength(19);
    expect(plan.queue.map((q) => q.conversation.name)).toContain("Test Contact");
  });

  it("names first: exact, then loose, then number-only, then the rest, each in list order (P2)", () => {
    const chats = [
      conv(0, "Sample Person"),
      conv(1, "(555) 555-0100"),
      conv(2, "Test Contact Lee and 2 others"),
      conv(3, "Test Contact Lee"),
      conv(4, "Another Sample"),
    ];
    const plan = scan.planChecks(chats, CONTACTS);
    expect(plan.queue.map((q) => [q.conversation.name, q.reason])).toEqual([
      ["Test Contact Lee", "name"],
      ["Test Contact Lee and 2 others", "name_loose"],
      ["(555) 555-0100", "phone_name"],
      ["Sample Person", "unmatched_name"],
      ["Another Sample", "unmatched_name"],
    ]);
  });

  it("over the cap: the regression chat (shared first name) and number-only chats are checked; the rest are counted", () => {
    const plan = scan.planChecks(list(60), CONTACTS);
    expect(plan.checkAll).toBe(false);
    expect(plan.queue.map((q) => [q.conversation.name, q.reason])).toEqual([
      ["Test Contact", "name_token"],
      ["(555) 555-0100", "phone_name"],
    ]);
    expect(plan.notChecked).toBe(58);
  });

  it("over the cap: a shared word of 3+ letters that is not the first name still counts (P3)", () => {
    const plan = scan.planChecks(list(60, [conv(60, "Lee Household"), conv(61, "Al Sample")]), [{ displayName: "Test Contact Lee" }, { displayName: "Bo Al" }]);
    const names = plan.queue.map((q) => q.conversation.name);
    expect(names).toContain("Lee Household");
    // "al" is shorter than 3 letters and not the first name: no match.
    expect(names).not.toContain("Al Sample");
  });

  it("over the cap: case- and accent-insensitive (P4)", () => {
    const plan = scan.planChecks(list(60, [conv(60, "TÉST household")]), [{ displayName: "Test Contact Lee" }]);
    expect(plan.queue.map((q) => q.conversation.name)).toContain("TÉST household");
  });
});

/** A Sync over a stubbed page: every chat shows a number, none matches. */
function planJob(chats: Conv[], opts: { throwFor?: string; contactsWithoutPhone?: string[] } = {}) {
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
        return {
          ok: true,
          status: 200,
          body: { jobId: JOB, contacts: [{ contactId: "c-1", displayName: "Test Contact Lee" }], contactsWithoutPhone: opts.contactsWithoutPhone ?? [] },
        };
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
  it("over the cap: notChecked goes to /progress and /finish, and Details says it", async () => {
    const t = planJob(list(60));
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    const finish = t.calls.find(([, p]) => p.endsWith("/finish"))?.[2];
    expect(finish).toMatchObject({ notChecked: 58 });
    const progress = t.calls.filter(([, p]) => p.endsWith("/progress")).map(([, , b]) => b);
    expect(progress[0]).toMatchObject({ listed: 60, candidates: 2, notChecked: 58, stage: "Checking chat 1 of 2" });
    const last = t.shown[t.shown.length - 1];
    expect(last.text).toBe(job.DONE_LINE);
    expect(last.extras?.details).toContain("Scanned 60 chats · checked 2 · matched 0 · imported 0 messages");
    expect(last.extras?.details).toContain("Not checked: 58 chats (name didn't match a contact on this transaction)");
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
    const t = planJob(list(19), { throwFor: "Sample Person 5", contactsWithoutPhone: ["Sample Nophone"] });
    await job.runJob(JOB, t.env);
    const last = t.shown[t.shown.length - 1];
    const copy = last.extras?.copy ?? "";
    const details = last.extras?.details ?? "";
    // On screen: the real names.
    expect(details).toContain("Sample Person 5 (could not be opened)");
    expect(details).toContain("No phone number: Sample Nophone");
    // Copied: tags and reasons.
    expect(copy).toContain("Keepr Sync diagnostics");
    expect(copy).toContain("Scanned 19 chats · checked 18 · matched 0 · imported 0 messages");
    expect(copy).toMatch(/• #[0-9a-f]{6} \(could not be opened\)/);
    expect(copy).toMatch(/No phone number: #[0-9a-f]{6}/);
    expect(copy).toContain("--- step log ---");
    for (const forbidden of ["Sample", "Nophone", "Test Contact", "555", "0199", "0100"]) {
      expect([forbidden, copy.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });
});

describe("the overlay panel (BACKLOG-3641 founder UX)", () => {
  function panel(): HTMLElement {
    document.body.innerHTML = "<div id='p'></div>";
    return document.getElementById("p") as HTMLElement;
  }

  it("one line + Details + Copy; Details opens the text, Copy copies the Copy text (P7)", async () => {
    const el = panel();
    const copied: string[] = [];
    job.renderOverlay(el, job.DONE_LINE, false, { details: "Scanned 3 chats", copy: "COPY TEXT" }, {
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    expect(el.querySelector("[data-keepr=line]")?.textContent).toBe("Keepr: Sync done — switch back to Keepr.");
    const details = el.querySelector("[data-keepr=details]") as HTMLElement;
    expect(details.style.display).toBe("none");
    (el.querySelector("[data-keepr=details-toggle]") as HTMLElement).click();
    expect(details.style.display).toBe("block");
    expect(details.textContent).toBe("Scanned 3 chats");
    (el.querySelector("[data-keepr=copy]") as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual(["COPY TEXT"]);
    expect(el.querySelector("[data-keepr=copy]")?.textContent).toBe("Copied");
    // A progress line replaces everything: no stale buttons.
    job.renderOverlay(el, "Checking chat 2 of 9", false, undefined, { copy: async () => true });
    expect(el.children).toHaveLength(1);
    expect(el.textContent).toBe("Keepr: Checking chat 2 of 9");
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
