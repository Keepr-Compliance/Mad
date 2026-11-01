/**
 * @jest-environment node
 *
 * BACKLOG-3968 PR-4b — A macOS FORCE RE-IMPORT KEEPS THE TEXTS A CHECKLIST
 * LINKS.
 *
 * A text member cascades on its message's removal (v78, by decision), and a
 * force re-import removes every macOS message of the user and re-adds a fresh
 * copy under a new id. Without protection every text link would silently go.
 * The macOS force set now spares a message that is a checklist text member —
 * the twin of the email force set's protection (`emailForceSetSql.ts`).
 *
 * Real path: `forceStagingLifecycle.create` + `swapStagingIntoLive` over the
 * production schema.sql, the same harness as `checklistForceReimport-3475`.
 * Assertions are exact sets: a wrong implementation differs by WHICH rows
 * survive.
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

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3968";
const THREAD = "macos-chat-3968";
const MACOS_META = JSON.stringify({ source: "macos_messages", originalId: 1, service: "iMessage" });

let db: DatabaseType;
const rows = (q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
const pluck = (q: string) => rows(q).map((r) => Object.values(r)[0]);

function insertMsg(table: string, id: string, guid: string): void {
  db.prepare(
    `INSERT INTO "${table}" (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata)
     VALUES (?, ?, 'imessage', ?, 'inbound', 'x', '{"from":"+15550100","to":["me"]}', ?, '2026-02-01T10:00:00Z', ?)`,
  ).run(id, USER, guid, THREAD, MACOS_META);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3968@example.test', 'google', 'oauth-3968')",
  ).run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '3 Test Street')").run(USER);
  // m-linked: a text a checklist links. m-plain: a text no checklist names.
  insertMsg("messages", "m-linked", "guid-linked");
  insertMsg("messages", "m-plain", "guid-plain");
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('c-thread', ?, 'txn-1', ?)").run(
    USER,
    THREAD,
  );
  db.prepare("INSERT INTO attachments (id, message_id, filename) VALUES ('a-linked', 'm-linked', 'photo.jpg')").run();
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 'txn-1', 'tpl', 'Residential')",
  ).run();
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i1', 'c1', 'Seller texts')").run();
  db.prepare(
    "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L-text', 'i1', 'text', 'Text · February 1, 2026')",
  ).run();
  db.prepare(
    "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('mm-text', 'L-text', 'text', 'm-linked')",
  ).run();
  setDb(db);
});

afterEach(() => db?.close());

describe("BACKLOG-3968 PR-4b — macOS force re-import and checklist texts", () => {
  it("the linked text survives with its member, group and attachment; the run's fresh copy of it is not added twice; other texts are replaced", () => {
    const staging = forceStagingLifecycle.create(db, USER);
    // The run fetches both texts again, under new ids.
    insertMsg(staging.messagesTable, "n-linked", "guid-linked");
    insertMsg(staging.messagesTable, "n-plain", "guid-plain");
    let swapError: string | null = null;
    try {
      swapStagingIntoLive(db, staging);
    } catch (e) {
      swapError = (e as Error).message;
    } finally {
      staging.drop();
    }

    expect(swapError).toBeNull();
    // The linked text is kept under its own id; its fresh copy yielded to it.
    // The unlinked text is replaced by the run's copy.
    expect(pluck("SELECT id FROM messages ORDER BY id")).toEqual(["m-linked", "n-plain"]);
    expect(pluck("SELECT link_id || ':' || message_id FROM transaction_checklist_link_members")).toEqual([
      "L-text:m-linked",
    ]);
    expect(pluck("SELECT id FROM transaction_checklist_links")).toEqual(["L-text"]);
    // The protected text's attachment is not cleared out from under it.
    expect(pluck("SELECT id FROM attachments WHERE message_id = 'm-linked'")).toEqual(["a-linked"]);
  });

  it("an attachment member (message_id NULL) beside the text member does not empty the force set", () => {
    // Every attachment and email member carries message_id NULL. A predicate
    // written as `id NOT IN (SELECT message_id ...)` is NULL for every row once
    // such a member exists, so nothing would be replaced. NOT EXISTS is not.
    db.prepare(
      "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L-file', 'i1', 'attachment', 'photo.jpg')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('mm-file', 'L-file', 'attachment', 'a-linked')",
    ).run();
    const staging = forceStagingLifecycle.create(db, USER);
    insertMsg(staging.messagesTable, "n-linked", "guid-linked");
    insertMsg(staging.messagesTable, "n-plain", "guid-plain");
    try {
      swapStagingIntoLive(db, staging);
    } finally {
      staging.drop();
    }
    expect(pluck("SELECT id FROM messages ORDER BY id")).toEqual(["m-linked", "n-plain"]);
    expect(pluck("SELECT id FROM transaction_checklist_link_members ORDER BY id")).toEqual(["mm-file", "mm-text"]);
  });

  it("once the group is removed, the next force re-import replaces that text like any other", () => {
    db.prepare("DELETE FROM transaction_checklist_links WHERE id = 'L-text'").run();
    const staging = forceStagingLifecycle.create(db, USER);
    insertMsg(staging.messagesTable, "n-linked", "guid-linked");
    insertMsg(staging.messagesTable, "n-plain", "guid-plain");
    try {
      swapStagingIntoLive(db, staging);
    } finally {
      staging.drop();
    }
    expect(pluck("SELECT id FROM messages ORDER BY id")).toEqual(["n-linked", "n-plain"]);
  });
});
