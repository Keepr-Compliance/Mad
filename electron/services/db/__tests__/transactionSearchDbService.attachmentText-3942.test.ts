/**
 * @jest-environment node
 *
 * BACKLOG-3942 — does the deal email search read `attachments.text_content`?
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * The item was filed from a grep: `git grep -l text_content` did not list
 * `transactionSearchDbService.ts`, so "an address that appears only inside a
 * PDF would never find its email" was a claim about a TOKEN, not about the
 * property. This suite settles it by EXECUTION: real driver, real
 * `schema.sql`, the real `searchLinkedContent` entry point the IPC handler
 * calls (`transactionSearchHandlers.ts` → `searchLinkedContent(db, txnId, q)`).
 *
 * Same technique as `transactionSearchDbService.groupNameSearch-2816.test.ts`:
 * NOT the fake-db harness (BACKLOG-2848) — a fake `all()` ignores the WHERE
 * clause and would pass with any column list.
 *
 * Every address, name and filename here is invented for the fixture.
 *
 * ===========================================================================
 * THE FOUR EMAILS
 * ===========================================================================
 *   E1 — the probe. Subject, body, sender, recipients and attachment FILENAME
 *        all free of the address; the attachment's `text_content` contains it.
 *   E2 — positive control. Address in the BODY, no attachment.
 *   E3 — filename control (BACKLOG-1870). Address only in the attachment
 *        FILENAME; `text_content` is NULL (never extracted). NULL, not '', so
 *        a build that drops the COALESCE (`filename || NULL` is NULL) goes red
 *        here (SR R5).
 *   E6 — filename control with `text_content` = '' (extracted, no text). Both
 *        states exist in production, so both are covered.
 *   E4 — negative control. Nothing matches anywhere.
 *
 * The E1 assertion encodes the CLAIM (E1 is found): RED means the gap is real,
 * GREEN means there is no gap. The two fixture self-checks guard against
 * reading a seed bug as a gap.
 *
 * SCOPE A (founder ruling): only the DEAL-SCOPED email search reads
 * text_content. The global Emails group and the Unattached bucket stay
 * filename-only until the FTS5 follow-up, so there E1 / E5 are asserted NOT
 * found.
 *
 * ===========================================================================
 * MUTATION (run and recorded in the pm_comment)
 * ===========================================================================
 * Step 1 showed that widening the LIKE target from `a.filename` to
 * `(a.filename || char(10) || COALESCE(a.text_content,''))` flips E1 to found
 * with no change to the bound-parameter count. Step 2 applies it to the
 * deal-scoped builder only (EMAIL_ATTACHMENT_TEXT_MATCH /
 * EMAIL_MATCHED_ATTACHMENTS_TEXT_SELECT); the shared EMAIL_ATTACHMENT_MATCH
 * behind the global and unattached builders is unchanged.
 */

// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path so this
// suite exercises actual SQL. Same technique as the BACKLOG-2816 suite.
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";

import {
  searchLinkedContent,
  searchGlobalContent,
  type SearchableDb,
} from "../transactionSearchDbService";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = "u-3942";
const TXN = "t-3942";

/** Invented address. Nothing else in the fixture contains "larkspur". */
const ADDRESS = "4417 Larkspur Hollow Ct";
/** The query the user would type — a distinctive token of the address. */
const QUERY = "larkspur";

/** Subject / body / sender / recipients / filename text that cannot match QUERY. */
const NEUTRAL_SUBJECT = "Re: inspection timing";
const NEUTRAL_BODY = "Please see the attached and confirm the window works.";
const NEUTRAL_SENDER = "agent-one@example.test";
const NEUTRAL_RECIPIENTS = "agent-two@example.test";
const NEUTRAL_FILENAME = "scan_0417.pdf";

const E1 = "e-3942-text-only";
const E2 = "e-3942-body";
const E3 = "e-3942-filename";
const E4 = "e-3942-none";
const E6 = "e-3942-filename-empty-text";
/** Unlinked twin of E1 — drives buildUnattachedEmailQuery via the same predicate. */
const E5 = "e-3942-text-only-unattached";

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);

  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google',?)",
  ).run(USER, "me@example.test", "o-me");

  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?,?,?,?,?)`,
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

  const insertEmail = db.prepare(
    `INSERT INTO emails (id, user_id, subject, body_plain, sender, recipients, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z')`,
  );
  const addEmail = (id: string, body: string): void => {
    insertEmail.run(id, USER, NEUTRAL_SUBJECT, body, NEUTRAL_SENDER, NEUTRAL_RECIPIENTS);
  };

  // communications CHECK: email_id set, message_id NULL.
  const link = db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
     VALUES (?, ?, ?, ?, 'manual')`,
  );

  const insertAttachment = db.prepare(
    `INSERT INTO attachments (id, email_id, filename, mime_type, text_content)
     VALUES (?, ?, ?, 'application/pdf', ?)`,
  );

  // E1 — address ONLY inside the attachment's extracted text.
  addEmail(E1, NEUTRAL_BODY);
  insertAttachment.run(`a-${E1}`, E1, NEUTRAL_FILENAME, `Purchase agreement for ${ADDRESS}. Page 1 of 9.`);

  // E2 — positive control: address in the body, no attachment.
  addEmail(E2, `Offer accepted on ${ADDRESS}.`);

  // E3 — filename control (BACKLOG-1870): address only in the filename.
  addEmail(E3, NEUTRAL_BODY);
  insertAttachment.run(`a-${E3}`, E3, `${ADDRESS} - disclosure.pdf`, null);

  // E6 — filename control with text_content '' (extracted, no text).
  addEmail(E6, NEUTRAL_BODY);
  insertAttachment.run(`a-${E6}`, E6, `${ADDRESS} - survey.pdf`, "");

  // E4 — negative control: nothing matches anywhere.
  addEmail(E4, NEUTRAL_BODY);
  insertAttachment.run(`a-${E4}`, E4, NEUTRAL_FILENAME, "Nothing of note on this page.");

  for (const id of [E1, E2, E3, E4, E6]) link.run(`c-${id}`, USER, TXN, id);

  // E5 — E1's shape with NO communications row (Unattached bucket).
  addEmail(E5, NEUTRAL_BODY);
  insertAttachment.run(`a-${E5}`, E5, NEUTRAL_FILENAME, `Addendum regarding ${ADDRESS}.`);
}

describe("BACKLOG-3942 — attachment text_content as a deal email search target", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
  });

  afterEach(() => {
    db.close();
  });

  const asSearchable = (): SearchableDb => db as unknown as SearchableDb;

  // Exactly the call the IPC handler makes: searchLinkedContent(db, txnId, trimmed)
  // with default options.
  const scopedEmailIds = (query: string): string[] =>
    searchLinkedContent(asSearchable(), TXN, query).emails.items.map((e) => e.id).sort();

  const globalEmailIds = (query: string): string[] =>
    searchGlobalContent(asSearchable(), USER, query).emails.items.map((e) => e.id).sort();

  const unattachedEmailIds = (query: string): string[] =>
    searchGlobalContent(asSearchable(), USER, query)
      .unattached.items.filter((u) => u.kind === "email")
      .map((u) => u.id)
      .sort();

  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  describe("fixture self-checks (a red E1 must not be a seed bug)", () => {
    it("E1's attachment text_content really contains the query and E1 is really linked", () => {
      expect(
        count(
          "SELECT COUNT(*) AS n FROM attachments WHERE email_id = ? AND text_content LIKE ?",
          E1,
          `%${QUERY}%`,
        ),
      ).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM communications WHERE email_id = ? AND transaction_id = ?",
          E1,
          TXN,
        ),
      ).toBe(1);
    });

    it("E1's own columns and filename are free of the query (the match can only come from text_content)", () => {
      expect(
        count(
          `SELECT COUNT(*) AS n FROM emails
           WHERE id = ? AND (subject LIKE ? OR body_plain LIKE ? OR sender LIKE ? OR recipients LIKE ?)`,
          E1,
          `%${QUERY}%`,
          `%${QUERY}%`,
          `%${QUERY}%`,
          `%${QUERY}%`,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM attachments WHERE email_id = ? AND filename LIKE ?",
          E1,
          `%${QUERY}%`,
        ),
      ).toBe(0);
    });
  });

  describe("transaction-scoped search (buildEmailQuery) — the deal email search", () => {
    it("E2 (positive control): finds the email whose BODY holds the address", () => {
      expect(scopedEmailIds(QUERY)).toContain(E2);
    });

    it("E4 (negative control): does not return the email that matches nowhere", () => {
      expect(scopedEmailIds(QUERY)).not.toContain(E4);
    });

    it("E3 (observation, BACKLOG-1870): the attachment FILENAME is a match target", () => {
      // E3's text_content is NULL: load-bearing against a build without COALESCE.
      expect(scopedEmailIds(QUERY)).toContain(E3);
    });

    it("E6 (BACKLOG-1870): FILENAME still matches when text_content is ''", () => {
      expect(scopedEmailIds(QUERY)).toContain(E6);
    });

    it("E1 (THE CLAIM): finds the email whose address appears ONLY in attachment text_content", () => {
      expect(scopedEmailIds(QUERY)).toContain(E1);
    });
  });

  describe("global search, Emails group (buildGlobalEmailQuery) — scope A: filename-only", () => {
    it("controls hold: E2 found, E4 not", () => {
      const ids = globalEmailIds(QUERY);
      expect(ids).toContain(E2);
      expect(ids).not.toContain(E4);
    });

    it("E1 NOT found — scope A — filename-only until the FTS5 follow-up", () => {
      expect(globalEmailIds(QUERY)).not.toContain(E1);
    });

    it("E3 (filename hit) still found", () => {
      expect(globalEmailIds(QUERY)).toContain(E3);
    });
  });

  describe("global search, Unattached bucket (buildUnattachedEmailQuery) — scope A: filename-only", () => {
    it("E5 NOT found — scope A — filename-only until the FTS5 follow-up", () => {
      expect(unattachedEmailIds(QUERY)).not.toContain(E5);
    });
  });
});
