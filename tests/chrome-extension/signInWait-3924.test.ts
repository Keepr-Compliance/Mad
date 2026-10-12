/**
 * BACKLOG-3924 — the page waits for the user to sign in to Google Messages,
 * then starts the Sync by itself (founder, 2026-10-12; reverses the
 * 2026-09-29 "no waiting, no auto-resume" ruling for this case only).
 *
 * Runs chrome-extension/job.js and scan.js (the files the content script
 * loads). Keepr's replies are transcribed from the bridge:
 *   /waiting 200 {ok, waitLeftMs}        rcsExtensionBridge.ts handleJob "waiting"
 *   older Keepr: 404 {error:"not_found"} rcsExtensionBridge.ts (JOB_ROUTE miss → the router's last line)
 *   Stop in Keepr: 410 {error:"job_over"} RcsJobRegistry.check()
 *   /claim 200 {jobId, kind:"cache", …}   RcsImportJob.claim()
 * The sign-in paths and markers are the ones observed live 2026-09-29
 * (BACKLOG-3620): /web/welcome (mw-welcome-page-container, the
 * data-e2e-welcome-page-sign-in-button), /web/authentication (QR pairing).
 *
 * Controls (each mutation run before it was written down):
 *   C5  welcome → authentication → conversations + list: claims once, no /error  (mutation: /error at once)
 *   C6  the list 3 s after the path: no claim before the list            (mutation: claim on the path alone)
 *   C7  the start button: signed out → S5, no claim; signed in → claim   (mutation: claim on the click)
 *   C8  the tab's copy of the job goes only after a successful claim     (mutation: cleared at start())
 *   C9  an older Keepr (404 not_found) → one /error not_signed_in, today's card (mutation: no fallback)
 *   C10 Stop in Keepr (410) during the wait → no claim, the cancelled card (mutation: 410 ignored)
 *   C11 pagehide while waiting → /waiting, never /error page_gone        (mutation: the waiting check out of pagehide)
 */

import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const scan = require("../../chrome-extension/scan.js") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/* eslint-enable @typescript-eslint/no-require-imports */

const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const DAY = 864e5;
const WELCOME = "<mw-welcome-page-container><button data-e2e-welcome-page-sign-in-button>Sign in</button></mw-welcome-page-container>";
const QR = "<mw-authentication-container><div>Scan this QR code</div></mw-authentication-container>";
const LIST = `<mws-conversations-list><mws-conversation-list-item><a data-e2e-conversation href="/web/conversations/aaaaaaaaaaaaaaaaaa1"><span data-e2e-conversation-name>Ann Example</span><mws-relative-timestamp>3:45 PM</mws-relative-timestamp></a></mws-conversation-list-item></mws-conversations-list><div id="chat"></div>`;
const OVER = { error: "job_over", message: "This Keepr sync has ended. Click Sync in Keepr again." };

jest.setTimeout(10_000);

type Reply = { ok: boolean; status: number; body: Record<string, unknown> | null };
type Stage = { at: number; path: string; html: string };

/**
 * A page that changes over time: `stages` (by ms since the start) set the
 * path and the body. Every sleep advances the clock by its ms.
 */
function page(stages: Stage[], replies: { waiting?: (n: number) => Reply; claim?: Reply } = {}) {
  let t = 0;
  let open = "";
  let current = -1;
  const calls: Array<[string, string, Record<string, unknown> | undefined, number]> = [];
  const shown: Array<[string, boolean, Record<string, any> | undefined]> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const events: string[] = [];
  let waitingFlag = false;
  const flagLog: boolean[] = [];
  let sleeps = 0;
  const onTick: Array<(t: number) => void> = [];
  function apply(): void {
    let idx = 0;
    for (let i = 0; i < stages.length; i++) if (stages[i].at <= t) idx = i;
    if (idx !== current) {
      current = idx;
      document.body.innerHTML = stages[idx].html;
      events.push(`page ${stages[idx].path} @${t}`);
    }
  }
  apply();
  let waitingCount = 0;
  const env = {
    doc: document,
    now: () => new Date(NOW + t),
    getLocation: () => {
      const p = stages[current].path === "/web/conversations" && open ? `/web/conversations/${open}` : stages[current].path;
      return { pathname: p, href: `https://messages.google.com${p}` };
    },
    api: async (method: string, p: string, body?: Record<string, unknown>): Promise<Reply> => {
      calls.push([method, p, body, t]);
      events.push(`${p.replace(`/job/${JOB}`, "")} @${t}`);
      if (p.endsWith("/waiting")) {
        waitingCount += 1;
        return replies.waiting ? replies.waiting(waitingCount) : { ok: true, status: 200, body: { ok: true, waitLeftMs: 15 * 60000 - 2000 } };
      }
      if (p.endsWith("/claim")) {
        return replies.claim ?? { ok: true, status: 200, body: { jobId: JOB, kind: "cache", since: new Date(NOW - 10 * DAY).toISOString(), startDate: new Date(NOW - 10 * DAY).toISOString() } };
      }
      if (p.endsWith("/match")) return { ok: true, status: 200, body: { matched: true } };
      if (p.endsWith("/chat")) return { ok: true, status: 200, body: { ok: true, stored: 1, received: 1 } };
      return { ok: true, status: 200, body: { ok: true } };
    },
    overlay: { show: (text: string, isError: boolean, extras?: Record<string, unknown>) => shown.push([text, isError, extras]) },
    sleep: async (ms: number) => {
      sleeps += 1;
      if (sleeps > 20_000) throw new Error("test harness: runaway loop");
      t += ms;
      apply();
      for (const f of onTick) f(t);
    },
    setWaitingForSignIn: (on: boolean) => {
      waitingFlag = on;
      flagLog.push(on);
    },
    onClaimed: () => events.push(`onClaimed @${t}`),
    pageTimeoutMs: 1000,
    click: (el: Element) => (el as HTMLElement).click(),
    openConversation: async (c: { conversationId: string }) => {
      open = c.conversationId;
    },
    returnToList: async () => true,
    readImage: async () => ({ mimeType: "image/jpeg", base64: "AAAA" }),
    extract: () => ({
      conversationId: open, title: open,
      messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hi", sentAt: new Date(NOW - DAY).toISOString(), transport: "rcs", imageSrcs: [], files: [], reactions: [] }],
      skipped: { noDate: 0, noText: 0 },
    }),
    scan: {
      ...scan,
      readParticipantsAndClose: async () => ["(555) 555-0101"],
      waitForMessageSwap: async () => true,
      loadHistory: async () => ({ stopReason: "floor", count: 1 }),
      messageIdSet: () => "",
    },
  };
  return {
    env, calls, shown, events, onTick, flagLog,
    clock: () => t,
    waiting: () => waitingFlag,
    paths: () => calls.map((c) => c[1].replace(`/job/${JOB}`, "")),
  };
}

const SIGNED_IN_AT = 90_000;

describe("BACKLOG-3924: waiting for sign-in", () => {
  it("C5: welcome → QR → signed in: waits, then claims once by itself; no /error; the card says S2/S3/S4", async () => {
    const p = page([
      { at: 0, path: "/web/welcome", html: WELCOME },
      { at: 20_000, path: "/web/authentication", html: QR },
      { at: SIGNED_IN_AT, path: "/web/conversations", html: LIST },
    ]);
    const out = await job.runJob(JOB, p.env);
    expect(out.outcome).not.toBe("not_signed_in");
    const paths = p.paths();
    expect(paths.filter((x) => x === "/claim")).toHaveLength(1);
    expect(paths).not.toContain("/error");
    expect(paths[0]).toBe("/waiting");
    // Heartbeats while waiting (one every 15 s), none after the claim.
    const claimAt = p.calls.find((c) => c[1].endsWith("/claim"))![3];
    expect(claimAt).toBeGreaterThanOrEqual(SIGNED_IN_AT);
    expect(claimAt).toBeLessThan(SIGNED_IN_AT + 2000);
    const beats = p.calls.filter((c) => c[1].endsWith("/waiting"));
    expect(beats.length).toBeGreaterThanOrEqual(6);
    expect(beats.every((c) => c[3] < claimAt)).toBe(true);
    expect(beats[0][2]).toEqual({ reason: "sign_in" });
    // The waiting card: S1 title, S2–S4.
    const card = p.shown.find((s) => s[2] && s[2].signIn && s[2].signIn.waiting)!;
    expect(card[0]).toBe("Sign in to Google Messages");
    expect(card[1]).toBe(false);
    const box = document.createElement("div");
    job.renderOverlay(box, card[0], card[1], card[2], { copy: async () => true });
    expect(box.textContent).toContain("Scan the QR code with your phone, or sign in. Keepr starts the Sync when you're done.");
    expect(box.textContent).toContain("Turn on \"Remember this computer\" so you only do this once.");
    expect(box.querySelector('[data-keepr="sign-in-start"]')!.textContent).toBe("I'm signed in — start Sync");
    // The wait flag was on during the wait, off after.
    expect(p.flagLog).toEqual([true, false]);
  });

  it("C6: the signed-in path with no list yet is NOT ready — the claim waits for the list", async () => {
    const PATH_AT = 30_000;
    const p = page([
      { at: 0, path: "/web/welcome", html: WELCOME },
      { at: PATH_AT, path: "/web/conversations", html: "<div id=\"loading\"></div>" },
      { at: PATH_AT + 3000, path: "/web/conversations", html: LIST },
    ]);
    await job.runJob(JOB, p.env);
    const claim = p.calls.find((c) => c[1].endsWith("/claim"))!;
    expect(claim[3]).toBeGreaterThanOrEqual(PATH_AT + 3000);
  });

  it("C7: the start button signed out → S5, no claim; signed in → claim at once", async () => {
    const p = page([{ at: 0, path: "/web/welcome", html: WELCOME }]);
    const clicks: boolean[] = [];
    p.onTick.push((t) => {
      const last = [...p.shown].reverse().find((s) => s[2] && s[2].signIn && s[2].signIn.waiting);
      if (t === 5000) clicks.push(last![2]!.signIn.start());
      if (t === 9000) {
        // Signed in, but the poll has not looked yet: the click starts it.
        document.body.innerHTML = LIST;
        clicks.push(last![2]!.signIn.start());
      }
    });
    // The page path never changes: only the click and the list decide.
    const real = p.env.getLocation;
    p.env.getLocation = () => (p.clock() >= 9000 ? { pathname: "/web/conversations", href: "x" } : real());
    await job.runJob(JOB, p.env);
    expect(clicks).toEqual([false, true]);
    const notYet = p.shown.find((s) => s[2] && s[2].signIn && s[2].signIn.notYet)!;
    const box = document.createElement("div");
    job.renderOverlay(box, notYet[0], notYet[1], notYet[2], { copy: async () => true });
    expect(box.textContent).toContain("Google Messages isn't signed in yet. Finish signing in, then click again.");
    const claim = p.calls.find((c) => c[1].endsWith("/claim"))!;
    expect(claim[3]).toBeGreaterThanOrEqual(9000);
  });

  it("C7: a click while signed out never claims", async () => {
    const p = page([{ at: 0, path: "/web/welcome", html: WELCOME }], {
      // Stop in Keepr after the click, so the run ends.
      waiting: (n) => (n >= 3 ? { ok: false, status: 410, body: OVER } : { ok: true, status: 200, body: { ok: true, waitLeftMs: 600000 } }),
    });
    p.onTick.push((t) => {
      const last = [...p.shown].reverse().find((s) => s[2] && s[2].signIn && s[2].signIn.waiting);
      if (t === 5000) last![2]!.signIn.start();
    });
    await job.runJob(JOB, p.env);
    expect(p.paths()).not.toContain("/claim");
  });

  it("C8: the tab's copy of the job goes only after a successful claim (a reload before it resumes the job)", async () => {
    const p = page([
      { at: 0, path: "/web/welcome", html: WELCOME },
      { at: SIGNED_IN_AT, path: "/web/conversations", html: LIST },
    ]);
    await job.runJob(JOB, p.env);
    const iClaim = p.events.findIndex((e) => e.startsWith("/claim"));
    const iForget = p.events.findIndex((e) => e.startsWith("onClaimed"));
    expect(iClaim).toBeGreaterThanOrEqual(0);
    expect(iForget).toBe(iClaim + 1);
    expect(p.events.filter((e) => e.startsWith("onClaimed"))).toHaveLength(1);
    // A refused claim keeps it (nothing ran).
    const q = page([{ at: 0, path: "/web/conversations", html: LIST }], { claim: { ok: false, status: 409, body: { error: "already_running", message: "x" } } });
    await job.runJob(JOB, q.env);
    expect(q.events.some((e) => e.startsWith("onClaimed"))).toBe(false);
    // The browser glue: start() no longer drops the tab's copy before the run;
    // the claim (env.onClaimed) and the run's end do.
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    const startBody = src.slice(src.indexOf("async function start(jobId) {"), src.indexOf("await runJob(jobId, env());"));
    expect(startBody.length).toBeGreaterThan(0);
    expect(startBody).not.toMatch(/sessionStorage\.removeItem|forgetStoredJob\(\)/);
    expect(src).toContain("onClaimed: forgetStoredJob,");
  });

  it("C9: an older Keepr (no /waiting: 404 not_found) → one /error not_signed_in and today's card", async () => {
    const p = page([{ at: 0, path: "/web/welcome", html: WELCOME }], {
      waiting: () => ({ ok: false, status: 404, body: { error: "not_found" } }),
    });
    const out = await job.runJob(JOB, p.env);
    expect(out.outcome).toBe("not_signed_in");
    expect(p.paths()).toEqual(["/waiting", "/error"]);
    expect(p.calls[1][2]).toEqual({ code: "not_signed_in", message: job.NOT_SIGNED_IN });
    expect(p.shown).toHaveLength(1);
    expect(p.shown[0][0]).toBe("Sign in to Google Messages");
    expect(p.shown[0][2]!.signIn).toBe(true);
  });

  it("C10: Stop in Keepr during the wait (410) → no claim, no /error, the cancelled card", async () => {
    const p = page([
      { at: 0, path: "/web/welcome", html: WELCOME },
      { at: SIGNED_IN_AT, path: "/web/conversations", html: LIST },
    ], {
      waiting: (n) => (n >= 2 ? { ok: false, status: 410, body: OVER } : { ok: true, status: 200, body: { ok: true, waitLeftMs: 600000 } }),
    });
    const out = await job.runJob(JOB, p.env);
    expect(out.outcome).toBe("job_gone");
    expect(p.paths()).not.toContain("/claim");
    expect(p.paths()).not.toContain("/error");
    expect(p.shown[p.shown.length - 1][0]).toBe("Sync cancelled in Keepr");
    expect(p.flagLog).toEqual([true, false]);
  });

  it("15 min without sign-in: S6 and one /error not_signed_in (Keepr's limit is the same)", async () => {
    const p = page([{ at: 0, path: "/web/authentication", html: QR }]);
    const out = await job.runJob(JOB, p.env);
    expect(out.outcome).toBe("not_signed_in");
    const errors = p.calls.filter((c) => c[1].endsWith("/error"));
    expect(errors).toHaveLength(1);
    expect(errors[0][2]).toEqual({ code: "not_signed_in", message: job.NOT_SIGNED_IN });
    expect(errors[0][3]).toBeLessThan(15 * 60000);
    expect(errors[0][3]).toBeGreaterThanOrEqual(15 * 60000 - 2000 - 2000);
    const last = p.shown[p.shown.length - 1];
    const box = document.createElement("div");
    job.renderOverlay(box, last[0], last[1], last[2], { copy: async () => true });
    expect(box.textContent).toContain("Sign-in took too long. Click Sync in Keepr to try again.");
    expect(p.paths()).not.toContain("/claim");
  });

  it("an unknown path while waiting (an interstitial) keeps waiting", async () => {
    const p = page([
      { at: 0, path: "/web/welcome", html: WELCOME },
      { at: 10_000, path: "/web/something-new", html: "<div></div>" },
      { at: 40_000, path: "/web/conversations", html: LIST },
    ]);
    await job.runJob(JOB, p.env);
    expect(p.paths()).not.toContain("/error");
    expect(p.calls.find((c) => c[1].endsWith("/claim"))![3]).toBeGreaterThanOrEqual(40_000);
  });

  it("the sign-in page under an unknown path is recognised by its markers", async () => {
    const p = page([{ at: 0, path: "/web/unknown", html: WELCOME }], {
      waiting: () => ({ ok: false, status: 404, body: { error: "not_found" } }),
    });
    const out = await job.runJob(JOB, p.env);
    expect(out.outcome).toBe("not_signed_in");
  });

  it("C11: pagehide while waiting → /waiting (sign_in_redirect), never /error page_gone; a running Sync still reports page_gone", () => {
    expect(job.pageHideReport({ jobId: JOB, running: true, waitingForSignIn: true })).toEqual({
      path: `/job/${JOB}/waiting`, body: { reason: "sign_in_redirect" },
    });
    expect(job.pageHideReport({ jobId: JOB, running: true, waitingForSignIn: false, metrics: undefined })).toMatchObject({
      path: `/job/${JOB}/error`, body: { code: "page_gone" },
    });
  });

  it("C11: welcome → pagehide → reload → signed in: the second page load claims once; zero /error", async () => {
    // First page load: waiting on /web/welcome, then the page goes away.
    const first = page([{ at: 0, path: "/web/welcome", html: WELCOME }]);
    let hidden: { path: string } | null = null;
    first.onTick.push((t) => {
      if (t === 20_000 && hidden === null) {
        hidden = job.pageHideReport({ jobId: JOB, running: true, waitingForSignIn: first.waiting() });
        throw new Error("page unloaded");
      }
    });
    await expect(job.runJob(JOB, first.env)).rejects.toThrow("page unloaded");
    expect(hidden).toEqual({ path: `/job/${JOB}/waiting`, body: { reason: "sign_in_redirect" } });
    // The reload (the tab's stored job, C8): signed in now.
    const second = page([{ at: 0, path: "/web/conversations", html: LIST }]);
    await job.runJob(JOB, second.env);
    const all = [...first.paths(), hidden!.path.replace(`/job/${JOB}`, ""), ...second.paths()];
    expect(all.filter((x) => x === "/error")).toHaveLength(0);
    expect(all.filter((x) => x === "/claim")).toHaveLength(1);
  });

  it("the old card (an older Keepr) is unchanged: one line, no button", () => {
    const box = document.createElement("div");
    job.renderOverlay(box, job.SIGN_IN_TITLE, false, { signIn: true }, { copy: async () => true });
    expect(box.textContent).toContain("Sign in or scan the QR code, then Sync now in Keepr.");
    expect(box.querySelector('[data-keepr="sign-in-start"]')).toBeNull();
  });
});
