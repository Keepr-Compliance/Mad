/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR4 — the main-only refresher: session read every minute (D1),
 * per-user fetch throttle, one 10 s window around session + RPC, Sentry tags.
 *
 * RPC answers are the transcribed supabase-js outputs in
 * fixtures/senderRuleSetRpc-4175/ (see senderRuleSetStore-4175.test.ts).
 * Consumers are simulated by calling the store's getter, which is all a
 * consumer does.
 */
import fs from "fs";
import os from "os";
import path from "path";

import type { SenderRuleSet } from "../../utils/senderFilter/bundledRules";

jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

// Disk writes are the store suite's subject; here they complete at once so fake timers drive everything.
const writes: string[] = [];
jest.mock("../atRest/fileCrypto", () => ({
  writeFileAtomic: async (target: string) => {
    writes.push(target);
  },
}));

const setTag = jest.fn();
jest.mock("@sentry/electron/main", () => ({ setTag: (...a: unknown[]) => setTag(...a) }));

let session: { userId: string } | null = null;
let sessionHangs = false;
const getAuthSession = jest.fn(() => (sessionHangs ? new Promise(() => undefined) : Promise.resolve(session)));
type Answer = { data: unknown; error: unknown; status: number };
let rpcAnswer: (userId: string | null) => Promise<Answer> = () => new Promise(() => undefined);
const rpcCalls: Array<string | null> = [];
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthSession: () => getAuthSession(),
    getClient: () => ({
      rpc: (fn: string) => ({
        abortSignal: () => {
          if (fn !== "sender_rule_set_current") throw new Error(`unexpected rpc ${fn}`);
          rpcCalls.push(session?.userId ?? null);
          return rpcAnswer(session?.userId ?? null);
        },
      }),
    }),
  },
}));

import { installAppPaths } from "../../capabilities/appPathsProvider";
import { parseSenderRuleSet } from "../../utils/senderFilter/ruleSetSchema";
import * as store from "../senderRuleSetStore";
import { FETCH_TIMEOUT_MS, __resetRefresherForTests, startSenderRuleSetRefresher } from "../senderRuleSetRefresher";

const FIX = path.join(__dirname, "fixtures", "senderRuleSetRpc-4175");
const fixture = (name: string): Answer => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));
const bundled: SenderRuleSet = jest.requireActual("../../utils/senderFilter/bundledRules").BUNDLED_SENDER_RULES;
function v(version: number): SenderRuleSet {
  const r = parseSenderRuleSet(JSON.parse(JSON.stringify({ ...bundled, version })));
  if (!r) throw new Error("bad fixture");
  return r;
}
/** The transcribed valid answer with only the version moved. */
function validAnswer(version: number): Answer {
  const f = fixture("valid-signed-in");
  return { ...f, data: { version, content: v(version) } };
}

const MINUTE = store.IDENTITY_CHECK_MS + 1_000;
const flush = () => jest.advanceTimersByTimeAsync(0);
async function consumerCall(): Promise<store.ActiveSenderRules> {
  const a = store.getActiveSenderRules();
  await flush();
  return a;
}
async function later(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

let dir: string;
beforeEach(() => {
  // Never the shared test userData: a cache left there would leak into other suites.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-rules-refresher-4175-"));
  installAppPaths({ userData: () => dir });
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12) });
  store.__resetForTests();
  __resetRefresherForTests();
  session = { userId: "user-a" };
  sessionHangs = false;
  rpcAnswer = () => new Promise(() => undefined);
  rpcCalls.length = 0;
  getAuthSession.mockClear();
  setTag.mockClear();
  startSenderRuleSetRefresher({ force: true });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("refresher", () => {
  it("is a no-op under jest without force (main.ts call is safe in tests)", () => {
    __resetRefresherForTests();
    store.__resetForTests();
    startSenderRuleSetRefresher();
    store.getActiveSenderRules();
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("a valid answer becomes the active set (download)", async () => {
    rpcAnswer = async () => validAnswer(3);
    await consumerCall();
    expect(rpcCalls).toEqual(["user-a"]);
    expect(store.getActiveSenderRules()).toMatchObject({ version: 3, source: "download" });
  });

  it("RS10 no session: no RPC, nothing recorded; once signed in, the next minute fetches once", async () => {
    session = null;
    await consumerCall();
    expect(getAuthSession).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([]);
    session = { userId: "user-a" };
    rpcAnswer = async () => fixture("pgrst202");
    await later(MINUTE);
    await consumerCall();
    expect(rpcCalls).toEqual(["user-a"]);
  });

  it("RS8b network down (transcribed, resolves) is offline: retried after 5 min, not 6 h", async () => {
    rpcAnswer = async () => fixture("down-refused");
    await consumerCall();
    expect(rpcCalls).toHaveLength(1);
    await later(MINUTE);
    await consumerCall();
    expect(rpcCalls).toHaveLength(1);
    await later(store.RETRY_AFTER_OFFLINE_MS);
    await consumerCall();
    expect(rpcCalls).toHaveLength(2);
  });

  it("RS9b a session read that never resolves times out at 10 s and does not block the next attempt", async () => {
    sessionHangs = true;
    await consumerCall();
    expect(getAuthSession).toHaveBeenCalledTimes(1);
    await later(FETCH_TIMEOUT_MS);
    sessionHangs = false;
    await later(MINUTE);
    await consumerCall();
    // The 30 s tick and the next consumer minute each start a fresh attempt.
    expect(getAuthSession.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("RS12 Sentry tags: version and source at start and on each change; no content", async () => {
    expect(setTag).toHaveBeenCalledWith("sender_rules_version", "1");
    expect(setTag).toHaveBeenCalledWith("sender_rules_source", "bundled");
    setTag.mockClear();
    rpcAnswer = async () => validAnswer(2);
    await consumerCall();
    expect(setTag.mock.calls).toEqual([
      ["sender_rules_version", "2"],
      ["sender_rules_source", "download"],
    ]);
    setTag.mockClear();
    rpcAnswer = async () => ({ ...fixture("valid-signed-in"), data: { version: 9, content: { ...v(9), extra: 1 } } });
    await later(store.REFRESH_INTERVAL_MS);
    await consumerCall();
    expect(setTag.mock.calls).toEqual([
      ["sender_rules_version", "2"],
      ["sender_rules_source", "cache_rejected"],
    ]);
  });

  it("RS13a (D1) an in-process account switch is seen through the session read: A's set leaves, one RPC for B", async () => {
    // A's answer arrives through the 30 s tick; the next tick is 6 h away, so
    // only the consumer-driven minute check can notice the switch below.
    rpcAnswer = async () => validAnswer(3);
    await later(30_000);
    expect(rpcCalls).toEqual(["user-a"]);
    expect(store.getActiveSenderRules()).toMatchObject({ version: 3, source: "download" });
    session = { userId: "user-b" };
    rpcAnswer = () => new Promise(() => undefined); // B's answer has not landed
    await later(MINUTE);
    await consumerCall();
    expect(store.getActiveSenderRules()).toMatchObject({ version: 1, source: "bundled" });
    expect(rpcCalls).toEqual(["user-a", "user-b"]);
  });

  it("RS13b B's missing RPC consumes B's 6 h throttle: 10 more minutes of calls, 0 more RPCs", async () => {
    session = { userId: "user-b" };
    rpcAnswer = async () => fixture("pgrst202");
    await consumerCall();
    expect(rpcCalls).toEqual(["user-b"]);
    const reads = getAuthSession.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      await later(MINUTE);
      await consumerCall();
    }
    expect(rpcCalls).toEqual(["user-b"]);
    expect(getAuthSession.mock.calls.length).toBeGreaterThanOrEqual(reads + 10);
  });

  it("with no consumer calls, the first tick (30 s) and the 6 h tick each fetch", async () => {
    rpcAnswer = async () => fixture("pgrst202");
    await later(30_000);
    expect(rpcCalls).toHaveLength(1);
    await later(store.REFRESH_INTERVAL_MS);
    expect(rpcCalls).toHaveLength(2);
  });
});
