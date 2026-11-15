/**
 * @jest-environment node
 *
 * BACKLOG-4212 PR2 — Learn's run, score and pilot never see the user's own
 * suppress list (SR R5). Learn calls decide() on the "detector" surface too, so
 * "U1 is off on learnQuestions" does NOT protect it; the only guard is that the
 * list is never passed in. Two halves:
 *
 *   I1  pin: no file under electron/services/learn/** names `userSuppress`, and
 *       learnModeHandlers.ts (learn:score, the pilot report) does not import
 *       userSuppressService. Positive control: the same scanner finds the token
 *       in userSuppressService.ts.
 *   I2  equality: a run + score (with the detector census the pilot reads) is
 *       identical before and after the user gives the newsletter answers that
 *       list a deal sender. Positive control: that sender IS on the list.
 *
 * Real driver, real schema.sql; synthetic "Canarytest" streets and reserved domains.
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

import { runBaseline0, type LearnRunResult } from "../learn/baselineRunner";
import { scoreRunWithDetector } from "../learn/scoring";
import {
  answerBulk,
  insertBulkSample,
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  listDealContactEmails,
  listDealLinkedEmails,
} from "../db/learnModeDbService";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../utils/senderFilter/senderFilter";
import { buildUserSuppress } from "../userSuppressService";
import { insertStoredEmail } from "./helpers/storedEmail-4175";

const REPO = nodePath.join(__dirname, "..", "..", "..");
const LEARN_DIR = nodePath.join(REPO, "electron", "services", "learn");
const TOKEN = /userSuppress/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("I1 pin: nothing in Learn names the user list", () => {
  it("positive control: the scanner finds the token in userSuppressService.ts", () => {
    const svc = nodePath.join(REPO, "electron", "services", "userSuppressService.ts");
    expect(TOKEN.test(fs.readFileSync(svc, "utf8"))).toBe(true);
  });

  it("no file under electron/services/learn/** contains `userSuppress`", () => {
    const files = walk(LEARN_DIR);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => TOKEN.test(fs.readFileSync(f, "utf8"))).map((f) => nodePath.relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  it("learnModeHandlers.ts (learn:score, pilot report) does not import userSuppressService", () => {
    const text = fs.readFileSync(nodePath.join(REPO, "electron", "handlers", "learnModeHandlers.ts"), "utf8");
    expect(text).toMatch(/learn:score/);
    expect(text).not.toMatch(/userSuppressService/);
    expect(text).not.toMatch(TOKEN);
  });
});

const USER = "user-4212-iso";
const NOW = Date.UTC(2026, 10, 1, 12);
const LISTED = "agent@list.example";
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();
let seq = 0;

function mail(sender: string, day: number, subject: string, body: string): string {
  seq += 1;
  const id = `e-4212i-${String(seq).padStart(3, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject,
    bodyPlain: body,
    sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`,
  });
  return id;
}
const dealMail = (sender: string, address: string, day: number) =>
  mail(sender, day, "Offer accepted", `Offer accepted on ${address}. Escrow closing, buyer inspection.`);

function linkToDeal(txn: string, emailId: string, n: number): void {
  const threadId = (db.prepare(`SELECT thread_id FROM emails WHERE id = ?`).get(emailId) as { thread_id: string }).thread_id;
  run(`INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`, `c-4212i-${n}`, USER, txn, emailId, threadId);
}

async function runAndScore(): Promise<unknown> {
  const rules = BUNDLED_SENDER_RULES;
  const r: LearnRunResult = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: rules });
  const census = { rules, keep: buildKeepSets(listDealContactEmails(USER), rules), linked: listDealLinkedEmails(USER) };
  const scored = scoreRunWithDetector(r, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0, census);
  const { runId: _runId, ...rest } = r;
  // Answering the sample legitimately grows the bulk sample's denominator (n); everything else,
  // including how many sample messages the filter catches (k), must not move.
  const { bulkCaught, ...detector } = scored.detector;
  const { bulkCaught: scoreBulk, ...scoreCensus } = scored.score.senderCensus;
  return { run: rest, detector, detectorBulkCaught: bulkCaught.k, scoreCensus, scoreBulkCaught: scoreBulk.k };
}

describe("I2 Learn's numbers do not move when the user list does", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    db.pragma("foreign_keys = OFF");
    db.exec(fs.readFileSync(nodePath.join(REPO, "electron", "database", "schema.sql"), "utf8"));
    db.pragma("foreign_keys = ON");
    run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'iso@example.test', 'google', 'oa-iso')`, USER);
    seq = 0;
  });
  afterEach(() => db.close());

  it("run, detector census and deal losses are identical with and without the list", async () => {
    const A = "4280 Canarytest Way, Testville, ZZ 00000";
    run(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at) VALUES ('t-iso', ?, ?, 'active', '2026-01-01', '2026-12-31')`,
      USER,
      A,
    );
    linkToDeal("t-iso", dealMail(LISTED, A, 2), 1);
    linkToDeal("t-iso", dealMail("client@client.example", A, 3), 2);
    dealMail(LISTED, "4281 Canarytest Way, Testville, ZZ 00000", 4);
    const n1 = mail(LISTED, 5, "Weekly digest", "Weekly digest");
    const n2 = mail(LISTED, 6, "Weekly digest", "Weekly digest");

    const before = await runAndScore();

    insertBulkSample(USER, [n1, n2].map((id) => ({ source: "gmail" as const, external_id: `ext-${id}` })), 1);
    for (const r of db.prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ?`).all(USER) as Array<{ id: string }>) {
      expect(answerBulk(USER, r.id, "newsletter_spam")).toBe(true);
    }
    // Positive control: the sender IS on the user's list now.
    expect([...buildUserSuppress(USER, BUNDLED_SENDER_RULES)]).toEqual([LISTED]);

    const after = await runAndScore();
    expect(after).toEqual(before);
  });
});
