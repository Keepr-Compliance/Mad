/**
 * @jest-environment node
 */
/*
 * BACKLOG-3367 P8 — hiding a text keeps its body out of the export even when a
 * DUPLICATE of it exists.
 *
 * This is the one control that runs the REAL producer into the REAL resolver.
 * Everything else in this item mocks the read; here the rows come out of SQLite
 * over the production `schema.sql`, through `getCommunicationsWithMessages`,
 * and straight into `resolveExportPlan`.
 *
 * ## Why it cannot be an export-side test
 *
 * The shared read collapses duplicates by content BEFORE any export sees them,
 * so only one of the two copies is ever offered to the resolver. Which one was
 * decided by row order — and duplicates share `sent_at`, so the tie fell to
 * insertion order of the `communications` and `messages` rows. The user hid the
 * copy the Texts tab showed them; if the OTHER copy was the survivor, the export
 * received an unhidden row carrying the identical body, and the text the user
 * hid shipped anyway. No filter in the export plan can repair that: the hidden
 * copy was already discarded upstream.
 *
 * BACKLOG-3366 fixed it at the source with a hidden-wins rule. This suite is its
 * export-level control: it asserts the BODY is absent from the resolved plan,
 * which is the thing the recipient of the audit package would have read.
 *
 * Swept over both link orders and both hide choices (SR required change 6), so
 * for every shape one case is the copy the old first-wins rule would have
 * dropped. The precondition test proves the sweep reaches both outcomes.
 *
 * Run under Electron's node — the shared native module is Electron-ABI at rest:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  require("path").join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../core/dbConnection";
import {
  createCommunicationReference,
  createThreadCommunicationReference,
  getCommunicationsWithMessages,
} from "../communicationDbService";
import { hideTextFromExport } from "../hiddenTextDbService";
import { resolveExportPlan } from "../../exportPlan";
import type { Communication } from "../../../types/models";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-3367";
const T1 = "txn-3367-1";
const DUP_BODY = "Meet me at the property at four";
const SENT_AT = "2026-03-05T10:00:00Z";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "user-3367@example.test", "oauth-3367");
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(
    T1,
    USER,
    "27 Hidden Lane",
  );
  setDb(db);
});

afterEach(() => {
  db?.close();
});

/** A text row in the shape the macOS importer writes (guid as external_id). */
function insertText(id: string, thread: string, body: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, ?)`,
  ).run(id, USER, `guid-${id}`, body, JSON.stringify({ from: "+15550100", to: ["me"] }), thread, SENT_AT);
}

const linkMessage = (id: string) =>
  createCommunicationReference({ user_id: USER, message_id: id, transaction_id: T1, link_source: "manual" });
const linkThread = (thread: string) =>
  createThreadCommunicationReference(thread, T1, USER, "manual");
const hide = (id: string) =>
  hideTextFromExport({ transactionId: T1, messageId: id, userId: USER });

/** The real read, then the real resolver — the production chain end to end. */
async function resolvedPlan() {
  const comms = (await getCommunicationsWithMessages(T1, "text")) as unknown as Communication[];
  return {
    read: comms,
    plan: resolveExportPlan(
      {
        format: "folder",
        contentType: "both",
        attachmentType: "all",
        emailMode: "thread",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
      },
      comms,
    ),
  };
}

const bodies = (comms: Communication[]): string[] =>
  comms.map((c) => (c as { body_text?: string }).body_text || "");

const orders: Array<[string, [string, string]]> = [
  ["A first", ["A", "B"]],
  ["B first", ["B", "A"]],
];

describe("BACKLOG-3367 P8 — a hidden text's body never reaches the export, duplicates included", () => {
  it("precondition: with nothing hidden, the survivor follows insertion order", async () => {
    // Proves the sweep below reaches BOTH first-wins outcomes — for each shape,
    // one of the two hide cases is the copy the old rule would have dropped. A
    // sweep that always hid the survivor would pass on the broken build too.
    const survivors: string[] = [];

    for (const [, order] of orders) {
      db.exec("DELETE FROM communications; DELETE FROM messages;");
      for (const id of order) insertText(id, "chat-dup", DUP_BODY);
      await linkThread("chat-dup");
      const { read } = await resolvedPlan();
      survivors.push(read.map((r) => r.id as string).join(","));
    }

    for (const [, order] of orders) {
      db.exec("DELETE FROM communications; DELETE FROM messages;");
      insertText("A", "chat-a", DUP_BODY);
      insertText("B", "chat-b", DUP_BODY);
      for (const id of order) await linkMessage(id);
      const { read } = await resolvedPlan();
      survivors.push(read.map((r) => r.id as string).join(","));
    }

    expect(survivors).toEqual(["A", "B", "A", "B"]);
  });

  for (const [name, order] of orders) {
    for (const hidden of ["A", "B"]) {
      it(`one thread link, inserted ${name}, hide ${hidden}: the body is absent from the plan, count 1`, async () => {
        for (const id of order) insertText(id, "chat-dup", DUP_BODY);
        await linkThread("chat-dup");
        expect(await hide(hidden)).toBe(true);

        const { read, plan } = await resolvedPlan();

        // The read still returns the hidden copy — marking, never filtering.
        expect(read).toHaveLength(1);
        expect(read[0].id).toBe(hidden);
        expect(read[0].hidden_from_export).toBe(1);

        // And the export drops it. This is the assertion that matters: the
        // recipient of the audit package never reads that sentence.
        expect(plan.communications).toEqual([]);
        expect(bodies(plan.communications)).not.toContain(DUP_BODY);
        expect(plan.hiddenTextCount).toBe(1);
        expect(plan.hiddenTexts.map((c) => c.id)).toEqual([hidden]);
      });

      it(`two per-message links, linked ${name}, hide ${hidden}: the body is absent from the plan, count 1`, async () => {
        insertText("A", "chat-a", DUP_BODY);
        insertText("B", "chat-b", DUP_BODY);
        for (const id of order) await linkMessage(id);
        expect(await hide(hidden)).toBe(true);

        const { read, plan } = await resolvedPlan();

        expect(read).toHaveLength(1);
        expect(read[0].id).toBe(hidden);
        expect(read[0].hidden_from_export).toBe(1);

        expect(plan.communications).toEqual([]);
        expect(bodies(plan.communications)).not.toContain(DUP_BODY);
        expect(plan.hiddenTextCount).toBe(1);
      });
    }
  }

  it("a non-duplicate text beside a hidden duplicate still exports", async () => {
    // Guards the opposite error: a de-dup or filter change that swallows
    // unrelated rows would pass every assertion above.
    insertText("A", "chat-dup", DUP_BODY);
    insertText("B", "chat-dup", DUP_BODY);
    insertText("C", "chat-dup", "A different message entirely");
    await linkThread("chat-dup");
    expect(await hide("A")).toBe(true);

    const { plan } = await resolvedPlan();

    expect(plan.communications.map((c) => c.id)).toEqual(["C"]);
    expect(bodies(plan.communications)).toEqual(["A different message entirely"]);
    expect(plan.hiddenTextCount).toBe(1);
  });
});
