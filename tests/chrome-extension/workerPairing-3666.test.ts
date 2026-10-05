/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — the extension's side of pairing, END TO END: the real
 * service worker (background.js) against a REAL Keepr bridge (HTTP on a
 * random loopback port) running the REAL pairing gate and protocol.
 *
 * SR (2026-10-03): the worker links only through the popup's code (C1); the
 * legacy 8-character exchange is gone from both sides.
 *
 * Mutations that turn this red:
 *   W1 a job call sent while unpaired                         → "unpaired"
 *   W2 a reply accepted without Keepr's signature (squatter)  → "squatter"
 *   W3 re_pair / unknown_pair not forgetting the pairing      → "re_pair"
 *   W4 the key extractable                                    → "non-extractable"
 *   W6 the legacy code exchange still in the worker           → "no legacy exchange"
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("../../electron/services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { RcsExtensionBridge, RCS_EXTENSION_ORIGIN } from "../../electron/services/rcsExtensionBridge";
import { RcsJobRegistry } from "../../electron/services/rcsImportJob";
import { RcsPairingAuth, type PairProtocol, type PairingStore, type RcsPairing } from "../../electron/services/rcsPairingAuth";
import { installPairing, P, uninstallPairing } from "./helpers/pairedWorker";
import { focusForBrowser } from "../../electron/services/rcsLinkFocus";


const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
const EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";
type Listener = (m: Record<string, unknown>, s: { id: string; url?: string }, r: (x: unknown) => void) => boolean;

let currentUser: string | null = "user-a";
let rows: RcsPairing[];
let auth: RcsPairingAuth;
let bridge: RcsExtensionBridge;
let port: number;
/** Founder Option 1: what Keepr did on /focus (focused; opened the link step). */
let focused: number;
let linkScreens: number;

beforeEach(async () => {
  currentUser = "user-a";
  rows = [];
  focused = 0;
  linkScreens = 0;
  const store: PairingStore = {
    get: (id) => rows.find((r) => r.pairId === id) ?? null,
    save: (p) => {
      rows = rows.filter((r) => r.userId !== p.userId).concat([p]);
    },
    existsForUser: (u) => rows.some((r) => r.userId === u),
    deleteForUser: (u) => {
      rows = rows.filter((r) => r.userId !== u);
    },
  };
  auth = new RcsPairingAuth(P as unknown as PairProtocol, store);
  bridge = new RcsExtensionBridge({
    importChat: jest.fn(),
    importImage: jest.fn(),
    currentUserId: async () => currentUser,
    jobs: new RcsJobRegistry(),
    pairing: auth,
    onFocusRequested: () =>
      focusForBrowser({
        focus: () => (focused += 1),
        focusForLink: () => (focused += 1),
        linkState: () => auth.linkState(),
        openLinkScreen: () => (linkScreens += 1),
      }),
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
});
afterEach(async () => {
  await bridge.stop();
  uninstallPairing();
});

/** The real worker; its fetch reaches the test bridge (or `override`, a fake "Keepr"). */
async function worker(
  override?: (url: string, init: RequestInit) => Promise<Response> | undefined,
  extraChrome: Record<string, unknown> = {},
) {
  const store = await installPairing(false);
  let listener: Listener | null = null;
  const sent: string[] = [];
  const chromeStub = {
    runtime: { id: EXTENSION_ID, getURL: (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`, onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version: "9.9.9" }) },
    tabs: { query: jest.fn(async () => []) },
    ...extraChrome,
  };
  const fetchShim = async (url: string, init: RequestInit) => {
    sent.push(new URL(url).pathname);
    const fake = override?.(url, init);
    if (fake) return fake;
    const headers = { ...(init.headers as Record<string, string>), Origin: RCS_EXTENSION_ORIGIN };
    return fetch(url.replace(":38619", `:${port}`), { ...init, headers });
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("chrome", "fetch", SOURCE)(chromeStub, fetchShim);
  const send = (m: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      if (!listener!(m, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` }, (x) => resolve(x as Record<string, unknown>))) resolve({ sync: true });
    });
  await new Promise((r) => setTimeout(r, 20)); // the startup hello
  sent.length = 0;
  return { send, sent, store };
}

const pending = { type: "keepr-check-pending" };

async function waitFor(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

/** Link `w` the C1 way: its code, typed in Keepr by the signed-in user. */
async function link(w: { send: (m: Record<string, unknown>) => Promise<Record<string, unknown>> }): Promise<void> {
  const l = (await w.send({ type: "keepr-link-start" })).link as { code: string };
  expect(auth.linkEnterCode(currentUser as string, l.code)).toEqual({ ok: true });
  await waitFor(async () => (await w.send({ type: "keepr-pair-status" })).paired === true);
}

jest.setTimeout(20000);

describe("the worker's link with Keepr (BACKLOG-3666, C1)", () => {
  it("unpaired: a job call is refused here and never sent (W1)", async () => {
    const w = await worker();
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 0, body: { error: "not_paired" } });
    expect(w.sent).toEqual([]);
  });

  it("linked: job calls are signed and their replies verified", async () => {
    const w = await worker();
    await link(w);
    expect(rows).toHaveLength(1);
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 404, body: { error: "no_job" } }); // signed, routed, verified
  });

  // SR C5: Keepr's rate limit on the link routes (429) is wait-and-ask-again,
  // never a failed link. Mutation: 429 on /link/poll fails the link → red.
  it("a 429 on /link/poll: the popup waits and asks again; the link completes", async () => {
    let polls429 = 0;
    const w = await worker((url) => {
      if (new URL(url).pathname === "/link/poll" && polls429 < 2) {
        polls429 += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: "rate_limited", retryAfterMs: 1000 }), { status: 429, headers: { "Content-Type": "application/json" } }));
      }
      return undefined;
    });
    await link(w);
    expect(polls429).toBe(2);
  });

  it("the key is a non-extractable CryptoKey (W4)", async () => {
    const w = await worker();
    await link(w);
    const key = w.store.current!.key as unknown as { extractable: boolean; type: string; usages: string[] };
    expect(key.type).toBe("secret");
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
  });

  // A process squatting Keepr's port, without the code typed in Keepr.
  it("a squatter can't complete a link, and can't answer a linked worker (W2)", async () => {
    const fake = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let pA = "";
    const squat = await worker((url, init) => {
      const p = new URL(url).pathname;
      if (p === "/link/start") {
        pA = JSON.parse(String(init.body)).pA;
        return Promise.resolve(fake(200, { sessionId: "squat", expiresInMs: 120000 }));
      }
      if (p === "/link/poll") {
        // It guesses the code.
        const guess = P.respondB("000001", pA);
        return Promise.resolve(fake(200, { state: "answered", pB: guess.pB, cB: guess.cB }));
      }
      if (p === "/link/finish") return Promise.resolve(fake(429, { error: "too_many_tries" }));
      return undefined;
    });
    await squat.send({ type: "keepr-link-start" });
    await waitFor(async () => ((await squat.send({ type: "keepr-link-state" })).link as { status: string }).status === "failed");
    expect(await squat.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    // Linked for real, then the squatter answers a job call (unsigned, or signed with a guess).
    let squatting = false;
    const w = await worker((url) => (squatting && new URL(url).pathname.startsWith("/job/") ? Promise.resolve(fake(200, { jobId: "x" })) : undefined));
    await link(w);
    squatting = true;
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 0, body: { error: "unverified" } });
  });

  it("Keepr says re_pair (another user signed in), or no longer knows the link: forgotten (W3)", async () => {
    const w = await worker();
    await link(w);
    currentUser = "user-b";
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    currentUser = "user-a";
    const w2 = await worker();
    await link(w2);
    auth.revoke("user-a");
    expect(await w2.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w2.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });
  });

  // Founder Option 1: as soon as the code shows, Keepr comes forward ONCE
  // per session and opens its link step (the code field focused there).
  // Mutations: no /focus on a new session; /focus again for the same session;
  // Keepr not opening the link step while a code waits → red.
  it("a new code: /focus once per session; Keepr opens its link step", async () => {
    const w = await worker();
    await w.send({ type: "keepr-link-start" });
    await waitFor(() => focused === 1);
    await w.send({ type: "keepr-link-start" }); // the same session, still waiting
    await new Promise((r) => setTimeout(r, 100));
    expect(w.sent.filter((p) => p === "/focus")).toHaveLength(1);
    expect(focused).toBe(1);
    expect(linkScreens).toBe(1);
  });

  // SR (O5 inside this suite) + storyboard D03/A06: the page card opens
  // link window (popup.html?autolink=1) — never the toolbar popup (it would close when
  // Keepr comes forward) — at the RIGHT edge of the page's screen, centred
  // vertically. Mutations: the toolbar popup tried first; no placement → red.
  it("the page card: the link window at the screen's right edge, centred — never the toolbar popup", async () => {
    const openPopup = jest.fn(async () => undefined);
    const created: Array<Record<string, unknown>> = [];
    const w = await worker(undefined, {
      action: { openPopup },
      windows: {
        create: async (o: Record<string, unknown>) => {
          created.push(o);
          return { id: 7 };
        },
        update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
    });
    const r = await w.send({ type: "keepr-open-link-window", screen: { left: 1920, top: 0, width: 1920, height: 1040 } });
    expect(openPopup).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, how: "window" });
    expect(created).toEqual([
      { url: `chrome-extension://${EXTENSION_ID}/popup.html?autolink=1`, type: "popup", width: 380, height: 380, focused: true, left: 1920 + 1920 - 380 - 24, top: 330 },
    ]);
  });

  // SR: the page's numbers clamped to 0..20000; bounds Chrome refuses →
  // once more without placement, so the window always opens. Mutations: no
  // clamp; no retry → red.
  it("screen numbers clamped; refused bounds → the window still opens, unplaced", async () => {
    const created: Array<Record<string, unknown>> = [];
    let refuseBounds = false;
    const w = await worker(undefined, {
      windows: {
        create: async (o: Record<string, unknown>) => {
          created.push(o);
          if (refuseBounds && "left" in o) throw new Error("Invalid value for bounds");
          return { id: 9 };
        },
        update: async () => {
          throw new Error("gone");
        },
        onRemoved: { addListener: () => undefined },
      },
    });
    const realNow = Date.now;
    let clock = 5_000_000;
    Date.now = () => clock;
    try {
      // A monitor left of / above the primary: negative coordinates kept.
      await w.send({ type: "keepr-open-link-window", screen: { left: -1920, top: -200, width: 1920, height: 1080 } });
      expect(created[0]).toMatchObject({ left: -1920 + 1920 - 380 - 24, top: -200 + 350 });
      // Extreme values clamped: left / top to ±20000, width / height to ≤ 20000.
      clock += 5_000;
      await w.send({ type: "keepr-open-link-window", screen: { left: -1e9, top: 1e9, width: 99999, height: 1e9 } });
      expect(created[1]).toMatchObject({ left: -20000 + 20000 - 380 - 24, top: 20000 + Math.round((20000 - 380) / 2) });
      // Width / height below 1 → 1: too small for the window → unplaced.
      clock += 5_000;
      await w.send({ type: "keepr-open-link-window", screen: { left: 0, top: 0, width: -5, height: 0 } });
      expect(created[2]).not.toHaveProperty("left");
      created.length = 0;
      refuseBounds = true;
      clock += 5_000;
      const r = await w.send({ type: "keepr-open-link-window", screen: { left: 0, top: 0, width: 1920, height: 1080 } });
      expect(r).toEqual({ ok: true, how: "window" });
      expect(created).toEqual([
        { url: `chrome-extension://${EXTENSION_ID}/popup.html?autolink=1`, type: "popup", width: 380, height: 380, focused: true, left: 1920 - 380 - 24, top: 350 },
        { url: `chrome-extension://${EXTENSION_ID}/popup.html?autolink=1`, type: "popup", width: 380, height: 380, focused: true },
      ]);
    } finally {
      Date.now = realNow;
    }
  });

  it("no usable screen numbers: Chrome's default place (never NaN)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const w = await worker(undefined, {
      windows: {
        create: async (o: Record<string, unknown>) => {
          created.push(o);
          return { id: 8 };
        },
        update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
    });
    await w.send({ type: "keepr-open-link-window", screen: { width: "wide", height: NaN } });
    expect(created[0]).not.toHaveProperty("left");
    expect(created[0]).not.toHaveProperty("top");
  });

  // SR (2026-10-03): nothing can mint an 8-character code any more.
  // Mutation: the legacy exchange kept in the worker → red.
  it("no legacy exchange left in the worker (W6)", () => {
    expect(SOURCE).not.toMatch(/pairWithCode|"\/pair\/start"|case "keepr-pair":/);
  });
});
