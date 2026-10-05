/**
 * @jest-environment node
 *
 * BACKLOG-3733 PR-3 — thread links read only the linking user's message copies.
 *
 * One local database can hold several signed-in users. Each user has their own
 * copy of every message, and thread ids are shared across those copies. A
 * thread link (`communications.thread_id`, no `message_id`) must therefore join
 * only messages whose `user_id` matches the link's `user_id`, or every surface
 * that follows the link shows each user's copy.
 *
 * Corpus (two users, same provider thread ids, the other user's ids sort FIRST
 * so a first-wins pick lands on them when the owner term is missing):
 *   chat-shared   group "Closing Crew". Both users hold copies: 5 caption-less
 *                 photos (each copy with its own attachment row) and one text.
 *                 Linked ONLY by OWNER, to TXN_A.
 *   chat-other    group "Lender Group". Both users hold a copy of one text.
 *                 Linked ONLY by OTHER, to TXN_B.
 *
 * Run under Electron's node (the shared native module is Electron-ABI at rest):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/db/__tests__/threadUserScope-3733.test.ts
 *
 * Fixture values are invented and documentation-only.
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
import { createThreadCommunicationReference } from "../communicationDbService";
import { hideTextFromExport } from "../hiddenTextDbService";
import { getTransactionAllAttachments } from "../attachmentDbService";
import { prepareTextAttachmentCount } from "../attachmentAuditStatsSql";
import { GET_CHECKLIST_LINK_MEMBERS_SQL, targetsInTransactionSql } from "../checklistSql";
import { REMOVED_MESSAGES_SQL } from "../removedCommunicationSql";
import { getMessagesForContact } from "../contactDbService";
import {
  buildGlobalTextQuery,
  buildGlobalTextThreadNameQuery,
  buildTextQuery,
  buildTextThreadNameQuery,
  buildThreadNameAttributionQuery,
  buildUnattachedTextQuery,
  buildUnattachedTextThreadNameQuery,
} from "../transactionSearchDbService";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8");

const OWNER = "user-3733-owner";
const OTHER = "user-3733-other";
const TXN_A = "txn-3733-a";
const TXN_B = "txn-3733-b";
const PHOTOS = ["p1", "p2", "p3", "p4", "p5"];
/** The other user's copies use this prefix; "b-" sorts before every owner id. */
const OTHER_PREFIX = "b-";

let db: DatabaseType;

const GROUP = JSON.stringify({
  from: "+15550101",
  to: ["me", "+15550102"],
  chat_members: ["+15550101", "+15550102"],
});

function insertMessage(user: string, id: string, thread: string, at: string, body: string, photo: boolean): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
                           participants_flat, thread_id, sent_at, has_attachments)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, '+15550101, +15550102', ?, ?, ?)`,
  ).run(
    (user === OTHER ? OTHER_PREFIX : "") + id,
    user,
    `guid-${id}`,
    body,
    GROUP,
    thread,
    at,
    photo ? 1 : 0,
  );
  if (photo) {
    const msgId = (user === OTHER ? OTHER_PREFIX : "") + id;
    db.prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path)
       VALUES (?, ?, ?, ?, 'image/jpeg', 100, ?)`,
    ).run(`att-${msgId}`, msgId, `guid-${id}`, `${id}.jpg`, `/fixture/${msgId}.jpg`);
  }
}

async function seed(): Promise<void> {
  for (const u of [OWNER, OTHER]) {
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(u, `${u}@example.test`, `oauth-${u}`);
  }
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Fixture Way')",
  ).run(TXN_A, OWNER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '2 Fixture Way')",
  ).run(TXN_B, OTHER);

  // The other user's copies go in FIRST.
  for (const user of [OTHER, OWNER]) {
    PHOTOS.forEach((p, i) => insertMessage(user, p, "chat-shared", `2026-09-24T12:0${i}:00Z`, "", true));
    insertMessage(user, "t1", "chat-shared", "2026-09-24T12:10:00Z", "inspection report", false);
    insertMessage(user, "m2", "chat-other", "2026-09-24T13:00:00Z", "appraisal scheduled", false);
    db.prepare("INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)").run(
      user, "chat-shared", "Closing Crew",
    );
    db.prepare("INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)").run(
      user, "chat-other", "Lender Group",
    );
  }

  await createThreadCommunicationReference("chat-shared", TXN_A, OWNER, "manual");
  await createThreadCommunicationReference("chat-other", TXN_B, OTHER, "manual");
}

const ids = (rows: unknown[]): string[] => (rows as Array<{ id: string }>).map((r) => r.id).sort();
const run = (q: { sql: string; params: unknown[] }): unknown[] => db.prepare(q.sql).all(...q.params);

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  setDb(db);
  await seed();
});

afterEach(() => {
  db.close();
});

describe("BACKLOG-3733: thread links read only the linking user's copies", () => {
  it("fixture: both users hold copies of both threads", () => {
    const counts = db
      .prepare("SELECT user_id, COUNT(*) AS n FROM messages GROUP BY user_id ORDER BY user_id")
      .all();
    expect(counts).toEqual([
      { user_id: OTHER, n: 7 },
      { user_id: OWNER, n: 7 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 10 });
  });

  // Site: attachmentDbService.getTransactionAllAttachments (the Attachments tab)
  it("Attachments tab: 5 photos -> 5 rows, all the owner's", () => {
    const rows = getTransactionAllAttachments(TXN_A);
    expect(rows.map((r) => r.id).sort()).toEqual(PHOTOS.map((p) => `att-${p}`));
  });

  // Site: attachmentAuditStatsSql text arm
  it("attachment count counts only the owner's copies", () => {
    const row = prepareTextAttachmentCount(db, { hasStart: false, hasEnd: false }).get(TXN_A) as {
      count: number;
    };
    expect(row.count).toBe(5);
  });

  // Site: checklistSql targetsInTransactionSql (adding a checklist link)
  it("checklist link check accepts the owner's attachment and rejects the other user's", () => {
    const target = ["att-p1", `att-${OTHER_PREFIX}p1`];
    const rows = db.prepare(targetsInTransactionSql("attachment", 2)).all(...target, TXN_A, TXN_A);
    expect(ids(rows)).toEqual(["att-p1"]);
  });

  // Site: checklistSql GET_CHECKLIST_LINK_MEMBERS_SQL in_transaction
  it("checklist member flags the other user's attachment as not in the deal", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('cl', ?, 'tpl', 'Docs')",
    ).run(TXN_A);
    db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('it', 'cl', 'Photos')").run();
    db.prepare(
      "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('ln', 'it', 'attachment', 'Photos')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('m-own', 'ln', 'attachment', 'att-p1')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('m-oth', 'ln', 'attachment', ?)",
    ).run(`att-${OTHER_PREFIX}p1`);
    const rows = db.prepare(GET_CHECKLIST_LINK_MEMBERS_SQL).all("cl", "cl") as Array<{
      id: string;
      in_transaction: number;
    }>;
    expect(rows.map((r) => [r.id, r.in_transaction]).sort()).toEqual([
      ["m-oth", 0],
      ["m-own", 1],
    ]);
  });

  // Site: hiddenTextSql HIDE_TEXT_FROM_EXPORT_SQL eligibility
  it("hide: the other user's copy is not a text of this deal; the owner's is", async () => {
    expect(await hideTextFromExport({ transactionId: TXN_A, messageId: `${OTHER_PREFIX}t1`, userId: OWNER })).toBe(
      false,
    );
    expect(await hideTextFromExport({ transactionId: TXN_A, messageId: "t1", userId: OWNER })).toBe(true);
  });

  // Site: removedCommunicationSql REMOVED_MESSAGES_SQL (ignored_communications thread arm)
  it("removed-texts list shows only the owner's copies", () => {
    db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, reason) VALUES ('ic-1', ?, ?, 'chat-shared', 'test')",
    ).run(OWNER, TXN_A);
    const rows = db.prepare(REMOVED_MESSAGES_SQL).all(TXN_A) as Array<{ message_id: string }>;
    expect(rows.map((r) => r.message_id).sort()).toEqual([...PHOTOS, "t1"].sort());
  });

  // Site: transactionSearchDbService buildTextQuery
  it("deal search: texts from the owner's copies only", () => {
    expect(ids(run(buildTextQuery(TXN_A, "inspection", 50)))).toEqual(["t1"]);
  });

  // Site: transactionSearchDbService buildTextThreadNameQuery
  it("deal search by group name: the representative row is the owner's copy", () => {
    expect(ids(run(buildTextThreadNameQuery(TXN_A, "Closing")))).toEqual(["t1"]);
  });

  // Site: transactionSearchDbService GLOBAL_THREAD_LINKAGE_EXISTS
  it("global search: a thread linked only by another user is not linked for the owner", () => {
    expect(ids(run(buildGlobalTextThreadNameQuery(OWNER, "Lender")))).toEqual([]);
    expect(ids(run(buildGlobalTextThreadNameQuery(OWNER, "Closing")))).toEqual(["t1"]);
  });

  // Site: transactionSearchDbService buildThreadNameAttributionQuery
  it("global search: the owner's text is not attributed to another user's deal", () => {
    expect(run(buildThreadNameAttributionQuery("m2"))).toEqual([]);
    expect(run(buildThreadNameAttributionQuery("t1"))).toEqual([
      { attrTxnId: TXN_A, attrAddress: "1 Fixture Way" },
    ]);
  });

  // Site: transactionSearchDbService buildGlobalTextQuery attribution join
  it("global search: texts carry the owner's deal only", () => {
    const rows = run(buildGlobalTextQuery(OWNER, "appraisal", 50));
    expect(ids(rows)).toEqual([]);
    const own = run(buildGlobalTextQuery(OWNER, "inspection", 50)) as Array<{ id: string; attrTxnId: string }>;
    expect(own.map((r) => [r.id, r.attrTxnId])).toEqual([["t1", TXN_A]]);
  });

  // Site: transactionSearchDbService buildUnattachedTextThreadNameQuery
  it("unattached group names: a thread linked only by another user is unattached for the owner", () => {
    expect(ids(run(buildUnattachedTextThreadNameQuery(OWNER, "Lender")))).toEqual(["m2"]);
  });

  // Site: transactionSearchDbService buildUnattachedTextQuery
  it("unattached texts: a thread linked only by another user is unattached for the owner", () => {
    expect(ids(run(buildUnattachedTextQuery(OWNER, "appraisal", 50)))).toEqual(["m2"]);
  });

  // Site: contactDbService.getMessagesForContact transaction fallback (missed reader, B2)
  it("contact thread fallback: a thread linked only by another user is not attributed to that user's deal", async () => {
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name) VALUES ('contact-owner', ?, 'Lender Group Contact')",
    ).run(OWNER);
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES ('ph-owner-1', 'contact-owner', '+15550101', 1)",
    ).run();
    const threads = await getMessagesForContact("contact-owner");
    const chatOther = threads.find((t) => t.thread_id === "chat-other");
    const chatShared = threads.find((t) => t.thread_id === "chat-shared");
    // chat-other is linked only by OTHER, to TXN_B — must not come back attributed to it.
    expect(chatOther?.transaction_id).toBeUndefined();
    // chat-shared is linked by OWNER, to TXN_A — must still resolve.
    expect(chatShared?.transaction_id).toBe(TXN_A);
  });
});

