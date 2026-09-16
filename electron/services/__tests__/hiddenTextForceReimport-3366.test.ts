/**
 * @jest-environment node
 */
/*
 * BACKLOG-3366 C4 / C4b — a hidden text stays hidden, and can still be unhidden,
 * across a macOS force re-import.
 *
 * A force re-import deletes the live macOS message rows and inserts the rebuild
 * under NEW random ids (`macOSMessagesImportService.ts`, `crypto.randomUUID()`),
 * while thread links (`communications.thread_id`, no message_id) survive. A
 * hide keyed on `messages.id` alone would silently stop matching and the text
 * would return to the export.
 *
 * Not simulated: this drives the real `forceStagingLifecycle.create` and
 * `swapStagingIntoLive` over the production `schema.sql`, the harness of
 * `forceStagingRealSchema-2790.test.ts`. The live rows carry the importer's
 * provenance stamp (`metadata.source = "macos_messages"`, BACKLOG-2796); without
 * it the force set spares them, the old id survives, and the external-id arm is
 * never exercised — so the swap's deletion of the old row is asserted first.
 *
 * The hide goes through `hideTextFromExport`, so a service that stored no
 * external id (or took it from the caller) fails C4.
 *
 * Run under Electron's node:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { forceStagingLifecycle, swapStagingIntoLive } from "../macOSMessagesImportService/forceStaging";
import { setDb } from "../db/core/dbConnection";
import {
  createThreadCommunicationReference,
  getCommunicationsWithMessages,
} from "../db/communicationDbService";
import { hideTextFromExport, unhideTextFromExport } from "../db/hiddenTextDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3366-reimport";
const TXN = "txn-3366-reimport";
const THREAD = "macos-chat-3366";
// The importer's own metadata shape.
const MACOS_META = JSON.stringify({ source: "macos_messages", originalId: 1, service: "iMessage" });

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "reimport-3366@example.test", "oauth-3366-reimport");
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(
    TXN,
    USER,
    "2 Test Street",
  );
  setDb(db);
});

afterEach(() => {
  db?.close();
});

const INSERT_COLUMNS =
  "(id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata)";

function insertInto(table: string, id: string, guid: string, body: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO "${table}" ${INSERT_COLUMNS} VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, ?, ?)`,
  ).run(id, USER, guid, body, JSON.stringify({ from: "+15550100", to: ["me"] }), THREAD, sentAt, MACOS_META);
}

const TEXTS: Array<[guid: string, body: string, sentAt: string]> = [
  ["guid-1", "one", "2026-02-01T10:00:00Z"],
  ["guid-2", "two", "2026-02-02T10:00:00Z"],
  ["guid-3", "three", "2026-02-03T10:00:00Z"],
];

async function markers(): Promise<Record<string, unknown>> {
  const rows = (await getCommunicationsWithMessages(TXN, "text")) as unknown as Array<{
    id: string;
    hidden_from_export: unknown;
  }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.hidden_from_export]));
}

/** Live m1..m3 on one thread link, m2 hidden through the service, then a real force re-import to n1..n3. */
async function hideThenReimport(): Promise<void> {
  TEXTS.forEach(([guid, body, sentAt], i) => insertInto("messages", `m${i + 1}`, guid, body, sentAt));
  await createThreadCommunicationReference(THREAD, TXN, USER, "manual");
  expect(await hideTextFromExport({ transactionId: TXN, messageId: "m2", userId: USER })).toBe(true);
  expect(await markers()).toEqual({ m1: 0, m2: 1, m3: 0 });

  const staging = forceStagingLifecycle.create(db, USER);
  TEXTS.forEach(([guid, body, sentAt], i) => insertInto(staging.messagesTable, `n${i + 1}`, guid, body, sentAt));
  const counts = swapStagingIntoLive(db, staging);
  staging.drop();

  // Precondition: the re-import really replaced the rows and kept the thread link.
  expect(counts.messagesDeleted).toBe(3);
  expect(counts.messagesInserted).toBe(3);
  expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'm2'").get() as { n: number }).n).toBe(0);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND thread_id = ?").get(TXN, THREAD) as { n: number }).n,
  ).toBe(1);
}

describe("BACKLOG-3366 — a hide survives a macOS force re-import", () => {
  it("C4 the re-imported copy of the hidden text (new id, same provider id) is still marked hidden", async () => {
    await hideThenReimport();
    expect(await markers()).toEqual({ n1: 0, n2: 1, n3: 0 });
  });

  it("C4b Unhide on the re-imported copy (new id) clears the hide", async () => {
    await hideThenReimport();
    expect(await unhideTextFromExport({ transactionId: TXN, messageId: "n2" })).toBe(1);
    expect(await markers()).toEqual({ n1: 0, n2: 0, n3: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_hidden_texts").get() as { n: number }).n).toBe(0);
  });
});
