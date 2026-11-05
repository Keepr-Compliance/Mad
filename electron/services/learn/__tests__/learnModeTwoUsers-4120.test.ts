/**
 * @jest-environment node
 *
 * BACKLOG-4120 — two accounts sharing ONE local database (one Mac profile).
 *
 * Every learn read is scoped by user_id. The single-user suites cannot tell a
 * scoped query from an unscoped one, so this file seeds a second user (OTHER)
 * with a row for every table the learn SQL touches and asserts USER sees none
 * of it. Real driver, real schema.sql. Synthetic data only.
 *
 *   T1 run scan (EMAIL_KEYSET_PAGE_SQL) excludes OTHER's mail
 *   T2 bulk draw (DRAW_BULK_CANDIDATES_SQL) draws only USER's messages
 *   T3 deal answers (LIST_DEAL_ANSWERS_SQL) exclude OTHER's
 *   T4 bulk answers (ANSWERED_BULK_WITH_TEXT_SQL) exclude OTHER's
 *   T5 preview by email id (PREVIEW_EMAILS_BY_IDS_SQL) refuses a foreign id
 *   T6 preview attachments (PREVIEW_ATTACHMENTS_SQL) refuses a foreign id
 *   T7 bulk-row preview and answer text resolve to USER's copy of a message
 *      that both accounts hold under one (source, external_id)
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
jest.mock("../../supabaseService", () => ({ __esModule: true, default: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { runBaseline0 } from "../baselineRunner";
import { ensureBulkSample } from "../bulkSample";
import {
  insertBulkSample,
  answerBulk,
  listAnsweredBulkWithText,
  listDealAnswers,
  previewAttachments,
  previewEmailForBulkRow,
  previewEmailsByIds,
} from "../../db/learnModeDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-4120-a";
const OTHER = "user-4120-b";
const NOW = Date.UTC(2026, 10, 1, 12);
const IN_WINDOW = "2026-10-01T10:00:00.000Z";
const USER_DEAL = "4120 Canarytest Lane, Testville, ZZ 00000";
const OTHER_DEAL = "99 Othertest Court, Testville, ZZ 00000";

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const get = (q: string, ...p: unknown[]) => db.prepare(q).get(...(p as never[])) as Record<string, unknown> | undefined;

function seedEmail(id: string, user: string, externalId: string, subject: string, body: string, account = `acct-${user}`): void {
  run(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, body_plain)
     VALUES (?, ?, ?, 'gmail', ?, ?, 'agent@example.test', 'me@example.test', ?, ?)`,
    id,
    user,
    externalId,
    account,
    subject,
    IN_WINDOW,
    body,
  );
}

function seedAttachment(id: string, emailId: string): void {
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes) VALUES (?, ?, 'doc.pdf', 'application/pdf', 10)`,
    id,
    emailId,
  );
}

const DEAL_BODY = (addr: string) => `Offer accepted on ${addr}. Escrow closing, buyer inspection.`;

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, OTHER);
});
afterEach(() => db.close());

describe("two accounts, one local database", () => {
  it("T1 the run scans and detects only USER's mail", async () => {
    // OTHER first, so any unscoped page would reach OTHER's rows first.
    seedEmail("e-o-1", OTHER, "ext-o-1", "Offer", DEAL_BODY(OTHER_DEAL));
    seedEmail("e-o-2", OTHER, "ext-o-2", "Hello", "Lunch on Friday?");
    seedEmail("e-u-1", USER, "ext-u-1", "Offer", DEAL_BODY(USER_DEAL));
    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: () => Promise.resolve() });
    expect(r.rowsScanned).toBe(1);
    const text = JSON.stringify(r.detections);
    expect(text).toContain("canarytest");
    expect(text).not.toContain("othertest");
  });

  it("T2 the bulk draw takes only USER's messages", () => {
    for (let i = 0; i < 5; i++) seedEmail(`e-o-${i}`, OTHER, `ext-o-${i}`, "x", "x");
    seedEmail("e-u-1", USER, "ext-u-1", "x", "x");
    seedEmail("e-u-2", USER, "ext-u-2", "x", "x");
    expect(ensureBulkSample(USER, 12, NOW)).toMatchObject({ sampleSize: 2, drawn: 2 });
    const rows = db.prepare(`SELECT user_id, external_id FROM learn_bulk_answers`).all() as Array<Record<string, string>>;
    expect(rows.every((x) => x.user_id === USER && x.external_id.startsWith("ext-u-"))).toBe(true);
  });

  it("T3 the deal answers USER reads exclude OTHER's", () => {
    const ins = (id: string, user: string, key: string, answer: string) =>
      run(
        `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
         VALUES (?, ?, 'run-1', ?, ?, ?, 'x', 1, 'x', 'x')`,
        id,
        user,
        key,
        key,
        answer,
      );
    ins("lda-u", USER, "key-user", "yes");
    ins("lda-o", OTHER, "key-other", "no");
    expect(listDealAnswers(USER)).toEqual([{ address_key: "key-user", answer: "yes", rule_version: 1 }]);
  });

  it("T4 the answered bulk rows USER reads exclude OTHER's", () => {
    seedEmail("e-u-1", USER, "ext-u-1", "User subject", "x");
    seedEmail("e-o-1", OTHER, "ext-o-1", "Other subject", "x");
    insertBulkSample(USER, [{ source: "gmail", external_id: "ext-u-1" }], 1);
    insertBulkSample(OTHER, [{ source: "gmail", external_id: "ext-o-1" }], 1);
    const ids = (db.prepare(`SELECT id, user_id FROM learn_bulk_answers`).all() as Array<Record<string, string>>);
    for (const row of ids) expect(answerBulk(row.user_id, row.id, "real_estate")).toBe(true);
    const got = listAnsweredBulkWithText(USER);
    expect(got.map((g) => g.subject)).toEqual(["User subject"]);
  });

  it("T5 previewing a foreign email id returns nothing; USER's own id returns its row", () => {
    seedEmail("e-u-1", USER, "ext-u-1", "User subject", "x");
    seedEmail("e-o-1", OTHER, "ext-o-1", "Other subject", "x");
    expect(previewEmailsByIds(USER, ["e-o-1"], 10)).toEqual([]);
    expect(previewEmailsByIds(USER, ["e-o-1", "e-u-1"], 10).map((r) => r.id)).toEqual(["e-u-1"]);
  });

  it("T6 previewing attachments of a foreign email id returns nothing", () => {
    seedEmail("e-u-1", USER, "ext-u-1", "x", "x");
    seedEmail("e-o-1", OTHER, "ext-o-1", "x", "x");
    seedAttachment("att-u-1", "e-u-1");
    seedAttachment("att-o-1", "e-o-1");
    expect(previewAttachments(USER, ["e-o-1"])).toEqual([]);
    expect(previewAttachments(USER, ["e-o-1", "e-u-1"]).map((r) => r.id)).toEqual(["att-u-1"]);
  });

  it("T7 a message held by both accounts under one provider key resolves to USER's copy", () => {
    // OTHER's copy has the LOWER emails.id, so an unscoped lookup picks it.
    seedEmail("e-0001", OTHER, "ext-shared", "Other copy", "x");
    seedEmail("e-0002", USER, "ext-shared", "User copy", "x");
    insertBulkSample(USER, [{ source: "gmail", external_id: "ext-shared" }], 1);
    const row = get(`SELECT id FROM learn_bulk_answers WHERE user_id = ?`, USER)!;
    expect(previewEmailForBulkRow(USER, String(row.id))?.id).toBe("e-0002");
    expect(answerBulk(USER, String(row.id), "real_estate")).toBe(true);
    expect(listAnsweredBulkWithText(USER).map((g) => g.subject)).toEqual(["User copy"]);
  });
});
