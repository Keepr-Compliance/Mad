/**
 * BACKLOG-4180 C5 — the import-scoped linking pass produces the SAME crosswalk,
 * proposals, copied values and name questions as the full pass, on the same
 * database, after an import.
 *
 * Real schema (`schema.sql`), real SQL, real writers:
 *   - source records through `upsertFromMacOS` (stores phones_normalized_json);
 *   - saved-contact values through `syncContactEmails` / `syncContactPhones`;
 *   - the import's own crosswalk row + copy through `createLink` +
 *     `applyLinkedSourceValuesOrThrow` (what `linkImportedContact` calls).
 *
 * Shape of the test:
 *   1. seed, then run a FULL pass so the world is converged (as after any sync);
 *   2. a sync adds record r-d (its pass not run yet) and the user imports
 *      B and C (new) and claims r-D for existing contact D;
 *   3. copy 1 runs the scoped pass for [B, C, D]; copy 2 runs the full pass;
 *   4. compare every table the passes write.
 *
 * Cases: (a) record sharing only a phone with B; (b) sharing only an email,
 * whitespace-padded and mixed case; (c) the name of C's picked record, held by
 * one record in the other family (the rule's auto-link shape); (d) a record matching existing A AND imported B (must be ambiguous —
 * a scoped match index would link it to B); (e) unrelated; (f) a record linked
 * to A before the import, untouched (flagged then, unchanged now); (g) a record named like the record
 * existing contact D claimed, which only the crosswalk seed reaches.
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
import { runUniqueNameAutoLinkForMode, type AskPair } from "../contactNameAutoLink";
import { runImportScopedLinkingPass } from "../contactImportLinking";
import { upsertFromMacOS, upsertFromOutlook } from "../db/externalContactDbService";
import { syncContactEmails, syncContactPhones } from "../db/contactDbService";
import { createLink } from "../db/contactSourceLinkDbService";
import { applyLinkedSourceValuesOrThrow } from "../contactSourceValues";
import type { ContactAutoLinkMode } from "../contactAutoLinkPolicy";

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const V40_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized)";

const USER = "user-4180";

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(V40_INDEX_SQL);
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-4180')`,
  ).run(USER, "owner@example.test");
  return db;
}

function addContact(db: DatabaseType, id: string, name: string, emails: string[], phones: string[]): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)").run(id, USER, name);
  syncContactEmails(id, emails.map((email, i) => ({ email, is_primary: i === 0 })));
  syncContactPhones(id, phones.map((phone, i) => ({ phone, is_primary: i === 0 })));
}

function fullPass(mode: ContactAutoLinkMode, asks: AskPair[]): void {
  linkExternalContactsForUser(USER);
  runUniqueNameAutoLinkForMode(mode, USER, (pair) => asks.push(pair));
}

/** Steps 1 and 2. Returns the touched contact ids. */
function buildImportedWorld(db: DatabaseType, mode: ContactAutoLinkMode): string[] {
  setDb(db as never);

  // Existing saved contacts.
  addContact(db, "c-A", "Avery Existing", ["avery@example.test"], ["(415) 555-0120"]);
  addContact(db, "c-D", "Dana Existing", ["dana@example.test"], ["(415) 555-0160"]);

  upsertFromMacOS(USER, [
    { recordId: "r-A", name: "Avery Existing", emails: ["avery@example.test"], phones: ["(415) 555-0120"] },
    { recordId: "r-f", name: "Avery Altcard", emails: [], phones: ["+1 415 555 0120"] },
    { recordId: "r-e", name: "Elliot Unrelated", emails: ["elliot@example.test"], phones: ["415-555-0150"] },
    { recordId: "r-B", name: "Blair Imported", emails: ["blair@example.test"], phones: ["(415) 555-0130"] },
    { recordId: "r-C", name: "Casey Named", emails: ["casey@example.test"], phones: [] },
    { recordId: "r-a", name: "Alex Phoneshare", emails: [], phones: ["  ", "+1 415 555 0130"] },
    { recordId: "r-b", name: "Bee Emailshare", emails: ["  BLAIR@Example.Test "], phones: [] },
    { recordId: "r-D", name: "Dana Maiden", emails: ["dana.maiden@example.test"], phones: [] },
    { recordId: "r-g", name: "Dana Maiden", emails: [], phones: ["415-555-0170"] },
  ]);
  // (c) the same name in the OTHER family: the only shape the rule auto-links.
  upsertFromOutlook(USER, [
    { external_record_id: "r-c", name: "Casey Named", emails: [], phones: [], company: null },
  ]);

  // 1. Converge, as after any sync.
  fullPass(mode, []);

  // 2a. A sync adds r-d; its coalesced pass has not run yet.
  upsertFromMacOS(USER, [
    { recordId: "r-d", name: "Drew Twomatch", emails: [], phones: ["(415) 555-0120", "(415) 555-0130"] },
  ]);

  // 2b. The import: two new contacts and one existing contact claiming r-D.
  addContact(db, "c-B", "Blair Imported", ["blair@example.test"], ["(415) 555-0130"]);
  addContact(db, "c-C", "Casey Named", ["casey@example.test"], []);
  for (const [contactId, recordId] of [["c-B", "r-B"], ["c-C", "r-C"], ["c-D", "r-D"]] as const) {
    createLink({ userId: USER, contactId, sourceType: "macos", sourceRecordId: recordId, matchMethod: "source_id" });
    applyLinkedSourceValuesOrThrow(USER, contactId);
  }
  return ["c-B", "c-C", "c-D"];
}

function snapshot(db: DatabaseType, asks: AskPair[]): Record<string, unknown> {
  return {
    links: db
      .prepare(
        `SELECT contact_id, source_type, source_record_id, match_method FROM contact_source_links
          WHERE user_id = ? ORDER BY source_record_id, contact_id`,
      )
      .all(USER),
    proposals: db
      .prepare(
        `SELECT contact_id, source_type, source_record_id, status, reason, pair_kind, target_contact_id
           FROM contact_link_proposals WHERE user_id = ?
          ORDER BY source_record_id, contact_id, reason`,
      )
      .all(USER),
    emails: db
      .prepare("SELECT contact_id, LOWER(email) AS e FROM contact_emails ORDER BY contact_id, e")
      .all(),
    phones: db
      .prepare("SELECT contact_id, phone_normalized FROM contact_phones ORDER BY contact_id, phone_normalized")
      .all(),
    asks: [...asks].sort((x, y) =>
      `${x.contactId}|${x.sourceRecordId}`.localeCompare(`${y.contactId}|${y.sourceRecordId}`),
    ),
  };
}

function linkOf(db: DatabaseType, recordId: string): string | null {
  const row = db
    .prepare("SELECT contact_id FROM contact_source_links WHERE user_id = ? AND source_record_id = ?")
    .get(USER, recordId) as { contact_id: string } | undefined;
  return row?.contact_id ?? null;
}

describe.each(["auto", "suggest"] as const)("BACKLOG-4180 C5 scoped == full (mode %s)", (mode) => {
  let scoped: Record<string, unknown>;
  let full: Record<string, unknown>;
  let scopedDb: DatabaseType;
  let fullDb: DatabaseType;

  beforeAll(() => {
    scopedDb = makeDb();
    const touched = buildImportedWorld(scopedDb, mode);
    const scopedAsks: AskPair[] = [];
    runImportScopedLinkingPass(USER, touched, (pair) => scopedAsks.push(pair), mode);
    scoped = snapshot(scopedDb, scopedAsks);

    fullDb = makeDb();
    buildImportedWorld(fullDb, mode);
    const fullAsks: AskPair[] = [];
    fullPass(mode, fullAsks);
    full = snapshot(fullDb, fullAsks);
  });

  afterAll(() => {
    scopedDb.close();
    fullDb.close();
  });

  it("every table the pass writes is identical", () => {
    expect(scoped).toEqual(full);
  });

  it("not vacuous: the cases resolved as designed in the scoped copy", () => {
    const proposals = scoped.proposals as Array<{ contact_id: string; source_record_id: string; reason: string }>;
    const proposed = (rid: string, cid: string): string[] =>
      proposals.filter((p) => p.source_record_id === rid && p.contact_id === cid).map((p) => p.reason);
    // (a)/(b) found by phone (past a leading blank) and by padded mixed-case
    // email; the name veto turns each into a question, not a link.
    expect(proposed("r-a", "c-B")).toEqual(["name_mismatch"]);
    expect(proposed("r-b", "c-B")).toEqual(["name_mismatch"]);
    // (d) ambiguous between existing A and imported B, never linked to B.
    expect(linkOf(scopedDb, "r-d")).toBeNull();
    expect(proposed("r-d", "c-A")).toEqual(["ambiguous_identifier"]);
    expect(proposed("r-d", "c-B")).toEqual(["ambiguous_identifier"]);
    // (e) unrelated: nothing.
    expect(linkOf(scopedDb, "r-e")).toBeNull();
    expect(proposals.filter((p) => p.source_record_id === "r-e")).toEqual([]);
    // (g) reached only through the crosswalk seed (D's own name differs).
    const asks = scoped.asks as AskPair[];
    expect(asks.some((a) => a.contactId === "c-D" && a.sourceRecordId === "r-g")).toBe(true);
    // (c) the unique-name pair: linked in auto, asked in suggest.
    if (mode === "auto") {
      expect(linkOf(scopedDb, "r-c")).toBe("c-C");
    } else {
      expect(linkOf(scopedDb, "r-c")).toBeNull();
      expect(asks.some((a) => a.sourceRecordId === "r-c" && a.contactId === "c-C")).toBe(true);
    }
  });
});
