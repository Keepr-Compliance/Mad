/**
 * @jest-environment node
 *
 * BACKLOG-4219 PR2 — the pilot report send / withdraw queue, on the REAL
 * schema.sql and the real driver (the persisted switch, owed withdraw and
 * per-version throttle are real columns). The RPC and the auth user are
 * injected fakes; nothing here can reach the network.
 *
 *   P11  R1 one serial queue: a withdraw queued while a submit is in flight
 *        runs only after the submit settles, and is the last call; a submit
 *        queued after the switch went OFF never calls the RPC.
 *   P12  R3 owed withdraw for the SIGNED-IN user only; key lost ("blocked")
 *        with no renderer involved turns sharing off and withdraws; "unknown"
 *        (offline) does not.
 *   P13  D3 throttle per (user, sender-rules version).
 *   R7   the throttle survives a restart (a fresh service instance reads the
 *        persisted column); a failed submit records nothing.
 *   P6   an offline withdraw stays owed; the next check pays it exactly once.
 *   UNS  a timed-out submit -> the next withdraw is followed by one more, 60 s later.
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("electron", () => ({ app: { getVersion: () => "2.46.2" } }));
// The defaults are never used here (every test injects rpc / auth / feature state).
jest.mock("../supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../handlers/featureGateHandlers", () => ({
  AUTODETECT_EVAL_FEATURE_KEY: "autodetect_eval",
  resolveStrictFeatureState: jest.fn(async () => {
    throw new Error("default feature read used");
  }),
}));

import { createLearnPilotReportService, type PilotServiceOptions } from "../learnPilotReportService";
import { getPilotState, setLearnModeEnabled, setPilotOffPending, setPilotOn } from "../db/learnModeDbService";
import { scoreFromFixture, syntheticSignals } from "./helpers/pilotFixtureScore-4257";
import logService from "../logService";
import type { SignalScore } from "../learn/signalScoring";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const FIXTURE = nodePath.join(__dirname, "..", "learn", "__tests__", "fixtures", "pilotReport-real-4219.json");
const A = "user-4219-a";
const B = "user-4219-b";
const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 12);

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

// ---- injected world ------------------------------------------------------------
let clock = T0;
let authUser: string | null = A;
let feature: "allowed" | "blocked" | "unknown" = "allowed";
const calls: Array<{ name: string; user: string | null; report?: unknown }> = [];
type Answer = { error: { code?: string } | null };
let answer: (name: string) => Promise<Answer> = async () => ({ error: null });
const timers: Array<{ fn: () => void; ms: number }> = [];

function service(extra: PilotServiceOptions = {}) {
  return createLearnPilotReportService({
    now: () => clock,
    appVersion: () => "2.46.2",
    authUserId: async () => authUser,
    featureState: async () => feature,
    rpc: async (name, args) => {
      calls.push({ name, user: authUser, report: args?.p_report });
      return answer(name);
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    ...extra,
  });
}

function userRow(id: string, learnOn = true): void {
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`, id, `${id}@example.test`, `oa-${id}`);
  setLearnModeEnabled(id, learnOn);
}

function answerAt(user: string, iso: string): void {
  run(
    `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
     VALUES (?, ?, 'r1', ?, 'x', 'yes', ?, 2, ?, ?)`,
    `dla-${iso}`,
    user,
    `k-${iso}`,
    iso,
    iso,
    iso,
  );
}

const names = () => calls.map((c) => c.name.replace("learn_pilot_report_", ""));

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  userRow(A);
  userRow(B);
  clock = T0;
  authUser = A;
  feature = "allowed";
  calls.length = 0;
  timers.length = 0;
  answer = async () => ({ error: null });
});
afterEach(() => db.close());

describe("baseline", () => {
  it("switch OFF: a score sends nothing; ON: exactly one submit carrying the real report", async () => {
    const s = service();
    const { score, detector } = scoreFromFixture();
    await s.maybeSend(A, score, detector);
    expect(calls).toEqual([]);
    setPilotOn(A);
    await s.maybeSend(A, score, detector);
    expect(names()).toEqual(["submit"]);
    expect(calls[0].report).toEqual(JSON.parse(fs.readFileSync(FIXTURE, "utf8")).report);
  });
});

describe("P11 one serial queue per user (R1)", () => {
  it("withdraw queued during an in-flight submit runs after it settles and is the last call", async () => {
    setPilotOn(A);
    let release!: () => void;
    answer = (name) =>
      name.endsWith("submit") ? new Promise<Answer>((res) => (release = () => res({ error: null }))) : Promise.resolve({ error: null });
    const s = service();
    const { score, detector } = scoreFromFixture();
    const sending = s.maybeSend(A, score, detector);
    await new Promise((r) => setImmediate(r));
    expect(names()).toEqual(["submit"]); // in flight, unresolved
    setPilotOffPending(A);
    const withdrawing = s.queueWithdraw(A);
    await new Promise((r) => setImmediate(r));
    expect(names()).toEqual(["submit"]); // the withdraw waits
    release();
    await Promise.all([sending, withdrawing]);
    expect(names()).toEqual(["submit", "withdraw"]);
    expect(getPilotState(A)).toMatchObject({ enabled: false, pendingWithdraw: false, sentVersions: {} });
  });

  it("a submit queued behind an in-flight one, then OFF: the second submit never calls the RPC", async () => {
    setPilotOn(A);
    let release!: () => void;
    answer = (name) =>
      name.endsWith("submit") && !release
        ? new Promise<Answer>((res) => (release = () => res({ error: null })))
        : Promise.resolve({ error: null });
    const s = service();
    const first = s.maybeSend(A, scoreFromFixture(1).score, scoreFromFixture(1).detector);
    await new Promise((r) => setImmediate(r));
    const second = s.maybeSend(A, scoreFromFixture(2).score, scoreFromFixture(2).detector);
    setPilotOffPending(A);
    const w = s.queueWithdraw(A);
    release();
    await Promise.all([first, second, w]);
    expect(names()).toEqual(["submit", "withdraw"]);
  });

  it("OFF between the job's first check and the RPC: the re-read drops the submit", async () => {
    setPilotOn(A);
    let flip = true;
    const s = service({
      authUserId: async () => {
        if (flip) {
          flip = false;
          setPilotOffPending(A); // the user turns sharing off while the job is building
        }
        return authUser;
      },
    });
    await s.maybeSend(A, scoreFromFixture(1).score, scoreFromFixture(1).detector);
    expect(flip).toBe(false); // the job reached the auth read (past its first check)
    expect(calls).toEqual([]);
  });
});

describe("B1 a submit is only ever sent as the user it belongs to", () => {
  it("A shares; B signed in -> 0 calls; signed out -> 0 calls; A signed in -> exactly 1 submit as A", async () => {
    setPilotOn(A);
    const s = service();
    const v1 = scoreFromFixture(1);
    authUser = B;
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls).toEqual([]);
    authUser = null;
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls).toEqual([]);
    expect(getPilotState(A).sentVersions).toEqual({});
    authUser = A;
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls.map((c) => [c.name, c.user])).toEqual([["learn_pilot_report_submit", A]]);
  });
});

describe("P12 owed withdraw for the signed-in user only (R3)", () => {
  it("A owes, B signed in -> 0 calls; A signs in -> exactly 1, as A", async () => {
    setPilotOn(A);
    setPilotOffPending(A);
    const s = service();
    authUser = B;
    await s.tick();
    await s.checkPendingPilotWork(B);
    await s.checkPendingPilotWork(A); // not the signed-in user
    await s.idle(A);
    expect(calls).toEqual([]);
    expect(getPilotState(A).pendingWithdraw).toBe(true);
    authUser = A;
    await s.tick(); // a sign-in: the session user changed
    await s.idle(A);
    expect(calls).toEqual([{ name: "learn_pilot_report_withdraw", user: A, report: undefined }]);
    expect(getPilotState(A).pendingWithdraw).toBe(false);
  });

  it("key lost (blocked) at startup with no renderer: sharing OFF + withdraw; unknown (offline): nothing", async () => {
    setPilotOn(A);
    const s = service();
    feature = "unknown";
    await s.checkPendingPilotWork(A);
    await s.idle(A);
    expect(calls).toEqual([]);
    expect(getPilotState(A).enabled).toBe(true);
    feature = "blocked";
    await s.checkPendingPilotWork(A);
    await s.idle(A);
    expect(names()).toEqual(["withdraw"]);
    expect(getPilotState(A)).toMatchObject({ enabled: false, pendingWithdraw: false });
  });

  it("a sign-in is itself a trigger: signed out, then A signs in with sharing ON and the key lost -> withdraw", async () => {
    setPilotOn(A);
    feature = "blocked";
    const s = service();
    authUser = null;
    await s.tick();
    expect(calls).toEqual([]);
    authUser = A; // nothing owed yet: only the sign-in can start the check
    await s.tick();
    await s.idle(A);
    expect(names()).toEqual(["withdraw"]);
    expect(getPilotState(A)).toMatchObject({ enabled: false, pendingWithdraw: false });
  });

  it("the withdraw job itself refuses to run as another user", async () => {
    setPilotOn(A);
    setPilotOffPending(A);
    const s = service();
    authUser = B;
    await s.queueWithdraw(A);
    expect(calls).toEqual([]);
    expect(getPilotState(A).pendingWithdraw).toBe(true);
  });
});

describe("P13 throttle per (user, sender-rules version) (D3)", () => {
  it("v1 at t0; v2 at +1 h -> 1 submit; v2 again at +2 h -> 0", async () => {
    setPilotOn(A);
    const s = service();
    await s.maybeSend(A, scoreFromFixture(1).score, scoreFromFixture(1).detector);
    clock = T0 + 1 * H;
    await s.maybeSend(A, scoreFromFixture(2).score, scoreFromFixture(2).detector);
    expect(names()).toEqual(["submit", "submit"]);
    clock = T0 + 2 * H;
    await s.maybeSend(A, scoreFromFixture(2).score, scoreFromFixture(2).detector);
    expect(names()).toEqual(["submit", "submit"]);
  });

  it("flapping v2 -> v1 -> v2 within minutes: 2 submits, not 3", async () => {
    setPilotOn(A);
    const s = service();
    for (const [v, m] of [[2, 0], [1, 1], [2, 2]] as const) {
      clock = T0 + m * 60_000;
      await s.maybeSend(A, scoreFromFixture(v).score, scoreFromFixture(v).detector);
    }
    expect(calls.map((c) => (c.report as { sender_rules_version: number }).sender_rules_version)).toEqual([2, 1]);
  });

  it("same version after 6 h: only with a new answer, or after 24 h", async () => {
    setPilotOn(A);
    const s = service();
    const v1 = scoreFromFixture(1);
    await s.maybeSend(A, v1.score, v1.detector);
    clock = T0 + 7 * H;
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls).toHaveLength(1);
    answerAt(A, new Date(T0 + 6 * H).toISOString());
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls).toHaveLength(2);
    clock = T0 + 7 * H + 24 * H;
    await s.maybeSend(A, v1.score, v1.detector);
    expect(calls).toHaveLength(3);
  });

  it("at most 5 versions are remembered; the oldest send is evicted", async () => {
    setPilotOn(A);
    const s = service();
    for (let v = 1; v <= 6; v++) {
      clock = T0 + v * 60_000;
      await s.maybeSend(A, scoreFromFixture(v).score, scoreFromFixture(v).detector);
    }
    expect(Object.keys(getPilotState(A).sentVersions).sort()).toEqual(["2", "3", "4", "5", "6"]);
  });
});

describe("R7 the throttle survives a restart", () => {
  it("a fresh service instance reads the persisted versions: no second submit within 6 h", async () => {
    setPilotOn(A);
    const v1 = scoreFromFixture(1);
    await service().maybeSend(A, v1.score, v1.detector);
    clock = T0 + 1 * H;
    await service().maybeSend(A, v1.score, v1.detector); // "after the restart"
    expect(calls).toHaveLength(1);
    expect(getPilotState(A).sentVersions).toEqual({ "1": new Date(T0).toISOString() });
  });

  it("a refused or timed-out submit records nothing, so the next score sends", async () => {
    setPilotOn(A);
    const v1 = scoreFromFixture(1);
    answer = async () => ({ error: { code: "42501" } });
    await service().maybeSend(A, v1.score, v1.detector);
    expect(getPilotState(A).sentVersions).toEqual({});
    answer = () => new Promise<Answer>(() => undefined); // never settles
    await service({ timeoutMs: 5 }).maybeSend(A, v1.score, v1.detector);
    expect(getPilotState(A)).toMatchObject({ sentVersions: {}, unsettledAt: new Date(T0).toISOString() });
    answer = async () => ({ error: null });
    await service().maybeSend(A, v1.score, v1.detector);
    expect(calls).toHaveLength(3);
    expect(Object.keys(getPilotState(A).sentVersions)).toEqual(["1"]);
  });
});

describe("P6 an offline withdraw stays owed and is paid once", () => {
  it("fails -> pending 1; next startup online -> exactly 1 withdraw, pending 0", async () => {
    setPilotOn(A);
    setPilotOffPending(A);
    answer = async () => ({ error: { code: "PGRST000" } });
    await service().queueWithdraw(A);
    expect(getPilotState(A).pendingWithdraw).toBe(true);
    answer = async () => ({ error: null });
    calls.length = 0;
    const s = service();
    await s.tick();
    await s.idle(A);
    await s.tick(); // same user, retry window not reached
    await s.idle(A);
    expect(names()).toEqual(["withdraw"]);
    expect(getPilotState(A).pendingWithdraw).toBe(false);
  });
});

describe("B2 a timed-out withdraw stays owed and is retried", () => {
  it("timeout -> pending 1, sent versions kept; the next check pays exactly 1 withdraw", async () => {
    setPilotOn(A);
    const v1 = scoreFromFixture(1);
    await service().maybeSend(A, v1.score, v1.detector);
    const sent = getPilotState(A).sentVersions;
    expect(Object.keys(sent)).toEqual(["1"]);
    setPilotOffPending(A);
    answer = (name) => (name.endsWith("withdraw") ? new Promise<Answer>(() => undefined) : Promise.resolve({ error: null }));
    await service({ timeoutMs: 5 }).queueWithdraw(A);
    expect(getPilotState(A)).toMatchObject({ pendingWithdraw: true, sentVersions: sent });
    answer = async () => ({ error: null });
    calls.length = 0;
    const s = service();
    await s.tick();
    await s.idle(A);
    expect(names()).toEqual(["withdraw"]);
    expect(getPilotState(A)).toMatchObject({ pendingWithdraw: false, sentVersions: {} });
  });
});

describe("UNS an unsettled submit gets one more withdraw 60 s after the next one", () => {
  it("timeout -> OFF -> withdraw -> one extra withdraw scheduled at 60 s", async () => {
    setPilotOn(A);
    answer = () => new Promise<Answer>(() => undefined);
    const v1 = scoreFromFixture(1);
    await service({ timeoutMs: 5 }).maybeSend(A, v1.score, v1.detector);
    answer = async () => ({ error: null });
    setPilotOffPending(A);
    const s = service();
    await s.queueWithdraw(A);
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    timers[0].fn();
    await s.idle(A);
    expect(names()).toEqual(["submit", "withdraw", "withdraw"]);
    expect(getPilotState(A).unsettledAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-4257 PR B — signals (schema 2) in the submit job.
//   C4  thunk absent / null / throws / rejects / complete:false / pending past
//       the timeout -> the RPC payload is the schema-1 report (the REAL fixture)
//   C6  sharing off / not due -> the thunk is never called; due -> once, schema 2
//   C7  switch OFF while the thunk is pending -> no submit
//   C8  22023 on schema 2 -> ONE schema-1 resend, recorded once; 42501 -> none;
//       R7 (i) both refused -> exactly 2 calls, nothing recorded; (ii) switch OFF
//       or another user between refusal and resend -> no resend; (iii) schema-2
//       timeout -> no resend, the unsettled mark is set
//   LOG the refusal logs its code and a key-name DETAIL only
// ---------------------------------------------------------------------------
describe("4257 signals in the submit job", () => {
  const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8")).report;
  const schemaOf = (i: number) => (calls[i].report as { schema: number }).schema;
  const sendWith = async (thunk: (() => Promise<SignalScore | null>) | undefined, extra: PilotServiceOptions = {}) => {
    setPilotOn(A);
    const s = service({ signalsTimeoutMs: 30, ...extra });
    const { score, detector } = scoreFromFixture();
    await s.maybeSend(A, score, detector, thunk);
    return s;
  };

  describe("C4 no usable signals -> the schema-1 payload, JSON-identical", () => {
    it.each([
      ["absent", undefined],
      ["null", async () => null],
      ["throws", () => {
        throw new Error("boom");
      }],
      ["rejects", async () => Promise.reject(new Error("boom"))],
      ["complete:false", async () => syntheticSignals(1, { complete: false, stoppedBy: "time" })],
      ["pending past the timeout", () => new Promise<SignalScore>(() => undefined)],
      ["settles after the timeout", () => new Promise<SignalScore>((res) => setTimeout(() => res(syntheticSignals(1)), 120))],
    ])("%s", async (_name, thunk) => {
      await sendWith(thunk as (() => Promise<SignalScore | null>) | undefined);
      expect(names()).toEqual(["submit"]);
      expect(JSON.stringify(calls[0].report)).toBe(JSON.stringify(fixture()));
      expect(Object.keys(getPilotState(A).sentVersions)).toEqual(["1"]);
    });

    it("a complete pass -> schema 2 whose base is the schema-1 payload", async () => {
      const thunk = jest.fn(async () => syntheticSignals(2));
      await sendWith(thunk);
      expect(thunk).toHaveBeenCalledTimes(1);
      expect(names()).toEqual(["submit"]);
      expect(schemaOf(0)).toBe(2);
      const { signals, ...rest } = calls[0].report as Record<string, unknown>;
      expect(signals).toBeDefined();
      expect(JSON.stringify({ ...rest, schema: 1 })).toBe(JSON.stringify(fixture()));
    });
  });

  describe("R5 the signals race timer is cleared", () => {
    it("a pass that settles in time leaves no timer behind", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
      try {
        setPilotOn(A);
        const s = service({ signalsTimeoutMs: 25_000 });
        const { score, detector } = scoreFromFixture();
        await s.maybeSend(A, score, detector, async () => syntheticSignals(1));
        expect(schemaOf(0)).toBe(2);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("C6 the thunk runs only once a report is due", () => {
    it("sharing off -> 0 calls; not due -> 0 calls; due -> 1", async () => {
      const thunk = jest.fn(async () => syntheticSignals(1));
      const s = service();
      const { score, detector } = scoreFromFixture();
      await s.maybeSend(A, score, detector, thunk);
      expect(thunk).toHaveBeenCalledTimes(0);
      setPilotOn(A);
      await s.maybeSend(A, score, detector, thunk);
      expect(thunk).toHaveBeenCalledTimes(1);
      clock += H; // sent an hour ago: not due
      await s.maybeSend(A, score, detector, thunk);
      expect(thunk).toHaveBeenCalledTimes(1);
      expect(names()).toEqual(["submit"]);
    });
  });

  describe("C7 the switch re-read happens after the pass", () => {
    it("OFF while the thunk is pending -> no submit", async () => {
      setPilotOn(A);
      let release!: (s: SignalScore) => void;
      const s = service({ signalsTimeoutMs: 5_000 });
      const { score, detector } = scoreFromFixture();
      const sending = s.maybeSend(A, score, detector, () => new Promise<SignalScore>((res) => (release = res)));
      await new Promise((r) => setImmediate(r));
      expect(release).toBeDefined();
      setPilotOffPending(A);
      release(syntheticSignals(1));
      await sending;
      expect(calls).toEqual([]);
    });
  });

  describe("C8/R7 the 22023 fallback", () => {
    const refuse = (first: string, then: string | null = null) => {
      let n = 0;
      answer = async () => {
        n += 1;
        const code = n === 1 ? first : then;
        return { error: code === null ? null : { code, details: "signals: values.anchor" } };
      };
    };

    it("22023 on schema 2 -> one schema-1 resend (the fixture), recorded once", async () => {
      refuse("22023");
      await sendWith(async () => syntheticSignals(1));
      expect(names()).toEqual(["submit", "submit"]);
      expect([schemaOf(0), schemaOf(1)]).toEqual([2, 1]);
      expect(JSON.stringify(calls[1].report)).toBe(JSON.stringify(fixture()));
      expect(Object.keys(getPilotState(A).sentVersions)).toEqual(["1"]);
    });

    it("42501 on schema 2 -> no resend, nothing recorded", async () => {
      refuse("42501");
      await sendWith(async () => syntheticSignals(1));
      expect(names()).toEqual(["submit"]);
      expect(getPilotState(A).sentVersions).toEqual({});
    });

    it("22023 on schema 1 (no signals) -> no resend", async () => {
      refuse("22023");
      await sendWith(undefined);
      expect(names()).toEqual(["submit"]);
      expect(getPilotState(A).sentVersions).toEqual({});
    });

    it("(i) the resend is refused too -> exactly 2 calls, nothing recorded", async () => {
      refuse("22023", "22023");
      await sendWith(async () => syntheticSignals(1));
      expect(names()).toEqual(["submit", "submit"]);
      expect(getPilotState(A).sentVersions).toEqual({});
    });

    it("(ii) switch OFF between the refusal and the resend -> no resend", async () => {
      answer = async () => {
        setPilotOffPending(A);
        return { error: { code: "22023" } };
      };
      await sendWith(async () => syntheticSignals(1));
      expect(names()).toEqual(["submit"]);
    });

    it("(ii) another user signed in between the refusal and the resend -> no resend", async () => {
      answer = async () => {
        authUser = B;
        return { error: { code: "22023" } };
      };
      await sendWith(async () => syntheticSignals(1));
      expect(names()).toEqual(["submit"]);
    });

    it("(iii) schema-2 timeout -> no resend, the unsettled mark is set", async () => {
      answer = () => new Promise<Answer>(() => undefined);
      await sendWith(async () => syntheticSignals(1), { timeoutMs: 20 });
      expect(names()).toEqual(["submit"]);
      expect(getPilotState(A).unsettledAt).not.toBeNull();
      expect(getPilotState(A).sentVersions).toEqual({});
    });

    it("LOG code + a key-name DETAIL only; a DETAIL with a value shape is dropped", async () => {
      const warn = logService.warn as jest.Mock;
      warn.mockClear();
      refuse("22023", "42501");
      await sendWith(async () => syntheticSignals(1));
      const refused = warn.mock.calls.filter((c) => c[0] === "Learn pilot submit refused").map((c) => c[2]);
      expect(refused).toEqual([
        { code: "22023", schema: 2, detail: "signals: values.anchor" },
        { code: "42501", schema: 1 },
      ]);
      warn.mockClear();
      calls.length = 0;
      clock += 30 * H;
      answer = async () => ({ error: { code: "22023", details: "seller@example.test" } });
      await sendWith(undefined);
      expect(warn.mock.calls.filter((c) => c[0] === "Learn pilot submit refused").map((c) => c[2])).toEqual([
        { code: "22023", schema: 1 },
      ]);
    });
  });
});
