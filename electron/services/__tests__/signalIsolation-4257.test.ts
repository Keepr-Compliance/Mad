/**
 * @jest-environment node
 *
 * BACKLOG-4257 (M3) PR2, SR R7 — Learn's signal measurement never sees the
 * user's own sender suppress list (BACKLOG-4212). Lives outside
 * services/learn/ because it names the list (the 4212 I1 pin scans that tree).
 *
 *   R7a pin: the signal modules (detectSignals/**, learn/signalScoring.ts,
 *       db/learnSignalsDb.ts, db/learnSignalsSql.ts, db/dealContactEmailsDb.ts)
 *       never name the list or its service. Positive control: the same
 *       scanner finds the token in userSuppressService.ts.
 *   R7b equality: one signal pass, wired exactly as learn:score wires it, is
 *       identical with the list empty and with a deal sender on it. The bulk
 *       answers are the same in both; only "Stop hiding" is undone. Positive
 *       control: the sender IS on the list in the second pass.
 *
 * Real driver, real schema.sql; synthetic "Canarytest" streets, reserved domains.
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

import { runBaseline0 } from "../learn/baselineRunner";
import { scoreSignals, vendorRoleDomains, type SignalScore } from "../learn/signalScoring";
import {
  answerBulk,
  insertBulkSample,
  listAnswerKeyTransactions,
  listDealAnswers,
  listDealContactEmails,
} from "../db/learnModeDbService";
import { listDealVendorRoleEmails } from "../db/dealContactEmailsDb";
import { signalLoadersFor } from "../db/learnSignalsDb";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../utils/senderFilter/senderFilter";
import { buildUserSuppress } from "../userSuppressService";
import { insertStoredEmail } from "./helpers/storedEmail-4175";

const REPO = nodePath.join(__dirname, "..", "..", "..");
const TOKEN = /userSuppress/;
const SIGNAL_FILES = [
  ...fs
    .readdirSync(nodePath.join(REPO, "electron", "services", "detectSignals"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => nodePath.join("electron", "services", "detectSignals", f)),
  "electron/services/learn/signalScoring.ts",
  "electron/services/db/learnSignalsDb.ts",
  "electron/services/db/learnSignalsSql.ts",
  "electron/services/db/dealContactEmailsDb.ts",
];

describe("R7a pin: no signal module names the user list", () => {
  it("positive control: the scanner finds the token in userSuppressService.ts", () => {
    expect(TOKEN.test(fs.readFileSync(nodePath.join(REPO, "electron", "services", "userSuppressService.ts"), "utf8"))).toBe(true);
  });

  it("detectSignals/**, signalScoring, the signal loaders and the contact loader never name it", () => {
    expect(SIGNAL_FILES.length).toBeGreaterThanOrEqual(9);
    const offenders = SIGNAL_FILES.filter((f) => TOKEN.test(fs.readFileSync(nodePath.join(REPO, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

const USER = "user-4257-iso";
const NOW = Date.UTC(2026, 10, 1, 12);
const LISTED = "agent@list.example";
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();
let seq = 0;

function mail(sender: string, day: number, subject: string, body: string): string {
  seq += 1;
  const id = `e-4257i-${String(seq).padStart(3, "0")}`;
  insertStoredEmail(db, { id, userId: USER, sender, subject, bodyPlain: body, sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z` });
  return id;
}
const dealMail = (sender: string, address: string, day: number) =>
  mail(sender, day, `Offer accepted on ${address}`, `Offer accepted on ${address}. Escrow closing, buyer inspection.`);

function linkToDeal(txn: string, emailId: string, n: number): void {
  run(`INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`, `c-4257i-${n}`, USER, txn, emailId, `th-${emailId}`);
}

/** Wired as learn:score wires it (learnModeHandlers.ts). */
async function signalPass(): Promise<SignalScore> {
  const rules = BUNDLED_SENDER_RULES;
  const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: rules });
  return scoreSignals({
    run: r,
    keyRows: listAnswerKeyTransactions(USER),
    dealAnswers: listDealAnswers(USER),
    ctx: {
      rules,
      keep: buildKeepSets(listDealContactEmails(USER), rules),
      vendorRoleDomains: vendorRoleDomains(listDealVendorRoleEmails(USER), rules),
    },
    loaders: signalLoadersFor(USER),
    yieldFn: noYield,
  });
}

describe("R7b the signal pass does not move when the user list does", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    db.pragma("foreign_keys = OFF");
    db.exec(fs.readFileSync(nodePath.join(REPO, "electron", "database", "schema.sql"), "utf8"));
    db.pragma("foreign_keys = ON");
    run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'iso@example.test', 'google', 'oa-iso')`, USER);
    seq = 0;
  });
  afterEach(() => db.close());

  it("identical with the list empty and with a deal sender on it", async () => {
    const A = "4280 Canarytest Way, Testville, ZZ 00000";
    run(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at) VALUES ('t-iso', ?, ?, 'active', '2026-01-01', '2026-12-31')`,
      USER,
      A,
    );
    linkToDeal("t-iso", dealMail(LISTED, A, 2), 1);
    linkToDeal("t-iso", dealMail("client@client.example", A, 3), 2);
    const digests = [5, 6, 7, 8].map((d) => mail(LISTED, d, "Weekly digest", "Weekly digest: listing and offer news, escrow tips."));
    insertBulkSample(USER, digests.map((id) => ({ source: "gmail" as const, external_id: `ext-${id}` })), 1);
    for (const r of db.prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ?`).all(USER) as Array<{ id: string }>) {
      expect(answerBulk(USER, r.id, "newsletter_spam")).toBe(true);
    }
    // "Stop hiding" for the sender: same answers, list empty.
    run(
      `INSERT INTO learn_sender_overrides (id, user_id, sender_key, created_at, updated_at) VALUES ('ov-iso', ?, ?, '2026-07-01', '2026-07-01')`,
      USER,
      LISTED,
    );
    expect([...buildUserSuppress(USER, BUNDLED_SENDER_RULES)]).toEqual([]);
    const before = await signalPass();
    expect(before.emails.dealLinked).toBe(2);
    expect(before.emails.newsletter).toBe(4);

    run(`UPDATE learn_sender_overrides SET deleted_at = '2026-07-02' WHERE id = 'ov-iso'`);
    // Positive control: the sender IS on the user's list now.
    expect([...buildUserSuppress(USER, BUNDLED_SENDER_RULES)]).toEqual([LISTED]);
    const after = await signalPass();
    expect(after).toEqual(before);
  });
});
