/**
 * BACKLOG-3664 — an AI assistant chat (Gemini) in the conversation list.
 *
 * It has no phone number and its conversation menu behaves differently. A
 * Sync used to hang on it and then report it as "failed". Now:
 *   - a greyed-out (disabled / aria-disabled) menu or Details button → "not a
 *     text conversation" at once: counted quietly, never a failure, never in
 *     "Not fully imported" (transaction AND cache Syncs);
 *   - no menu, a menu without Details, or Details without participants →
 *     no_numbers, after closing what was opened, within a bounded wait;
 *   - only a Details panel that will not close still stops the read.
 *
 * Mutations that turn this suite red:
 *   G1 a disabled Details button treated as failed/clicked → "a greyed-out Details item"
 *   G1b the disabled conversation menu ignored             → "a greyed-out conversation menu"
 *   G2 a missing menu throws again                         → "no conversation menu"
 *   G3 nothing closed after a missing Details item         → "a menu without Details"
 *   G5 not_text counted as checked / reported as no_numbers → the job tests
 *   G6 notText not sent to Keepr                            → "Keepr hears the count"
 */

export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const scan = require("../../chrome-extension/scan.js") as Record<string, any>;
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row

jest.setTimeout(10_000);

let sleeps = 0;
const countingSleep = async (): Promise<void> => {
  sleeps += 1;
  if (sleeps > 5_000) throw new Error("test harness: runaway wait");
};
beforeEach(() => {
  sleeps = 0;
});

/** A chat header with a menu (maybe disabled) that opens a menu with or without a (maybe disabled) Details item. */
function mountChat(opts: {
  menu: boolean;
  menuDisabled?: "disabled" | "aria";
  details?: boolean;
  detailsDisabled?: "disabled" | "aria";
  participants?: boolean;
}) {
  const dis = (how?: "disabled" | "aria") => (how === "disabled" ? " disabled" : how === "aria" ? ' aria-disabled="true"' : "");
  document.body.innerHTML =
    `<mws-header><h2 data-e2e-header-title>Test Chat</h2>` +
    (opts.menu ? `<button data-e2e-conversation-menu-button${dis(opts.menuDisabled)}>⋮</button>` : "") +
    `</mws-header><div id="overlay-container"></div>`;
  const clicks: string[] = [];
  const click = (el: Element): void => {
    if (el.matches("[data-e2e-conversation-menu-button]")) {
      clicks.push("menu");
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="menu" id="menu">${opts.details ? `<button data-e2e-details-button${dis(opts.detailsDisabled)}>Details</button>` : "<button>Other</button>"}</div>`,
      );
    } else if (el.matches("[data-e2e-details-button]")) {
      clicks.push("details");
      document.getElementById("menu")?.remove();
      document.getElementById("overlay-container")!.innerHTML =
        (opts.participants
          ? `<li data-e2e-details-participant><h3 data-e2e-details-participant-name>Test Contact A</h3><span data-e2e-details-participant-number>(555) 555-0199</span></li>`
          : "<p>No people</p>") + `<button aria-label="Done">Done</button>`;
    } else if (el.matches('button[aria-label="Done"]')) {
      clicks.push("done");
      document.getElementById("overlay-container")!.innerHTML = "";
    }
  };
  const escape = (): void => {
    clicks.push("escape");
    document.getElementById("menu")?.remove();
  };
  return { clicks, click, escape };
}

describe("readParticipantsAndClose: AI chats and unreadable Details", () => {
  it.each(["disabled", "aria"] as const)(
    "a greyed-out (%s) Details item: not_text at once, menu closed, Details never clicked (G1)",
    async (how) => {
      const page = mountChat({ menu: true, details: true, detailsDisabled: how, participants: true });
      const out = await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep, escape: page.escape });
      expect(Array.from(out)).toEqual([]);
      expect(out.kind).toBe("not_text");
      expect(page.clicks).toEqual(["menu", "escape"]);
      expect(sleeps).toBe(0);
    },
  );

  it.each(["disabled", "aria"] as const)("a greyed-out (%s) conversation menu: not_text, nothing clicked, no wait", async (how) => {
    const page = mountChat({ menu: true, menuDisabled: how });
    const out = await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep, escape: page.escape });
    expect(out.kind).toBe("not_text");
    expect(page.clicks).toEqual([]);
    expect(sleeps).toBe(0);
  });

  it("no conversation menu: no_details after a bounded wait (G2)", async () => {
    const page = mountChat({ menu: false });
    const out = await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep, timeoutMs: 1000 });
    expect(out.kind).toBe("no_details");
    expect(sleeps).toBeLessThanOrEqual(11);
  });

  it("a menu without Details: no_details, and the menu is closed with Escape (G3)", async () => {
    const page = mountChat({ menu: true, details: false });
    const out = await scan.readParticipantsAndClose(document, {
      click: page.click, sleep: countingSleep, escape: page.escape, timeoutMs: 1000,
    });
    expect(out.kind).toBe("no_details");
    expect(page.clicks).toEqual(["menu", "escape"]);
    expect(document.getElementById("menu")).toBeNull();
  });

  it("Details without participant rows: no_details, closed with Done", async () => {
    const page = mountChat({ menu: true, details: true, participants: false });
    const out = await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep, timeoutMs: 1000 });
    expect(out.kind).toBe("no_details");
    expect(page.clicks).toEqual(["menu", "details", "done"]);
  });

  it("Details without rows whose Done does nothing: Escape after the wait", async () => {
    const page = mountChat({ menu: true, details: true, participants: false });
    const click = (el: Element): void => {
      if (el.matches('button[aria-label="Done"]')) {
        page.clicks.push("done (ignored)");
        return;
      }
      page.click(el);
    };
    const out = await scan.readParticipantsAndClose(document, { click, sleep: countingSleep, escape: page.escape, timeoutMs: 500 });
    expect(out.kind).toBe("no_details");
    expect(page.clicks).toEqual(["menu", "details", "done (ignored)", "escape"]);
  });

  it("an ordinary chat still reads its number (no kind)", async () => {
    const page = mountChat({ menu: true, details: true, participants: true });
    const out = await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep });
    expect(Array.from(out)).toEqual(["(555) 555-0199"]);
    expect(out.kind).toBeUndefined();
  });

  it("the default Escape is a real keydown on the page", async () => {
    const page = mountChat({ menu: true, details: false });
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));
    await scan.readParticipantsAndClose(document, { click: page.click, sleep: countingSleep, timeoutMs: 500 });
    expect(keys).toEqual(["Escape"]);
  });
});

function renderList(names: string[]): void {
  document.body.innerHTML =
    "<mws-conversations-list>" +
    names
      .map((n, i) =>
        `<mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/${"c".repeat(18)}${i}">` +
        `<span data-e2e-conversation-name>${n}</span></a></mws-conversation-list-item>`,
      )
      .join("") +
    "</mws-conversations-list>";
}

/** A job over three chats: an ordinary one, Gemini (not_text), one whose Details won't open. */
function runWith(kind: "transaction" | "cache") {
  renderList(["Test Contact A", "Gemini", "Test Contact B"]);
  let open = "";
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const read: Record<string, () => string[]> = {
    "Test Contact A": () => ["(555) 555-0199"],
    Gemini: () => {
      const none: string[] = [];
      Object.defineProperty(none, "kind", { value: "not_text" });
      return none;
    },
    "Test Contact B": () => {
      const none: string[] = [];
      Object.defineProperty(none, "kind", { value: "no_details" });
      return none;
    },
  };
  const env = {
    doc: document,
    getLocation: () => ({ pathname: `/web/conversations/${open}`, href: `https://messages.google.com/web/conversations/${open}` }),
    api: async (_m: string, p: string, body?: Record<string, unknown>) => {
      calls.push([p, body]);
      if (p.endsWith("/claim")) {
        return kind === "cache"
          ? { ok: true, status: 200, body: { kind: "cache", contacts: [], since: "2026-08-01T00:00:00.000Z" } }
          : { ok: true, status: 200, body: { contacts: [{ contactId: "c-1", displayName: "Test Contact A" }] } };
      }
      if (p.endsWith("/match")) return { ok: true, status: 200, body: { matched: false } };
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: { show: () => {} },
    sleep: async () => {},
    click: () => {},
    openConversation: async (c: { name: string }) => {
      open = c.name;
    },
    returnToList: async () => true,
    readImage: async () => null,
    extract: () => ({ messages: [] }),
    scan: {
      ...scan,
      readParticipantsAndClose: async () => read[open](),
      waitForMessageSwap: async () => true,
      messageIdSet: () => "",
    },
  };
  return { env, calls };
}

describe.each(["transaction", "cache"] as const)("a %s Sync over a list with an AI chat (G5, G6)", (kind) => {
  it("Gemini is skipped as not a text conversation; a Details that won't open is no_numbers", async () => {
    const t = runWith(kind);
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(outcome.notReached).toEqual([{ name: "Test Contact B", reason: "no_numbers" }]);
    expect(outcome.totals.notText).toBe(1);
    expect(outcome.progress.checked).toBe(2);
    expect(t.calls.filter(([p]) => p.endsWith("/match")).map(([, b]) => b?.numbers)).toEqual([["(555) 555-0199"]]);
  });

  it("Keepr hears the count with /finish", async () => {
    const t = runWith(kind);
    await job.runJob(JOB, t.env);
    const finish = t.calls.find(([p]) => p.endsWith("/finish"));
    expect(finish?.[1]).toMatchObject({ notText: 1 });
  });
});

// BACKLOG-3664 (founder retest): an EMPTY chat (e.g. a new group with no
// messages) is "no messages yet" — counted quietly, never "not fully
// imported" — while the earlier chat's messages still on screen remain a
// real load failure. Mutations: E1 empty treated as a failure; E2 a stale
// screen treated as empty; E3 the job reports an empty chat as left out.
describe("an empty chat vs a load failure", () => {
  const wrap = (id: string) => `<mws-message-wrapper msg-id="${id}"></mws-message-wrapper>`;

  it("no message on screen after the wait and a further confirm: 'empty' (E1)", async () => {
    document.body.innerHTML = "<div id='chat'></div>";
    const out = await scan.waitForMessageSwap(document, "m-old", {
      sleep: countingSleep, timeoutMs: 300, stableMs: 100, reportEmpty: true, emptyConfirmMs: 300,
    });
    expect(out).toBe("empty");
  });

  it("the earlier chat's messages still on screen: false, a real failure (E2)", async () => {
    document.body.innerHTML = `<div id='chat'>${wrap("m-old")}</div>`;
    const out = await scan.waitForMessageSwap(document, "m-old", {
      sleep: countingSleep, timeoutMs: 300, stableMs: 100, reportEmpty: true, emptyConfirmMs: 300,
    });
    expect(out).toBe(false);
  });

  it("messages that arrive during the confirm wait: ready after all", async () => {
    document.body.innerHTML = "<div id='chat'></div>";
    let n = 0;
    const sleep = async (): Promise<void> => {
      n += 1;
      if (n === 5) document.getElementById("chat")!.innerHTML = wrap("m-new");
    };
    const out = await scan.waitForMessageSwap(document, "m-old", {
      sleep, timeoutMs: 300, stableMs: 100, reportEmpty: true, emptyConfirmMs: 1000,
    });
    expect(out).toBe(true);
  });

  it("without reportEmpty an empty screen is still false (callers unchanged)", async () => {
    document.body.innerHTML = "<div id='chat'></div>";
    expect(await scan.waitForMessageSwap(document, "m-old", { sleep: countingSleep, timeoutMs: 300, stableMs: 100 })).toBe(false);
  });

  it.each(["transaction", "cache"] as const)("a %s Sync counts it as 'no messages yet', never left out (E3)", async (kind) => {
    const t = runWith(kind);
    const orig = t.env.api;
    t.env.api = async (m: string, p: string, b?: Record<string, unknown>) =>
      p.endsWith("/match") ? { ok: true, status: 200, body: { matched: true } } : orig(m, p, b);
    t.env.scan.waitForMessageSwap = (async () => "empty") as never;
    const outcome = await job.runJob(JOB, t.env);
    expect(outcome.outcome).toBe("finished");
    expect(outcome.totals.noMessagesYet).toBe(1);
    expect(outcome.notReached).toEqual([{ name: "Test Contact B", reason: "no_numbers" }]);
    expect(t.calls.some(([p]) => p.endsWith("/chat"))).toBe(false);
  });
});
