/**
 * @jest-environment node
 *
 * BACKLOG-4013: a linked email is not a text thread. The Text count on a deal
 * (transactions.text_thread_count) used to add 1 per linked EMAIL row. Real writers
 * throughout: texts via batchInsertMessages, thread links via
 * createThreadCommunicationReferenceSync, email links via createCommunicationSync inside
 * dbTransaction (the emailLinkingHandlers shape) and linkEmailManuallySync (auto/approve).
 * R6 states the rule that must not be broken by the "obvious" wrong fix (dropping the
 * "thread has no messages" arm).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../../logService", () => {
  const m = { info: jest.fn().mockResolvedValue(undefined), warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined) };
  return { __esModule: true, default: m, logService: m };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb, dbTransaction } from "../core/dbConnection";
import * as C from "../communicationDbService";
import { batchInsertMessages } from "../syncDbService";
import { getTransactions, getTransactionById } from "../transactionDbService";
import { linkEmailManuallySync } from "../../autoLinkService";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8");
const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const THREAD = "thread-" + crypto.randomUUID();
const EMPTY_THREAD = "thread-empty-" + crypto.randomUUID();
const MSG = crypto.randomUUID();
const E1 = crypto.randomUUID(), E2 = crypto.randomUUID(), E3 = crypto.randomUUID(), E4 = crypto.randomUUID();
const ETA = "ethreadA-" + crypto.randomUUID();
const ETB = "ethreadB-" + crypto.randomUUID();

let db: DatabaseType;
const stored = () => (db.prepare("SELECT text_thread_count n FROM transactions WHERE id = ?").get(TXN) as { n: number | null }).n;

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')").run(USER);
  db.prepare("INSERT INTO transactions (id,user_id,property_address,started_at,closed_at) VALUES (?,?,?,?,?)").run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  setDb(db);
  batchInsertMessages([{ id: MSG, userId: USER, channel: "imessage", externalId: "ext-" + MSG, direction: "inbound", bodyText: "Are you free Thursday?", participants: JSON.stringify({ from: "+15555550100", to: ["me"] }), participantsFlat: "+15555550100", threadId: THREAD, sentAt: "2026-06-01T00:00:00.000Z", hasAttachments: 0, messageType: null, metadata: null }], 50);
  const ins = db.prepare(`INSERT INTO emails (id,user_id,subject,sender,body_plain,sent_at,created_at,thread_id) VALUES (?,?,'S','seller@example.com','x','2026-06-01T00:00:00.000Z',CURRENT_TIMESTAMP,?)`);
  ins.run(E1, USER, ETA); ins.run(E2, USER, ETA); ins.run(E3, USER, ETB); ins.run(E4, USER, null);
});
afterEach(() => { setDb(null as unknown as DatabaseType); db.close(); });

const linkEmail = (id: string, thread: string | null) =>
  dbTransaction(() => C.createCommunicationSync({ user_id: USER, transaction_id: TXN, email_id: id, thread_id: thread, communication_type: "email" } as never));

test("R1 one email with thread_id -> Text count 0", async () => {
  await linkEmail(E1, ETA);
  expect(stored()).toBe(0);
});
test("R2 two emails, same email thread -> 0", async () => {
  await linkEmail(E1, ETA); await linkEmail(E2, ETA);
  expect(stored()).toBe(0);
});
test("R3 three emails, two threads -> 0", async () => {
  await linkEmail(E1, ETA); await linkEmail(E2, ETA); await linkEmail(E3, ETB);
  expect(stored()).toBe(0);
});
test("R4 email without thread_id -> 0 (head already right)", async () => {
  await linkEmail(E4, null);
  expect(stored()).toBe(0);
});
test("R5 one text thread + two emails -> 1", async () => {
  C.createThreadCommunicationReferenceSync(THREAD, TXN, USER, "manual", 1);
  await linkEmail(E1, ETA); await linkEmail(E3, ETB);
  expect(stored()).toBe(1);
});
test("R6 thread link whose texts are not here yet -> 1 (must stay)", async () => {
  C.createThreadCommunicationReferenceSync(EMPTY_THREAD, TXN, USER, "manual", 1);
  expect(stored()).toBe(1);
});
test("R7 per-message text link -> 1 (must stay)", async () => {
  await C.createCommunicationReference({ user_id: USER, message_id: MSG, transaction_id: TXN } as never);
  expect(stored()).toBe(1);
});
test("R8 text thread link -> 1 (must stay)", async () => {
  C.createThreadCommunicationReferenceSync(THREAD, TXN, USER, "manual", 1);
  expect(stored()).toBe(1);
});
test("R9 email auto/manual link (no recount) then a text link recounts -> 1", async () => {
  expect(linkEmailManuallySync(E1, TXN, 0.95, "user_confirmed" as never)).toBe("linked");
  C.createThreadCommunicationReferenceSync(THREAD, TXN, USER, "manual", 1);
  expect(stored()).toBe(1);
});
test("R10 deal-card reader shows the stored count; email_count still counts emails", async () => {
  C.createThreadCommunicationReferenceSync(THREAD, TXN, USER, "manual", 1);
  await linkEmail(E1, ETA); await linkEmail(E3, ETB);
  const list = await getTransactions({ user_id: USER } as never);
  const row = list.find((t) => t.id === TXN) as unknown as { text_thread_count: number; email_count: number };
  const one = (await getTransactionById(TXN)) as unknown as { text_thread_count: number; email_count: number };
  expect(row.text_thread_count).toBe(1);
  expect(row.email_count).toBe(2);
  expect(one.text_thread_count).toBe(1);
});
test("R11 stale stored value: a deal read does NOT recount; next recount does", async () => {
  await linkEmail(E1, ETA);
  db.prepare("UPDATE transactions SET text_thread_count = 1 WHERE id = ?").run(TXN); // the value head leaves behind
  await getTransactions({ user_id: USER } as never); await getTransactionById(TXN);
  expect(stored()).toBe(1); // reads do not recount
  C.updateTransactionThreadCountSync(TXN); // rcsClear / syncDb refreshTextThreadCount
  expect(stored()).toBe(0);
});
test("R12 unlink the email -> 0", async () => {
  await linkEmail(E1, ETA);
  const id = (db.prepare("SELECT id FROM communications WHERE email_id = ?").get(E1) as { id: string }).id;
  await C.deleteCommunication(id);
  expect(stored()).toBe(0);
});
