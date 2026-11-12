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
import type { LearnScore, SenderCensus } from "../learn/scoring";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const FIXTURE = nodePath.join(__dirname, "..", "learn", "__tests__", "fixtures", "pilotReport-real-4219.json");
const A = "user-4219-a";
const B = "user-4219-b";
const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 12);

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

/**
 * A LearnScore + detector census whose builder output is the REAL fixture's
 * report: the camelCase producer shape, mapped back from that file (not invented
 * numbers). Only senderRulesVersion varies per test.
 */
function scoreFromFixture(version = 1): { score: LearnScore; detector: SenderCensus } {
  const r = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).report;
  const rate = (x: { k: number; n: number }) => ({ k: x.k, n: x.n, interval: null });
  const block = (c: typeof r.census.learn_questions): SenderCensus => ({
    dealLinkedSuppressed: c.mailboxes.map((m: typeof c.mailboxes[number]) => ({
      label: m.ordinal === 0 ? "unknown mailbox" : `mailbox ${m.ordinal}`,
      provider: m.provider,
      n: m.n,
      full: { k: m.full.k, bySignal: m.full.by_signal },
      minusContactKeeps: { k: m.minus_contact_keeps.k, bySignal: m.minus_contact_keeps.by_signal },
      addressPassReady: m.address_pass_ready,
      detectorReady: m.detector_ready,
    })),
    minCensusLinkedEmails: c.min_linked_emails,
    bulkCaught: rate(c.bulk_caught),
    realEstateSuppressed: rate(c.real_estate_suppressed),
    foundDealsLost: { full: c.found_deals_lost.full, minusContactKeeps: c.found_deals_lost.minus },
    cleanupYesLost: { full: c.cleanup_yes_lost.full, minusContactKeeps: c.cleanup_yes_lost.minus },
    keptBy: c.kept_by,
    keepConflicts: c.keep_conflicts,
    coverage: c.coverage,
  });
  const score = {
    ruleVersion: r.learn_rules_version,
    windowMonths: r.window_months,
    earliestDay: null,
    latestDay: null,
    rowsScanned: r.rows_scanned,
    nullSentAt: r.null_sent_at,
    labelsWithoutLocalMail: r.labels_without_local_mail,
    buckets: r.deals_in_key,
    detections: r.detections,
    trueDetections: r.true_detections,
    knownWrong: r.known_wrong,
    matchedNeutral: r.matched_neutral,
    unmatched: r.unmatched,
    unmatchedDeals: r.unmatched_deals,
    unaskable: r.unaskable,
    cleanupYes: r.cleanup.yes,
    // Not in the report; the fixture's one Yes is on a street with no deal in the key.
    cleanupYesNotCounted: 0,
    cleanupNo: r.cleanup.no,
    cleanupUnanswered: r.cleanup.unanswered,
    hiddenBySeed: r.hidden_by_seed,
    seedLinkedToDeals: r.seed_linked_to_deals,
    answersByRuleVersion: r.answers_by_rule_version.map((a: { rule_version: number; deal: number; bulk: number }) => ({
      ruleVersion: a.rule_version,
      deal: a.deal,
      bulk: a.bulk,
    })),
    senderRulesVersion: version,
    senderRulesSource: r.sender_rules_source,
    senderRulesDownloadRejected: r.sender_rules_download_rejected,
    senderCensus: block(r.census.learn_questions),
    positives: r.positives,
    legacyManualPositives: r.legacy_manual_positives,
    legacyCutoffDay: "2026-01-01",
    legacyCutoffIsMinimum: false,
    found: r.found,
    missed: r.missed,
    recall: rate(r.recall),
    recallWithCleanupYes: rate(r.recall_with_cleanup_yes),
    recallExcludingLegacy: rate(r.recall_excluding_legacy),
    recallWithCleanupYesExcludingLegacy: rate(r.recall_with_cleanup_yes_excluding_legacy),
    precisionBeforeCleanup: rate(r.precision_before_cleanup),
    precisionAfterCleanup: rate(r.precision_after_cleanup),
    side: { correct: r.side.correct, wrong: r.side.wrong, notPredicted: r.side.not_predicted, skipped: r.side.skipped },
    outcome: r.outcome,
    bulk: {
      answered: r.bulk.answered,
      realEstate: r.bulk.real_estate,
      newsletterSpam: r.bulk.newsletter_spam,
      skip: r.bulk.skip,
      notCached: r.bulk.not_cached,
      newsletterFlagged: rate(r.bulk.newsletter_flagged),
      realEstateFlagged: rate(r.bulk.real_estate_flagged),
    },
  } as LearnScore;
  return { score, detector: block(r.census.detector) };
}

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
