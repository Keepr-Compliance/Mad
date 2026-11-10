/**
 * @jest-environment node
 *
 * BACKLOG-4219 PR2 — the Learn pilot report, built by the REAL builder from a
 * REAL run: runBaseline0 + scoreRunWithDetector over the REAL schema.sql on
 * the real driver, rows written with the sync's own insert statement
 * (helpers/storedEmail-4175.ts). Synthetic data only: "Canarytest" streets,
 * reserved domains.
 *
 *   REAL    the builder's output for the seeded profile equals the committed
 *           fixture fixtures/pilotReport-real-4219.json, which was WRITTEN BY
 *           THIS TEST (PILOT_FIXTURE_WRITE=1), not by hand. The same file is
 *           what was submitted to keepr-test's real submit RPC (pm_comments).
 *   KEYS    the report's keys, at every level, are exactly the migration
 *           header's list (20261112130000, validators transcribed below); the
 *           only strings are app_version, sender_rules_source and provider.
 *   P1      no "@" and no domain-shaped token anywhere, keys or values.
 *   C-FILL  every by_signal map carries all 7 names, zero-filled.
 *   C-DET   the detector block is decided on the detector surface: with
 *           bulkHeaders measured for Learn questions and OFF for the
 *           detector, learn_questions counts the bulk mail and detector does
 *           not (bundled modes cannot show this: both surfaces are equal).
 *   REFUSE  a report the server would refuse is not built.
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
import { scoreRunWithDetector, type SenderCensusInput } from "../scoring";
import { buildPilotReport, PILOT_SIGNALS, type PilotReport } from "../pilotReport";
import {
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  listDealContactEmails,
  listDealLinkedEmails,
} from "../../db/learnModeDbService";
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../../utils/senderFilter/senderFilter";
import { insertStoredEmail } from "../../__tests__/helpers/storedEmail-4175";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const FIXTURE = nodePath.join(__dirname, "fixtures", "pilotReport-real-4219.json");
const USER = "user-4219-p";
const NOW = Date.UTC(2026, 10, 1, 12);
const APP_VERSION = "2.46.2";
const UNSUB = { list_unsubscribe: "<mailto:unsub@list.example>" };

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();

let seq = 0;
function mail(
  sender: string,
  day: number,
  o: { body?: string; subject?: string; source?: "gmail" | "outlook"; accountId?: string | null; labels?: string[]; headers?: Record<string, string> } = {},
): string {
  seq += 1;
  const id = `e-4219p-${String(seq).padStart(3, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject: o.subject ?? "Hello",
    bodyPlain: o.body ?? "Lunch on Thursday?",
    sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    source: o.source,
    accountId: o.accountId,
    labels: o.labels,
    bulkMailHeaders: o.headers,
  });
  return id;
}
function dealMail(sender: string, address: string, day: number, o: Parameters<typeof mail>[2] = {}): string {
  return mail(sender, day, { subject: "Offer accepted", body: `Offer accepted on ${address}. Escrow closing, buyer inspection.`, ...o });
}
function deal(id: string, address: string): void {
  run(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at) VALUES (?, ?, ?, 'active', '2026-01-01', '2026-12-31')`,
    id,
    USER,
    address,
  );
}
let linkSeq = 0;
function link(txn: string, emailId: string): void {
  linkSeq += 1;
  const threadId = (db.prepare(`SELECT thread_id FROM emails WHERE id = ?`).get(emailId) as { thread_id: string }).thread_id;
  run(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
    `c-4219p-${linkSeq}`,
    USER,
    txn,
    emailId,
    threadId,
  );
}
function census(rules: SenderRuleSet): SenderCensusInput {
  return { rules, keep: buildKeepSets(listDealContactEmails(USER), rules), linked: listDealLinkedEmails(USER) };
}
async function baseline(rules: SenderRuleSet): Promise<LearnRunResult> {
  return runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: rules });
}
function scoreBoth(r: LearnRunResult, rules: SenderRuleSet) {
  return scoreRunWithDetector(r, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0, census(rules));
}

const A1 = "4219 Canarytest Way, Testville, ZZ 00000";
const A2 = "4220 Canarytest Way, Testville, ZZ 00000";

/** The seeded profile: one deal in two mailboxes, a bulk + a Promotions message on it, one unmatched deal answered Yes. */
async function seededReport(rules: SenderRuleSet = BUNDLED_SENDER_RULES): Promise<PilotReport> {
  deal("t1", A1);
  link("t1", dealMail("agent@client.example", A1, 1, { accountId: "acct-a" }));
  link("t1", mail("client@client.example", 2, { accountId: "acct-a" }));
  link("t1", mail("news@list.example", 3, { accountId: "acct-a", headers: UNSUB }));
  link("t1", mail("deals@shop.example", 4, { accountId: "acct-a", labels: ["CATEGORY_PROMOTIONS"] }));
  link("t1", mail("lender@bank.example", 5, { accountId: "acct-b", source: "outlook" }));
  dealMail("other@client.example", A2, 6, { accountId: "acct-a" });
  const r = await baseline(rules);
  const q = nextCleanupQuestion(USER, r);
  if (!q) throw new Error("precondition: one cleanup question");
  expect(answerCleanupQuestion(USER, r, q.detectionId, "yes")).toBe(true);
  const { score, detector } = scoreBoth(r, rules);
  const built = buildPilotReport(score, detector, APP_VERSION);
  if (!built.ok) throw new Error(`not built: ${built.reason}`);
  return built.report;
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'p@example.test', 'google', 'oa-p')`, USER);
  seq = 0;
  linkSeq = 0;
});
afterEach(() => db.close());

// ---- the server's key lists, transcribed from 20261112130000 -----------------
// _learn_pilot_report_invalid: v_ints || v_rates || ARRAY[...]
const TOP_KEYS = [
  "learn_rules_version", "sender_rules_version", "window_months", "rows_scanned", "null_sent_at",
  "labels_without_local_mail", "legacy_manual_positives", "detections", "true_detections", "known_wrong",
  "matched_neutral", "unmatched", "unmatched_deals", "unaskable", "seed_linked_to_deals", "positives", "found",
  "missed",
  "recall", "recall_with_cleanup_yes", "recall_excluding_legacy", "recall_with_cleanup_yes_excluding_legacy",
  "precision_before_cleanup", "precision_after_cleanup",
  "schema", "app_version", "sender_rules_source", "sender_rules_download_rejected", "deals_in_key", "cleanup",
  "hidden_by_seed", "side", "outcome", "bulk", "answers_by_rule_version", "census",
];
const NESTED: Record<string, string[]> = {
  deals_in_key: ["manual", "auto", "hybrid", "rejected"],
  cleanup: ["yes", "no", "unanswered"],
  hidden_by_seed: ["keys", "detections", "emails"],
  side: ["correct", "wrong", "not_predicted", "skipped"],
  outcome: ["scorable", "skipped", "predicted"],
  bulk: ["answered", "real_estate", "newsletter_spam", "skip", "not_cached", "newsletter_flagged", "real_estate_flagged"],
  census: ["learn_questions", "detector"],
};
// _learn_pilot_census_invalid
const CENSUS_KEYS = ["mailboxes", "min_linked_emails", "bulk_caught", "real_estate_suppressed", "found_deals_lost", "cleanup_yes_lost", "kept_by", "keep_conflicts", "coverage"];
const MAILBOX_KEYS = ["ordinal", "provider", "n", "full", "minus_contact_keeps", "address_pass_ready", "detector_ready"];
const SIGNALS = ["seedAddress", "approvedHost", "localPart", "bulkHeaders", "gmailPromotions", "gmailSocial", "gmailUpdates"];
const sorted = (a: string[]) => [...a].sort();
const keysOf = (o: unknown) => sorted(Object.keys(o as object));

/** Every [path, value] leaf of the report. */
function leaves(v: unknown, path = ""): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [[path, v]];
}
function allKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(allKeys);
  if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]);
  return [];
}

describe("REAL the builder's output on a seeded profile is the committed fixture", () => {
  it("equals pilotReport-real-4219.json (written by this test, never by hand)", async () => {
    const report = await seededReport();
    if (process.env.PILOT_FIXTURE_WRITE === "1") {
      fs.mkdirSync(nodePath.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(
        FIXTURE,
        JSON.stringify(
          {
            _source:
              "BACKLOG-4219 PR2: written by electron/services/learn/__tests__/pilotReport-4219.test.ts (REAL), " +
              "runBaseline0 + scoreRunWithDetector + buildPilotReport over schema.sql, synthetic seeded profile. Do not edit by hand.",
            report,
          },
          null,
          2,
        ) + "\n",
      );
    }
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { report: PilotReport };
    expect(report).toEqual(fixture.report);
    // The profile reached every part of the report it was seeded for.
    expect(report.positives).toBe(1);
    expect(report.found).toBe(1);
    expect(report.cleanup.yes).toBe(1);
    expect(report.census.learn_questions.mailboxes.map((m) => [m.ordinal, m.provider, m.n])).toEqual([
      [1, "gmail", 4],
      [2, "outlook", 1],
    ]);
    expect(report.census.learn_questions.mailboxes[0].full.by_signal.bulkHeaders).toBe(1);
    expect(report.census.learn_questions.mailboxes[0].full.by_signal.gmailPromotions).toBe(1);
  });
});

describe("KEYS exactly the server's keys, at every level", () => {
  it("top level, nested objects, census blocks, mailboxes, by_signal", async () => {
    const r = await seededReport();
    expect(keysOf(r)).toEqual(sorted(TOP_KEYS));
    for (const [k, want] of Object.entries(NESTED)) expect(keysOf((r as Record<string, unknown>)[k])).toEqual(sorted(want));
    for (const block of [r.census.learn_questions, r.census.detector]) {
      expect(keysOf(block)).toEqual(sorted(CENSUS_KEYS));
      expect(block.mailboxes.length).toBeGreaterThan(0);
      for (const m of block.mailboxes) {
        expect(keysOf(m)).toEqual(sorted(MAILBOX_KEYS));
        expect(keysOf(m.full.by_signal)).toEqual(sorted(SIGNALS));
        expect(keysOf(m.minus_contact_keeps.by_signal)).toEqual(sorted(SIGNALS));
      }
      expect(keysOf(block.coverage)).toEqual(["gmail", "outlook", "unknown"]);
    }
    expect(r.answers_by_rule_version.length).toBeGreaterThan(0);
    for (const a of r.answers_by_rule_version) expect(keysOf(a)).toEqual(["bulk", "deal", "rule_version"]);
    expect(sorted([...PILOT_SIGNALS])).toEqual(sorted(SIGNALS));
  });

  it("every leaf is an integer 0..10^7 or a boolean, except exactly three string slots", async () => {
    const r = await seededReport();
    const strings = leaves(r).filter(([, v]) => typeof v === "string");
    expect(new Set(strings.map(([p]) => p.replace(/\[\d+\]/g, "[]")))).toEqual(
      new Set(["app_version", "sender_rules_source", "census.learn_questions.mailboxes[].provider", "census.detector.mailboxes[].provider"]),
    );
    for (const [p, v] of leaves(r)) {
      if (typeof v === "string") continue;
      if (typeof v === "boolean") continue;
      expect([p, Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000]).toEqual([p, true]);
    }
  });

  it("P1 no '@' and no domain-shaped token in any key or string value", async () => {
    const r = await seededReport();
    const texts = [...allKeys(r), ...leaves(r).filter(([, v]) => typeof v === "string").map(([, v]) => v as string)];
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.filter((t) => t.includes("@") || /[a-z0-9-]+\.[a-z]{2,}/i.test(t))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/Canarytest|example|acct-|e-4219p|t1/);
  });
});

describe("C-FILL every by_signal map carries all 7 names", () => {
  it("one matched signal -> the other six are 0", async () => {
    const r = await seededReport();
    const outlook = r.census.learn_questions.mailboxes[1];
    expect(outlook.full.k).toBe(0);
    expect(outlook.full.by_signal).toEqual(Object.fromEntries(SIGNALS.map((s) => [s, 0])));
  });
});

describe("C-DET the detector block is decided on the detector surface", () => {
  it("bulkHeaders measured for Learn questions, OFF for the detector: 1 vs 0", async () => {
    const diverged: SenderRuleSet = {
      ...BUNDLED_SENDER_RULES,
      modes: {
        ...BUNDLED_SENDER_RULES.modes,
        bulkHeaders: { learnQuestions: "measure", addressPass: "off", detector: "off" },
        gmailPromotions: { learnQuestions: "measure", addressPass: "off", detector: "off" },
      },
    };
    const r = await seededReport(diverged);
    const lq = r.census.learn_questions.mailboxes[0].full;
    const det = r.census.detector.mailboxes[0].full;
    expect([lq.by_signal.bulkHeaders, lq.by_signal.gmailPromotions, lq.k]).toEqual([1, 1, 2]);
    expect([det.by_signal.bulkHeaders, det.by_signal.gmailPromotions, det.k]).toEqual([0, 0, 0]);
  });

  it("precondition: with the bundled modes the two blocks are equal (why C-DET needs diverged modes)", async () => {
    const r = await seededReport();
    expect(r.census.detector).toEqual(r.census.learn_questions);
  });
});

describe("REFUSE a report the server would refuse is not built", () => {
  it("a pre-release app version, and a negative count", async () => {
    deal("t1", A1);
    link("t1", dealMail("agent@client.example", A1, 1));
    const r = await baseline(BUNDLED_SENDER_RULES);
    const { score, detector } = scoreBoth(r, BUNDLED_SENDER_RULES);
    expect(buildPilotReport(score, detector, APP_VERSION).ok).toBe(true);
    expect(buildPilotReport(score, detector, "2.47.0-beta.1")).toEqual({ ok: false, reason: "app_version" });
    expect(buildPilotReport({ ...score, cleanupUnanswered: -1 }, detector, APP_VERSION)).toEqual({
      ok: false,
      reason: "cleanup.unanswered",
    });
  });
});
