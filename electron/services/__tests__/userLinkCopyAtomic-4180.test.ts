/**
 * BACKLOG-4180 (founder ruling (a)) — the two USER-DRIVEN link paths are atomic.
 *
 * `confirmProposal` (Review duplicates, compare view) and
 * `linkSourceRecordToContact` (link-source search) used to commit the verdict
 * and the link even when copying the source's values failed (the copy was
 * swallowed). Now a failed copy rolls back the verdict, the link and any copied
 * values together, and the caller gets a retryable failure.
 *
 * Real better-sqlite3, the full `schema.sql`, real writers. The proposal is
 * filed by the real linking pass (a content match whose names disagree). The
 * copy failure is a real SQLite trigger on `contact_phones`, so the rollback
 * exercised is SQLite's own.
 *
 * Fixtures are fictional: 415 555-01xx and example.test.
 */

import path from "path";
import fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../db/core/dbConnection";
import { linkExternalContactsForUser } from "../contactSourceLinker";
import { confirmProposal } from "../contactLinkReview";
import { linkSourceRecordToContact, linkSourceRecordsToContact } from "../contactManualLink";
import { upsertFromMacOS, upsertFromOutlook } from "../db/externalContactDbService";
import { syncContactEmails } from "../db/contactDbService";
import { listPendingProposals, listVerdicts } from "../db/contactLinkReviewDbService";
import { LINK_COPY_FAILED_MESSAGE } from "../contactSourceValues";

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4180-atomic";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-4180-atomic')`,
  ).run(USER, "owner@example.test");
  setDb(db as never);
});

afterEach(() => db.close());

function addContact(id: string, name: string, emails: string[]): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)").run(id, USER, name);
  syncContactEmails(id, emails.map((email, i) => ({ email, is_primary: i === 0 })));
}

function failPhoneInsertsFor(contactId: string): void {
  db.exec(
    `CREATE TRIGGER fail_phone_4180 BEFORE INSERT ON contact_phones WHEN NEW.contact_id = '${contactId}'
     BEGIN SELECT RAISE(ABORT, 'forced phone insert failure'); END`,
  );
}

const count = (sql: string, ...p: unknown[]): number =>
  (db.prepare(sql).get(...p) as { n: number }).n;
const links = (contactId: string): number =>
  count("SELECT COUNT(*) AS n FROM contact_source_links WHERE contact_id = ?", contactId);
const phones = (contactId: string): number =>
  count("SELECT COUNT(*) AS n FROM contact_phones WHERE contact_id = ?", contactId);
const emails = (contactId: string): number =>
  count("SELECT COUNT(*) AS n FROM contact_emails WHERE contact_id = ?", contactId);

describe("confirmProposal: a failed value copy rolls back the whole answer", () => {
  function fileQuestion(): string {
    // Same email, different names: the pass files a name_mismatch question.
    addContact("c-1", "Pat Riverton", ["pat@example.test"]);
    upsertFromMacOS(USER, [
      { recordId: "r-1", name: "Robin Marsh", emails: ["pat@example.test"], phones: ["(415) 555-0141"] },
    ]);
    linkExternalContactsForUser(USER);
    const pending = listPendingProposals(USER);
    expect(pending.map((p) => [p.contact_id, p.source_record_id])).toEqual([["c-1", "r-1"]]);
    return pending[0].id;
  }

  it("no link, no values, no verdict, the question stays pending; a retry succeeds", () => {
    const proposalId = fileQuestion();
    const emailsBefore = emails("c-1");
    failPhoneInsertsFor("c-1");

    expect(confirmProposal(USER, proposalId)).toEqual({ ok: false, error: LINK_COPY_FAILED_MESSAGE });

    expect(links("c-1")).toBe(0);
    expect(phones("c-1")).toBe(0);
    expect(emails("c-1")).toBe(emailsBefore);
    expect(listVerdicts(USER)).toEqual([]);
    expect(listPendingProposals(USER).map((p) => p.id)).toEqual([proposalId]);

    db.exec("DROP TRIGGER fail_phone_4180");
    expect(confirmProposal(USER, proposalId)).toEqual({ ok: true, linked: true, alsoRejected: 0 });
    expect(links("c-1")).toBe(1);
    expect(phones("c-1")).toBe(1);
  });
});

describe("linkSourceRecordToContact: a failed value copy rolls back the whole link", () => {
  beforeEach(() => {
    addContact("c-2", "Dana Existing", ["dana@example.test"]);
    upsertFromOutlook(USER, [
      { external_record_id: "o-2", name: "Dana Existing", emails: ["dana.work@example.test"], phones: ["(415) 555-0142"], company: null },
      { external_record_id: "o-3", name: "Dana Existing", emails: ["dana.home@example.test"], phones: [], company: null },
    ] as never);
  });

  it("single record: copy_failed, and nothing written", () => {
    failPhoneInsertsFor("c-2");

    expect(linkSourceRecordToContact(USER, "c-2", "outlook", "o-2")).toEqual({ ok: false, reason: "copy_failed" });

    expect(links("c-2")).toBe(0);
    expect(phones("c-2")).toBe(0);
    expect(emails("c-2")).toBe(1); // only the contact's own address
    expect(listVerdicts(USER)).toEqual([]);
  });

  it("batch: the failing record writes nothing, the other links whole", () => {
    // o-2 carries a phone (fails); o-3 carries only an email (succeeds).
    failPhoneInsertsFor("c-2");

    const outcomes = linkSourceRecordsToContact(USER, "c-2", [
      { sourceType: "outlook", sourceRecordId: "o-2" },
      { sourceType: "outlook", sourceRecordId: "o-3" },
    ]);

    expect(outcomes).toEqual([{ ok: false, reason: "copy_failed" }, { ok: true, linkId: expect.any(String) }]);
    const linked = db
      .prepare("SELECT source_record_id AS r FROM contact_source_links WHERE contact_id = 'c-2'")
      .all() as Array<{ r: string }>;
    expect(linked.map((l) => l.r)).toEqual(["o-3"]);
    expect(phones("c-2")).toBe(0);
    expect(emails("c-2")).toBe(2); // own + o-3's
    expect(listVerdicts(USER).map((v) => v.source_record_id)).toEqual(["o-3"]);
  });
});
