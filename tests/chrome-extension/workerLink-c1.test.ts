/**
 * @jest-environment node
 */
/**
 * C1 (UX redesign, founder + SR 2026-10-03) — REVERSED linking, the real
 * worker against the real bridge and Keepr's pairing auth.
 *
 * Mutation controls (each turns a test red):
 *   L1 the 6-digit code sent to Keepr                          → "Link: a 6-digit code made here"
 *   L2 a wrong code in Keepr not counted / not retried          → "a wrong code typed in Keepr"
 *   L3 a new link not revoking the old browser                  → "one linked browser"
 *   L4 unlink not revoking in Keepr                             → "Unlink"
 *   L5 the email unmasked, or sent to an unsigned request       → "/status: the masked email"
 *   L6 an old extension not told it is out of date              → "the popup's states"
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("../../electron/services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { RcsExtensionBridge, RCS_EXTENSION_ORIGIN, RCS_MIN_EXTENSION_VERSION, maskEmail } from "../../electron/services/rcsExtensionBridge";
import { RcsJobRegistry } from "../../electron/services/rcsImportJob";
import { RcsPairingAuth, type PairProtocol, type PairingStore, type RcsPairing } from "../../electron/services/rcsPairingAuth";
import { installPairing, P, uninstallPairing } from "./helpers/pairedWorker";

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
const EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";
type Listener = (m: Record<string, unknown>, s: { id: string }, r: (x: unknown) => void) => boolean;

let currentUser: string | null = "user-a";
let rows: RcsPairing[];
let auth: RcsPairingAuth;
let bridge: RcsExtensionBridge;
let port: number;

beforeEach(async () => {
  currentUser = "user-a";
  rows = [];
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
    currentUserEmail: async () => "agent.tester@example.test",
    jobs: new RcsJobRegistry(),
    pairing: auth,
    pairingMode: "dual",
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
});
afterEach(async () => {
  await bridge.stop();
  uninstallPairing();
});

async function worker(version = "9.9.9") {
  await installPairing(false);
  let listener: Listener | null = null;
  const bodies: string[] = [];
  const chromeStub = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version }) },
    tabs: { query: jest.fn(async () => []) },
  };
  const fetchShim = async (url: string, init: RequestInit) => {
    bodies.push(String(init.body ?? ""));
    const headers = { ...(init.headers as Record<string, string>), Origin: RCS_EXTENSION_ORIGIN };
    return fetch(url.replace(":38619", `:${port}`), { ...init, headers });
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("chrome", "fetch", SOURCE)(chromeStub, fetchShim);
  const send = (m: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      if (!listener!(m, { id: EXTENSION_ID }, (x) => resolve(x as Record<string, unknown>))) resolve({ sync: true });
    });
  await new Promise((r) => setTimeout(r, 20));
  bodies.length = 0;
  return { send, bodies };
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

jest.setTimeout(20000);

describe("C1: reversed linking (the popup's 6-digit code, typed in Keepr)", () => {
  it("Link: a 6-digit code made here, never sent; typed in Keepr → linked, signed calls work (L1)", async () => {
    const w = await worker();
    const started = await w.send({ type: "keepr-link-start" });
    const link = started.link as { status: string; code: string };
    expect(started).toMatchObject({ ok: true });
    expect(link.status).toBe("waiting");
    expect(link.code).toMatch(/^[0-9]{6}$/);
    expect(auth.linkState().state).toBe("waiting");
    expect(auth.linkEnterCode("user-a", link.code.slice(0, 3) + " " + link.code.slice(3))).toEqual({ ok: true });
    await waitFor(async () => ((await w.send({ type: "keepr-link-state" })).link as { status: string }).status === "linked");
    expect(rows.map((r) => r.userId)).toEqual(["user-a"]);
    expect((await w.send({ type: "keepr-pair-status" })).paired).toBe(true);
    // The code itself never left this worker.
    expect(w.bodies.some((b) => b.includes(link.code))).toBe(false);
    expect((await w.send({ type: "keepr-popup-state" })).state).toBe("linked");
  });

  it("a wrong code typed in Keepr: counted, the popup waits for the right one (L2)", async () => {
    const w = await worker();
    const link = (await w.send({ type: "keepr-link-start" })).link as { code: string };
    const wrong = link.code === "000000" ? "111111" : "000000";
    auth.linkEnterCode("user-a", wrong);
    await waitFor(() => auth.linkState().state === "waiting" && (auth.linkState() as { triesLeft: number }).triesLeft === 4);
    expect(rows).toEqual([]);
    auth.linkEnterCode("user-a", link.code);
    await waitFor(() => rows.length === 1);
  });

  it("one linked browser per user: a new link revokes the old one (its signed calls → 401) (L3)", async () => {
    const first = await worker();
    const l1 = (await first.send({ type: "keepr-link-start" })).link as { code: string };
    auth.linkEnterCode("user-a", l1.code);
    await waitFor(() => rows.length === 1);
    const oldId = rows[0].pairId;
    const second = await worker();
    const l2 = (await second.send({ type: "keepr-link-start" })).link as { code: string };
    auth.linkEnterCode("user-a", l2.code);
    await waitFor(() => rows.length === 1 && rows[0].pairId !== oldId);
    // The old browser: unknown to Keepr now → it forgets its link.
    expect((await first.send({ type: "keepr-check-pending" })).status).toBe(401);
    expect((await first.send({ type: "keepr-pair-status" })).paired).toBe(false);
  });

  it("Unlink (signed): revoked in Keepr and forgotten here; unsigned it is refused (L4)", async () => {
    const w = await worker();
    const l = (await w.send({ type: "keepr-link-start" })).link as { code: string };
    auth.linkEnterCode("user-a", l.code);
    await waitFor(() => rows.length === 1);
    expect((await w.send({ type: "keepr-unlink" })).keepr).toBe(true);
    expect(rows).toEqual([]);
    expect((await w.send({ type: "keepr-pair-status" })).paired).toBe(false);
    const unsigned = await fetch(`http://127.0.0.1:${port}/link/unlink`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN, Host: `127.0.0.1:${port}` }, body: "{}",
    });
    expect(unsigned.status).toBe(401);
  });

  it("/status: the masked email, to a signed request only (L5)", async () => {
    expect(maskEmail("agent.tester@example.test")).toBe("a***@example.test");
    expect(maskEmail("nope")).toBeNull();
    const w = await worker();
    const l = (await w.send({ type: "keepr-link-start" })).link as { code: string };
    auth.linkEnterCode("user-a", l.code);
    await waitFor(() => rows.length === 1);
    expect(await w.send({ type: "keepr-popup-state" })).toMatchObject({ state: "linked", email: "a***@example.test" });
    expect(w.bodies.join("\n")).not.toContain("agent.tester");
  });

  it("the popup's states: Keepr down, out of date, not linked, linking (L6)", async () => {
    const old = await worker("0.3.31");
    expect(await old.send({ type: "keepr-popup-state" })).toMatchObject({ state: "out_of_date", minVersion: RCS_MIN_EXTENSION_VERSION });
    const w = await worker();
    expect((await w.send({ type: "keepr-popup-state" })).state).toBe("not_linked");
    await w.send({ type: "keepr-link-start" });
    expect((await w.send({ type: "keepr-popup-state" })).state).toBe("linking");
    await bridge.stop();
    expect((await w.send({ type: "keepr-popup-state" })).state).toBe("keepr_down");
    await bridge.start(0);
  });
});
