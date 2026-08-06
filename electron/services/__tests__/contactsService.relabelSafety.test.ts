/**
 * @jest-environment node
 *
 * BACKLOG-2399 — relabelling does not orphan an already-imported contact.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST IS THE WHOLE RISK OF THE TICKET
 * ---------------------------------------------------------------------------
 * BACKLOG-2392 refused to fix the display-name precedence, and it was right to.
 * At the time the ONLY bridge from a saved contact back to its address-book row
 * was display-name string equality:
 *
 *     SELECT emails_json, phones_json FROM external_contacts
 *      WHERE user_id = ? AND name = ?          -- ? = contacts.display_name
 *
 * Correcting the precedence changes the reader's output for every contact
 * stored under an organisation name, so it would have broken that join for all
 * of them at once, on one release.
 *
 * BACKLOG-2401 replaced the name join with `contact_source_links`, keyed on the
 * SOURCE RECORD. This test does not take that on trust. It drives the REAL
 * corrected reader over a REAL `.abcddb`, writes the relabelled output into a
 * REAL SQLite database, and then asserts BY EXACT ID that the saved contact is
 * still resolved — and, in the negative control below, that the old name join
 * would have failed on exactly this input.
 *
 * The person: first name "Margaret", organisation "Miller - Seller", no
 * surname. Saved months ago as "Miller - Seller", because that is what the
 * reader used to emit.
 *
 * Assertion style: exact ids, never counts (catalogue rule 1).
 */

import path from "path";
import fs from "fs";
import os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

// The real sqlite3 driver for the READER, resolved by absolute path so jest's
// `^sqlite3$` moduleNameMapper (a hand-written stub) does not intercept it.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

// The real better-sqlite3 driver for the DATABASE side.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { getContactNames } from "../contactsService";
import { resetContactIngestionFunnel } from "../contactIngestionFunnel";
import { writeAddressBook } from "./helpers/addressBookFixture";
import { getLinkedSourceKeys, sourceKey } from "../db/contactSourceLinkDbService";
import {
  CONTACT_SOURCE_RECORDS_SQL,
  type ContactSourceRecordRow,
} from "../db/contactSourceLinkSql";

const USER = "user-2399";

/** The saved contact's row id — the identity every assertion below names. */
const MARGARET_CONTACT_ID = "c-margaret-0001";
/** Her ZUNIQUEID in the address book — the crosswalk's key. */
const MARGARET_RECORD_ID = "MARGARET-0001:ABPerson";
/** What she was SAVED as, before the precedence was corrected. */
const OLD_LABEL = "Miller - Seller";
/** What the corrected reader emits. */
const NEW_LABEL = "Margaret";

const SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    source TEXT DEFAULT 'manual',
    is_imported INTEGER DEFAULT 1,
    removed_at DATETIME,
    removed_reason TEXT
  );
  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0, UNIQUE(contact_id, email)
  );
  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, phone_e164 TEXT NOT NULL,
    phone_normalized TEXT, is_primary INTEGER DEFAULT 0, UNIQUE(contact_id, phone_e164)
  );
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT,
    phones_json TEXT, phones_normalized_json TEXT, emails_json TEXT,
    company TEXT, external_record_id TEXT, source TEXT DEFAULT 'macos',
    synced_at DATETIME, external_uuid TEXT,
    UNIQUE(user_id, source, external_record_id)
  );
  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    external_uuid TEXT,
    match_method TEXT NOT NULL CHECK (
      match_method IN ('source_id', 'email', 'phone', 'manual', 'scored')
    ),
    confidence REAL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, source_type, source_record_id)
  );
`;

/** Every source record a saved contact resolves to, in declared order. */
function resolveSourceRecords(contactId: string): ContactSourceRecordRow[] {
  return mockDb!
    .prepare(CONTACT_SOURCE_RECORDS_SQL)
    .all({ userId: USER, contactId }) as ContactSourceRecordRow[];
}

/**
 * The join BACKLOG-2401 deleted, reconstructed verbatim so the negative control
 * can show what this change would have done to her before the crosswalk.
 */
function resolveByLegacyNameJoin(displayName: string): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT external_record_id FROM external_contacts WHERE user_id = ? AND name = ?",
      )
      .all(USER, displayName) as Array<{ external_record_id: string }>
  ).map((r) => r.external_record_id);
}

describe("BACKLOG-2399: a contact saved under an organisation name survives the relabel", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let baseDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-relabel-"));
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    fs.mkdirSync(baseDir, { recursive: true });
    process.env.HOME = home;
    resetContactIngestionFunnel();

    mockDb = new RealDatabase(":memory:");
    mockDb.exec(SCHEMA);

    // ---------------------------------------------------------------------
    // THE PRE-RELABEL WORLD — exactly as it sits on a real machine today.
    // Margaret was imported months ago, under her ORGANISATION, because that
    // is what the reader emitted. She has no email and no phone on the saved
    // record: the population BACKLOG-2399 identified as genuinely at risk.
    // ---------------------------------------------------------------------
    mockDb
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, company, source, is_imported) VALUES (?, ?, ?, ?, 'contacts_app', 1)",
      )
      .run(MARGARET_CONTACT_ID, USER, OLD_LABEL, OLD_LABEL);

    mockDb
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json, company, external_record_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'macos')`,
      )
      .run(
        "ec-margaret",
        USER,
        OLD_LABEL,
        JSON.stringify(["+15555550111"]),
        JSON.stringify(["+15555550111"]),
        JSON.stringify([]),
        OLD_LABEL,
        MARGARET_RECORD_ID,
      );

    // The BACKLOG-2401 crosswalk row: contact <-> source record.
    mockDb
      .prepare(
        `INSERT INTO contact_source_links
           (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES (?, ?, ?, 'macos', ?, 'source_id')`,
      )
      .run("csl-margaret", USER, MARGARET_CONTACT_ID, MARGARET_RECORD_ID);

    // Her actual address-book card, read by the REAL reader below.
    writeAddressBook(path.join(baseDir, "AddressBook-v22.abcddb"), [
      {
        pk: 4,
        uid: MARGARET_RECORD_ID,
        first: "Margaret",
        org: "Miller - Seller",
        phones: ["+15555550111"],
      },
    ]);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    mockDb?.close();
    mockDb = null;
  });

  /** Run the real reader and write its output into external_contacts, as a sync does. */
  async function runReaderAndSync(): Promise<string> {
    const result = await getContactNames();
    const margaret = result.contacts!.find((c) => c.recordId === MARGARET_RECORD_ID);
    expect(margaret).toBeDefined();

    mockDb!
      .prepare(
        "UPDATE external_contacts SET name = ?, company = ? WHERE user_id = ? AND source = 'macos' AND external_record_id = ?",
      )
      .run(margaret!.name, margaret!.company ?? null, USER, MARGARET_RECORD_ID);

    return margaret!.name;
  }

  it("the corrected reader relabels her from her organisation to her name", async () => {
    const label = await runReaderAndSync();

    expect(label).toBe(NEW_LABEL);
    // Her saved row still says the old thing — nothing migrates it, by design.
    // That is precisely why the link must not depend on the label.
    expect(
      (mockDb!
        .prepare("SELECT display_name FROM contacts WHERE id = ?")
        .get(MARGARET_CONTACT_ID) as { display_name: string }).display_name,
    ).toBe(OLD_LABEL);
  });

  it("KEEPS her saved record linked to her address-book row, by exact id", async () => {
    await runReaderAndSync();

    const resolved = resolveSourceRecords(MARGARET_CONTACT_ID);

    // Exact id set — not a length check. "one row" is equally satisfied by
    // resolving to the WRONG person, which is the failure this guards.
    expect(resolved.map((r) => r.external_record_id)).toEqual([MARGARET_RECORD_ID]);
    // And it resolved through the CROSSWALK, not through a content fallback
    // that happened to agree. `matched_by` is what makes that checkable.
    expect(resolved.map((r) => r.matched_by)).toEqual(["source_id"]);
  });

  it("does NOT re-offer her in the picker as a new person", async () => {
    await runReaderAndSync();

    // The already-imported filter's authoritative test (contactHandlers.ts):
    // every (source_type, source_record_id) pair already claimed by a contact.
    const linkedKeys = getLinkedSourceKeys(USER);

    expect(linkedKeys.has(sourceKey("macos", MARGARET_RECORD_ID))).toBe(true);
    // Exact membership, both directions: the key present is HERS, and a
    // neighbouring record is not accidentally suppressed along with her.
    expect([...linkedKeys].sort()).toEqual([sourceKey("macos", MARGARET_RECORD_ID)]);
  });

  /**
   * THE NEGATIVE CONTROL FOR THE WHOLE SEQUENCING ARGUMENT.
   *
   * This is the assertion that shows BACKLOG-2399 was genuinely blocked and is
   * genuinely unblocked — not merely asserted to be. The old name join is
   * reconstructed verbatim and run against the same post-relabel data. It finds
   * nothing. The crosswalk, on the same data, finds her.
   */
  it("would have ORPHANED her under the pre-2401 name join — which is why this waited", async () => {
    await runReaderAndSync();

    // Before the relabel the name join worked: saved label == shadow label.
    // After it, the shadow row says "Margaret" and her saved row still says
    // "Miller - Seller", so the join has nothing to match.
    expect(resolveByLegacyNameJoin(OLD_LABEL)).toEqual([]);

    // Same data, same moment, resolved through the crosswalk instead.
    expect(resolveSourceRecords(MARGARET_CONTACT_ID).map((r) => r.external_record_id))
      .toEqual([MARGARET_RECORD_ID]);
  });

  it("backfill still reaches her: the phone on her source record resolves through", async () => {
    await runReaderAndSync();

    const resolved = resolveSourceRecords(MARGARET_CONTACT_ID);

    // The link is not merely present, it carries the payload backfill needs —
    // an orphaned contact silently stops receiving phone/email updates forever,
    // which is the harm, not the missing row itself.
    expect(JSON.parse(resolved[0].phones_json!)).toEqual(["+15555550111"]);
  });

  /**
   * The honest residual, recorded rather than hidden.
   *
   * BACKLOG-2399's own analysis named the population still at risk: saved under
   * an org name, no crosswalk row yet, AND no email or phone to fall back on.
   * The crosswalk converges opportunistically as syncs run (BACKLOG-2401), it
   * does not retro-link this row. This test states that limit precisely so it
   * is a known boundary rather than a discovery in a support ticket.
   */
  it("states the limit: an unlinked contact with no email or phone resolves to nothing", async () => {
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'contacts_app', 1)",
      )
      .run("c-unlinked", USER, "Acme Escrow");

    await runReaderAndSync();

    // No crosswalk row, no email, no phone — nothing to match on but the name,
    // and name matching is gone on purpose (it over-suppressed distinct people).
    expect(resolveSourceRecords("c-unlinked")).toEqual([]);
    // She is NOT falsely linked to Margaret's record either, which would be the
    // worse failure of the two.
    expect(resolveSourceRecords("c-unlinked").map((r) => r.external_record_id))
      .not.toContain(MARGARET_RECORD_ID);
  });
});
