/**
 * @jest-environment node
 *
 * BACKLOG-3942 — controls for "deal email search reads attachment text".
 *
 * Real driver, real `schema.sql`, the real `searchLinkedContent` /
 * `searchGlobalContent` entry points (same technique as the probe suite
 * `transactionSearchDbService.attachmentText-3942.test.ts` and the BACKLOG-2816
 * suites). A fake `all()` would ignore the WHERE clause and prove nothing.
 *
 * Scope A: only the DEAL-SCOPED email builder (buildEmailQuery) matches
 * `filename || char(10) || COALESCE(text_content, '')`. The global Emails group
 * and the Unattached bucket stay filename-only — the near-miss controls at the
 * bottom prove they did not change.
 *
 * Every address, name and filename here is invented for the fixture.
 */

// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path.
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
import { MAX_TEXT_LENGTH } from "../../attachmentTextExtractionService";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = "u-3942c";
const TXN = "t-3942c";

const NEUTRAL_SUBJECT = "Re: inspection timing";
const NEUTRAL_BODY = "Please see the attached and confirm the window works.";
const NEUTRAL_SENDER = "agent-one@example.test";
const NEUTRAL_RECIPIENTS = "agent-two@example.test";

// Linked emails
const E_TEXT = "e-c-text"; // "larkspur" only in text_content of scan_0417.pdf
const E_NULL_NAME = "e-c-null-name"; // "larkspur" only in filename, text NULL
const E_SPLIT = "e-c-split"; // filename "scan.pdf" + text "larkspur addendum"
const E_TWO = "e-c-two"; // two attachments, only one text hits
const E_ESCAPE = "e-c-escape"; // text "rate 50%_x applies"
const E_NONE = "e-c-none"; // nothing matches
// Unlinked emails (Unattached bucket)
const U_TEXT = "e-c-u-text"; // "larkspur" only in text_content
const U_NAME = "e-c-u-name"; // "larkspur" only in filename, text NULL

const QUERY = "larkspur";

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google',?)",
  ).run(USER, "me@example.test", "o-me");
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?,?,?,?,?)`,
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
}

function addEmail(db: DatabaseType, id: string, linked: boolean, sentAt = "2026-06-01T00:00:00.000Z"): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, body_plain, sender, recipients, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, USER, NEUTRAL_SUBJECT, NEUTRAL_BODY, NEUTRAL_SENDER, NEUTRAL_RECIPIENTS, sentAt);
  if (linked) {
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
       VALUES (?, ?, ?, ?, 'manual')`,
    ).run(`c-${id}`, USER, TXN, id);
  }
}

function addAttachment(
  db: DatabaseType,
  id: string,
  emailId: string,
  filename: string,
  text: string | null,
): void {
  db.prepare(
    `INSERT INTO attachments (id, email_id, filename, mime_type, text_content)
     VALUES (?, ?, ?, 'application/pdf', ?)`,
  ).run(id, emailId, filename, text);
}

function seedMain(db: DatabaseType): void {
  seed(db);
  addEmail(db, E_TEXT, true);
  addAttachment(db, "a-text", E_TEXT, "scan_0417.pdf", "Purchase agreement for 4417 Larkspur Hollow Ct.");

  addEmail(db, E_NULL_NAME, true);
  addAttachment(db, "a-null-name", E_NULL_NAME, "Larkspur disclosure.pdf", null);

  addEmail(db, E_SPLIT, true);
  addAttachment(db, "a-split", E_SPLIT, "scan.pdf", "larkspur addendum");

  addEmail(db, E_TWO, true);
  addAttachment(db, "a-two-hit", E_TWO, "doc.pdf", "Larkspur Hollow inspection.");
  addAttachment(db, "a-two-miss", E_TWO, "photo.pdf", "Nothing of note on this page.");

  addEmail(db, E_ESCAPE, true);
  addAttachment(db, "a-escape", E_ESCAPE, "terms.pdf", "rate 50%_x applies");

  addEmail(db, E_NONE, true);
  addAttachment(db, "a-none", E_NONE, "scan_0418.pdf", "Nothing of note on this page.");

  addEmail(db, U_TEXT, false);
  addAttachment(db, "a-u-text", U_TEXT, "scan_0419.pdf", "Addendum regarding Larkspur Hollow.");

  addEmail(db, U_NAME, false);
  addAttachment(db, "a-u-name", U_NAME, "Larkspur survey.pdf", null);
}

describe("BACKLOG-3942 controls — deal email search reads attachment text", () => {
  let db: DatabaseType;
  const asSearchable = (): SearchableDb => db as unknown as SearchableDb;

  const scoped = (q: string) => searchLinkedContent(asSearchable(), TXN, q, { limit: 50 }).emails.items;
  const scopedIds = (q: string): string[] => scoped(q).map((e) => e.id).sort();
  const projectionOf = (q: string, id: string): string[] | undefined =>
    scoped(q).find((e) => e.id === id)?.matchedAttachmentFilenames;

  afterEach(() => {
    db.close();
  });

  describe("deal-scoped builder", () => {
    beforeEach(() => {
      db = new Database(":memory:");
      seedMain(db);
    });

    it("C1: a term only in attachment text_content finds the email", () => {
      expect(scopedIds(QUERY)).toContain(E_TEXT);
    });

    it("C2a: a FILENAME hit whose text_content is NULL is still found", () => {
      expect(scopedIds(QUERY)).toContain(E_NULL_NAME);
    });

    it("C2b: a FILENAME hit whose text_content is NULL projects its filename", () => {
      expect(projectionOf(QUERY, E_NULL_NAME)).toEqual(["Larkspur disclosure.pdf"]);
    });

    it("C3: a term cannot match across the filename/text boundary", () => {
      // "scan.pdf" + "larkspur addendum" — without the char(10) separator the
      // subject would read "scan.pdflarkspur addendum".
      expect(scopedIds("pdflark")).not.toContain(E_SPLIT);
      expect(scopedIds("larkspur addendum")).toContain(E_SPLIT);
    });

    it("C4a: LIKE wildcards in the query match literally inside text_content", () => {
      expect(scopedIds("50%_x")).toEqual([E_ESCAPE]);
    });

    it("C4b (sanity): a near-miss of the literal does not match", () => {
      expect(scopedIds("50Z_x")).toEqual([]);
    });

    it("C6a: a text hit on an UNLINKED email is not in the deal search", () => {
      expect(scopedIds(QUERY)).not.toContain(U_TEXT);
      expect(scopedIds(QUERY)).not.toContain(U_NAME);
    });

    it("C6d: the deal result set is exact", () => {
      expect(scopedIds(QUERY)).toEqual([E_NULL_NAME, E_SPLIT, E_TEXT, E_TWO].sort());
    });

    it("C7a: a text hit projects the attachment's FILENAME, never its text", () => {
      expect(projectionOf(QUERY, E_TEXT)).toEqual(["scan_0417.pdf"]);
    });

    it("C7b: only the attachment whose text matched is projected", () => {
      expect(projectionOf(QUERY, E_TWO)).toEqual(["doc.pdf"]);
    });
  });

  describe("C8: extractor cap sweep (MAX_TEXT_LENGTH-20 .. MAX_TEXT_LENGTH)", () => {
    const TAIL = "zqtailmark";
    const lengths: number[] = [];
    for (let len = MAX_TEXT_LENGTH - 20; len <= MAX_TEXT_LENGTH; len++) lengths.push(len);

    beforeEach(() => {
      db = new Database(":memory:");
      seed(db);
      lengths.forEach((len, i) => {
        const id = `e-cap-${len}`;
        // Distinct sent_at so ordering is deterministic.
        addEmail(db, id, true, `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`);
        addAttachment(db, `a-cap-${len}`, id, "long.pdf", "a".repeat(len - TAIL.length) + TAIL);
      });
    });

    it("fixture: every row is a length the extractor can store (<= MAX_TEXT_LENGTH)", () => {
      expect(MAX_TEXT_LENGTH).toBe(1_000_000);
      const row = db
        .prepare("SELECT MAX(length(text_content)) AS mx, MIN(length(text_content)) AS mn, COUNT(*) AS n FROM attachments")
        .get() as { mx: number; mn: number; n: number };
      expect(row).toEqual({ mx: MAX_TEXT_LENGTH, mn: MAX_TEXT_LENGTH - 20, n: 21 });
    });

    it("a term at the very tail is found at every length", () => {
      expect(scopedIds(TAIL)).toEqual(lengths.map((len) => `e-cap-${len}`).sort());
    });
  });

  describe("near-miss: global and unattached email builders did NOT change (scope A)", () => {
    beforeEach(() => {
      db = new Database(":memory:");
      seedMain(db);
    });

    const globalIds = (q: string): string[] =>
      searchGlobalContent(asSearchable(), USER, q).emails.items.map((e) => e.id).sort();
    const unattachedIds = (q: string): string[] =>
      searchGlobalContent(asSearchable(), USER, q)
        .unattached.items.filter((u) => u.kind === "email")
        .map((u) => u.id)
        .sort();

    it("global: a FILENAME hit is found (positive control)", () => {
      expect(globalIds(QUERY)).toContain(E_NULL_NAME);
    });

    it("global: a text-only hit is NOT found", () => {
      expect(globalIds(QUERY)).not.toContain(E_TEXT);
      expect(globalIds(QUERY)).not.toContain(E_TWO);
    });

    it("global: a FILENAME hit projects its filename (unchanged)", () => {
      const hit = searchGlobalContent(asSearchable(), USER, QUERY).emails.items.find(
        (e) => e.id === E_NULL_NAME,
      );
      expect(hit?.matchedAttachmentFilenames).toEqual(["Larkspur disclosure.pdf"]);
    });

    it("unattached: a FILENAME hit is found (positive control)", () => {
      expect(unattachedIds(QUERY)).toContain(U_NAME);
    });

    it("unattached: a text-only hit is NOT found", () => {
      expect(unattachedIds(QUERY)).not.toContain(U_TEXT);
    });
  });
});
