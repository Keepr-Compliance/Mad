/**
 * @jest-environment node
 *
 * BACKLOG-3475 — A MESSAGE FORCE RE-IMPORT TAKES THE CHECKLIST LINK WITH THE
 * ATTACHMENT.
 *
 * The companion to `checklistForceRecache-3475.test.ts`, on the message side.
 * Two real paths, one suite:
 *
 *   macOS force re-import   `forceStagingLifecycle.create` +
 *                           `swapStagingIntoLive` over the production
 *                           `schema.sql` — the real staging swap, not a
 *                           stand-in DELETE.
 *   Android clear           `syncDbService.deleteMessagesByMetadataSource`.
 *
 * Both delete `messages` rows, which cascade to their `attachments`, which must
 * cascade to checklist link members and take the emptied group with them.
 *
 * Assertions are exact `group:target` sets, for the reason given at length in
 * the email suite: the wrong implementations differ by WHICH rows survive.
 *
 * The attachment-FK mutants show up here in a way they cannot on the email
 * side: with the FK declared but without `ON DELETE CASCADE`, the macOS swap
 * and the Android clear both throw `FOREIGN KEY constraint failed` — a user
 * whose checklist references one photo can no longer re-import their messages
 * at all. `macOSMessagesImportService.stageAndSwap-2790` (8/8) and
 * `forceStagingRealSchema-2790` (7/7) stay green through it.
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
import { deleteMessagesByMetadataSource } from "../db/syncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3475";
const THREAD = "macos-chat-3475";
const MACOS_META = JSON.stringify({ source: "macos_messages", originalId: 1, service: "iMessage" });
const ANDROID_META = JSON.stringify({ source: "android_wifi_sync" });

let db: DatabaseType;
const rows = (q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
const memberSet = () =>
  rows(
    `SELECT link_id || ':' || COALESCE(email_id, attachment_id) AS k FROM transaction_checklist_link_members ORDER BY k`,
  ).map((r) => r.k);
const linkSet = () => rows(`SELECT id FROM transaction_checklist_links ORDER BY id`).map((r) => r.id);
const dangling = () =>
  (
    db.prepare(
      `SELECT COUNT(*) AS n FROM transaction_checklist_link_members m
        WHERE (m.attachment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = m.attachment_id))
           OR (m.email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.id = m.email_id))`,
    ).get() as { n: number }
  ).n;

function insertMsg(table: string, id: string, guid: string, meta: string, thread = THREAD): void {
  db.prepare(
    `INSERT INTO "${table}" (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata)
     VALUES (?, ?, 'imessage', ?, 'inbound', 'x', '{"from":"+15550100","to":["me"]}', ?, '2026-02-01T10:00:00Z', ?)`,
  ).run(id, USER, guid, thread, meta);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3475@example.test', 'google', 'oauth-3475')",
  ).run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '2 Test Street')").run(
    USER,
  );
  insertMsg("messages", "m1", "guid-1", MACOS_META);
  insertMsg("messages", "m-android", "guid-a", ANDROID_META, "android-thread");
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('c-thread', ?, 'txn-1', ?)").run(
    USER,
    THREAD,
  );
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id) VALUES ('c-android', ?, 'txn-1', 'm-android')").run(
    USER,
  );
  db.prepare(
    "INSERT INTO attachments (id, message_id, filename) VALUES ('a-mac', 'm1', 'photo.jpg'), ('a-android', 'm-android', 'scan.pdf')",
  ).run();
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 'txn-1', 'tpl', 'Residential')",
  ).run();
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i1', 'c1', 'Inspection report')").run();
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L-mac', 'i1', 'attachment', 'photo.jpg'), ('L-android', 'i1', 'attachment', 'scan.pdf')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('mm1', 'L-mac', 'attachment', 'a-mac'), ('mm2', 'L-android', 'attachment', 'a-android')`,
  ).run();
  // BACKLOG-3476 (F-2, regression cover): a SECOND checklist on the same
  // transaction, linking the same two attachments. Its links go the same way.
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES ('c2', 'txn-1', 'tpl-2', 'Disclosures', 1)",
  ).run();
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i2', 'c2', 'Disclosure photo')").run();
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L2-mac', 'i2', 'attachment', 'photo.jpg'), ('L2-android', 'i2', 'attachment', 'scan.pdf')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('mm3', 'L2-mac', 'attachment', 'a-mac'), ('mm4', 'L2-android', 'attachment', 'a-android')`,
  ).run();
  setDb(db);
});

afterEach(() => db?.close());

describe("BACKLOG-3475 — message force paths remove checklist attachment members", () => {
  it("macOS force re-import swap, then Android clear: members gone with their attachments, groups gone, nothing dangles", () => {
    const staging = forceStagingLifecycle.create(db, USER);
    insertMsg(staging.messagesTable, "n1", "guid-1", MACOS_META);
    let swapError: string | null = null;
    try {
      swapStagingIntoLive(db, staging);
    } catch (e) {
      swapError = (e as Error).message;
    } finally {
      staging.drop();
    }

    // The swap must SUCCEED. An FK without ON DELETE CASCADE makes it throw,
    // which is the user's force button breaking outright.
    expect(swapError).toBeNull();
    expect(rows("SELECT id FROM messages WHERE id='m1'").length).toBe(0);
    // The macOS attachment went with its message; the Android one is untouched.
    expect(memberSet()).toEqual(["L-android:a-android", "L2-android:a-android"]);
    expect(linkSet()).toEqual(["L-android", "L2-android"]);
    expect(dangling()).toBe(0);

    let androidError: string | null = null;
    try {
      deleteMessagesByMetadataSource(USER, "android_wifi_sync");
    } catch (e) {
      androidError = (e as Error).message;
    }

    expect(androidError).toBeNull();
    expect(memberSet()).toEqual([]);
    expect(linkSet()).toEqual([]);
    expect(dangling()).toBe(0);
  });
});
