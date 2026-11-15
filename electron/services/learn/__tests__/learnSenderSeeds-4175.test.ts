/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR0 — exact sender seeds in the Learn cleanup pass, on the REAL
 * driver and the REAL schema.sql. Rows are written with the sync's own insert
 * statement (helpers/storedEmail-4175.ts).
 *
 *   P3  a client forward (From client@example.org) carrying a seed in the
 *       recipients and the body is NOT a seed message
 *   P4  a mixed detection (seed + ordinary sender) is still asked: the
 *       specific detection id comes back with nothing excluded
 *   P5  nothing is dropped before batchAnalyze: the seed rows form their
 *       detection, the detection count equals the unfiltered run's, and the
 *       score reports it as hidden
 *   P6  an all-seed detection cannot be answered; no row is written
 *   P9  seedLinkedToDeals counts non-rejected deals only
 *   P10 a cleanup answer is stamped the current rule_version (4 since the BACKLOG-4225 address filter)
 *   P11 hidden is per deal KEY: unanswered count, answered keys, hidden keys
 *   RV  the Copy block lists answers per rules version
 *
 * Synthetic data only: "Canarytest" streets, reserved domains for every
 * non-Zillow sender.
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { runBaseline0, type LearnRunResult } from "../baselineRunner";
import { answerCleanupQuestion, nextCleanupQuestion } from "../cleanupPass";
import { addressKey } from "../dealMatcher";
import { countSeedLinkedToDeals, formatCopyBlock, isHiddenBySenderRules, scoreRun, visibleEmailIds } from "../scoring";
import { EMPTY_CENSUS } from "../../__tests__/helpers/emptyCensus-4175";
import {
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  listDealLinkedSeedCandidates,
} from "../../db/learnModeDbService";
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../../../utils/senderFilter/bundledRules";
import { gmailFrom, insertStoredEmail, outlookFrom } from "../../__tests__/helpers/storedEmail-4175";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-4175-a";
const NOW = Date.UTC(2026, 10, 1, 12);
const SEED_A = "my-saved-home@mail.zillow.com";
const SEED_B = "recommendations@mail.zillow.com";
/** The bundled rules with the seed signal OFF: what the run looked like before PR0. */
const SEED_OFF: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  modes: { ...BUNDLED_SENDER_RULES.modes, seedAddress: { learnQuestions: "off", addressPass: "off", detector: "off" } },
};

/** The seed signal measured but not live for Learn questions. */
const SEED_MEASURE: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  modes: { ...BUNDLED_SENDER_RULES.modes, seedAddress: { learnQuestions: "measure", addressPass: "live", detector: "live" } },
};

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const get = (q: string, ...p: unknown[]) => db.prepare(q).get(...(p as never[])) as Record<string, unknown> | undefined;
const noYield = () => Promise.resolve();

let seq = 0;
function mail(sender: string, address: string, day: number, extra: { recipients?: string; body?: string } = {}): string {
  seq += 1;
  const id = `e-4175-${String(seq).padStart(3, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject: "Offer accepted",
    bodyPlain: extra.body ?? `Offer accepted on ${address}. Escrow closing, buyer inspection.`,
    sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    recipients: extra.recipients,
  });
  return id;
}

/** A saved-search alert as a seed sender sends it (synthetic text). */
function alert(seed: string, address: string, day: number, shape: "gmail" | "outlook" = "gmail"): string {
  const sender = shape === "gmail" ? gmailFrom("Zillow", seed) : outlookFrom("Zillow", seed);
  return mail(sender, address, day, {
    body: `Price cut on ${address}. New listing for sale, offer deadline Friday, escrow ready, buyer showing.`,
  });
}

function detectionOf(r: LearnRunResult, emailId: string) {
  const d = r.detections.find((x) => x.emailIds.includes(emailId));
  if (!d) throw new Error(`no detection holds ${emailId}`);
  return d;
}

function score(r: LearnRunResult) {
  return scoreRun(r, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0, EMPTY_CENSUS);
}

// BACKLOG-4225: state "WA" (ZIP still synthetic) in text the real extractor reads; it only takes a real US state code.
const A1 = "4175 Canarytest Way, Testville, WA 00000";
const A2 = "4176 Canarytest Way, Testville, WA 00000";
const A3 = "4177 Canarytest Way, Testville, WA 00000";

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  seq = 0;
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
describe("P5 nothing is dropped before batchAnalyze", () => {
  it("the seed rows form their detection; detection count unchanged; reported hidden", async () => {
    const s1 = alert(SEED_A, A1, 1);
    const s2 = alert(SEED_B, A1, 2, "outlook");
    const ordinary = mail("agent@example.com", A2, 3);

    // Precondition: with the seed signal off, the alerts DO form a detection.
    const before = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: SEED_OFF });
    expect(detectionOf(before, s1).emailIds.sort()).toEqual([s1, s2].sort());
    expect(detectionOf(before, ordinary).emailIds).toEqual([ordinary]);

    const after = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    expect(after.detections.length).toBe(before.detections.length);
    expect(after.realEstateCount).toBe(before.realEstateCount);
    expect(detectionOf(after, s1).seedEmailIds.sort()).toEqual([s1, s2].sort());
    const sc = score(after);
    expect(sc.detections).toBe(before.detections.length);
    expect(sc.hiddenBySeed).toEqual({ keys: 1, detections: 1, emails: 2 });
    expect(sc.cleanupUnanswered).toBe(1);
  });
});

describe("P3 only the From address counts", () => {
  it("a client forward with the seed in the recipients and the body is asked, with no seed ids", async () => {
    const fwd = mail(outlookFrom("Client", "client@example.org"), A1, 1, {
      recipients: `me@example.test, ${SEED_A}`,
      body: `---------- Forwarded message ---------\nFrom: Zillow <${SEED_A}>\nPrice cut on ${A1}. Offer accepted, escrow closing, buyer inspection.`,
    });
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    const d = detectionOf(r, fwd);
    expect(d.seedEmailIds).toEqual([]);
    expect(nextCleanupQuestion(USER, r)?.detectionId).toBe(d.id);
  });
});

describe("P4 a mixed detection is still asked", () => {
  it("returns the mixed detection's own id first, with nothing excluded", async () => {
    // The mixed detection is seen first, so it is the first candidate.
    const seed = alert(SEED_A, A1, 1);
    const agent = mail("agent@example.com", A1, 2);
    const other = mail("agent@example.com", A2, 3);
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    const mixed = detectionOf(r, seed);
    expect(mixed.emailIds.sort()).toEqual([seed, agent].sort());
    expect(mixed.seedEmailIds).toEqual([seed]);
    expect(detectionOf(r, other).id).not.toBe(mixed.id);
    expect(nextCleanupQuestion(USER, r)?.detectionId).toBe(mixed.id);
  });
});

describe("P6 an all-seed detection is never answered", () => {
  it("answer -> false and no row; an ordinary detection still answers", async () => {
    const seed = alert(SEED_A, A1, 1);
    const ordinary = mail("agent@example.com", A2, 2);
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    expect(answerCleanupQuestion(USER, r, detectionOf(r, seed).id, "no")).toBe(false);
    expect(Number(get(`SELECT COUNT(*) AS n FROM learn_deal_answers`)?.n)).toBe(0);
    expect(answerCleanupQuestion(USER, r, detectionOf(r, ordinary).id, "no")).toBe(true);
    expect(nextCleanupQuestion(USER, r)).toBeNull();
  });
});

describe("P10 answers are stamped with the new rules version", () => {
  it("a cleanup answer row has rule_version 4", async () => {
    const ordinary = mail("agent@example.com", A2, 1);
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    expect(answerCleanupQuestion(USER, r, detectionOf(r, ordinary).id, "yes")).toBe(true);
    expect(get(`SELECT rule_version FROM learn_deal_answers`)).toEqual({ rule_version: 4 });
  });
});

describe("P11 hidden is per deal key", () => {
  it("counts only askable unanswered keys; an answered hidden key stays answered", async () => {
    // K1: one all-seed detection and one mixed detection under ONE key (two
    // spellings that groupByProperty keeps apart and addressKey joins).
    const k1SeedOnly = mail(gmailFrom("Zillow", SEED_A), A1, 1, {
      body: "Price cut on 4175 Canarytest Way Testville WA 00000 offer escrow buyer closing",
    });
    const k1Seed = alert(SEED_B, A1, 2);
    const k1Agent = mail("agent@example.com", A1, 3);
    // K2: all-seed, answered "no" under rules v1.
    const k2 = alert(SEED_A, A2, 4);
    // K3: all-seed, unanswered.
    const k3 = alert(SEED_B, A3, 5);

    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    const d1a = detectionOf(r, k1SeedOnly);
    const d1b = detectionOf(r, k1Agent);
    // Preconditions: the shapes the fixture claims.
    expect(d1a.id).not.toBe(d1b.id);
    expect(d1a.addressKey).toBe(d1b.addressKey);
    expect(d1a.seedEmailIds).toEqual(d1a.emailIds);
    expect(d1b.emailIds.sort()).toEqual([k1Seed, k1Agent].sort());
    const k2Key = detectionOf(r, k2).addressKey as string;
    expect(k2Key).toBe(addressKey(A2));
    run(
      `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
       VALUES ('dla-4175-k2', ?, 'run-v1', ?, ?, 'no', '2026-10-01T00:00:00Z', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      USER,
      k2Key,
      A2,
    );
    expect(detectionOf(r, k3).seedEmailIds).toEqual([k3]);

    const sc = score(r);
    expect({
      unmatchedDeals: sc.unmatchedDeals,
      cleanupNo: sc.cleanupNo,
      cleanupUnanswered: sc.cleanupUnanswered,
      hiddenKeys: sc.hiddenBySeed.keys,
    }).toEqual({ unmatchedDeals: 3, cleanupNo: 1, cleanupUnanswered: 1, hiddenKeys: 1 });

    // The count and the pass agree: one question (K1, via its mixed detection), then done.
    const q = nextCleanupQuestion(USER, r);
    expect(q?.detectionId).toBe(d1b.id);
    expect(answerCleanupQuestion(USER, r, d1b.id, "yes")).toBe(true);
    expect(nextCleanupQuestion(USER, r)).toBeNull();
    expect(score(r).cleanupUnanswered).toBe(0);
  });
});

describe("P9 seed mail linked to deals: non-rejected deals only", () => {
  function deal(id: string, address: string, status: string, detectionStatus: string | null = null): void {
    run(
      `INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, ?, ?, ?)`,
      id,
      USER,
      address,
      status,
      detectionStatus,
    );
  }
  function link(txn: string, emailId: string): void {
    run(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
      `c-${emailId}`,
      USER,
      txn,
      emailId,
      `th-${emailId}`,
    );
  }

  it("one seed email on an active deal, one on a rejected deal, one on a detection-rejected deal -> 1", () => {
    deal("t-active", A1, "active");
    deal("t-rejected", A2, "rejected");
    deal("t-det-rejected", A3, "active", "rejected");
    const onActive = alert(SEED_A, A1, 1);
    link("t-active", onActive);
    link("t-rejected", alert(SEED_B, A2, 2));
    link("t-det-rejected", alert(SEED_A, A3, 3));
    // Not a seed: the seed address only as a display name / in the body.
    link("t-active", mail(`"${SEED_A}" <client@example.org>`, A1, 4));
    link("t-active", mail("agent@example.com", A1, 5));

    const rows = listDealLinkedSeedCandidates(USER, BUNDLED_SENDER_RULES.suppress.exactAddresses);
    expect(countSeedLinkedToDeals(rows, BUNDLED_SENDER_RULES)).toBe(1);
    expect(rows.map((x) => x.id)).toContain(onActive);
  });
});

describe("RV answers per rules version in the Copy block", () => {
  it("one v1 and one v4 deal answer, one v1 sample answer -> both versions listed", async () => {
    const ordinary = mail("agent@example.com", A2, 1);
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    run(
      `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
       VALUES ('dla-4175-v1', ?, 'run-v1', 'old key', 'old', 'no', '2026-10-01T00:00:00Z', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      USER,
    );
    run(
      `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, answered_at, rule_version, created_at, updated_at)
       VALUES ('lba-4175-v1', ?, 'gmail', ?, '2026-10-01T00:00:00Z', 'skip', '2026-10-01T00:00:00Z', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      USER,
      `ext-${ordinary}`,
    );
    expect(answerCleanupQuestion(USER, r, detectionOf(r, ordinary).id, "yes")).toBe(true);
    const block = formatCopyBlock(score(r));
    expect(block).toContain("Answers by rules version: v1 deal 1 / bulk 1, v4 deal 1 / bulk 0");
    expect(block).toContain("Hidden by live sender rules (sender rules v1): 0 deals, 0 detections, 0 emails");
  });
});

describe("MODE learnQuestions = measure records seeds and hides nothing", () => {
  it("seed ids recorded; the all-seed detection is asked; preview ids unfiltered; nothing reported hidden", async () => {
    const seed = alert(SEED_A, A1, 1);
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: SEED_MEASURE });
    const d = detectionOf(r, seed);
    expect(d.seedEmailIds).toEqual([seed]);
    expect(r.seedHidesQuestions).toBe(false);
    expect(isHiddenBySenderRules(r, d)).toBe(false);
    expect(visibleEmailIds(r, d)).toEqual([seed]);
    expect(nextCleanupQuestion(USER, r)?.detectionId).toBe(d.id);
    const sc = score(r);
    expect([sc.hiddenBySeed, sc.cleanupUnanswered]).toEqual([{ keys: 0, detections: 0, emails: 0 }, 1]);
  });
});
