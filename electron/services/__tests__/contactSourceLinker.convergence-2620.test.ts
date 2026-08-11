/**
 * @jest-environment node
 *
 * BACKLOG-2620 — the linking pass must not re-run per-record SQL for every
 * record that matched nothing, on every sync, forever.
 *
 * ===========================================================================
 * WHAT IS ASSERTED, AND WHY IT IS A STATEMENT COUNT
 * ===========================================================================
 * The founder's log, at `71ddcbb0`, on his own machine:
 *
 *     links: 1169 records -> id-matched 10 -> content-matched 0
 *            -> flagged 5 -> declined 1 -> unmatched 1153
 *
 * 1,153 records reached the content fallback and will reach it again on the
 * next pass and every pass after, because nothing about "this matched nothing"
 * was ever written down. The cost is per-record SQL, so the measurement is a
 * per-record SQL count — a stopwatch on a fixture cannot distinguish 3,000
 * indexed lookups from 3, and the numbers would be noise.
 *
 * The assertion is therefore EQUALITY ACROSS TWO CORPUS SIZES rather than
 * "fewer than before": the content-matching statement count at 100 unmatched
 * records must equal the count at 1,160. Anything that scales with the record
 * count fails that, including a smaller constant per record.
 *
 * Statements are counted by wrapping the DATABASE HANDLE's `prepare`, not by
 * spying on `dbAll`/`dbGet` — the count then includes anything the linker
 * reaches by any route, including a helper that acquires the handle directly.
 */

import path from "path";
import fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType, Statement } from "better-sqlite3";

import { setDb } from "../db/core/dbConnection";
import {
  linkExternalContactsForUser,
  linkSourceRecords,
  resolveSourceRecord,
  type LinkResolution,
  type SourceRecordCandidate,
} from "../contactSourceLinker";
import {
  createContact,
  deleteContact,
  restoreContact,
  syncContactEmails,
  syncContactPhones,
} from "../db/contactDbService";
import { createLink } from "../db/contactSourceLinkDbService";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
  CONTACT_LINK_VERDICTS_TABLE_SQL,
  CONTACT_LINK_VERDICTS_INDEX_SQL,
} from "../db/contactIdentitySchemaSql";

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

/**
 * The two statements migrations run that `schema.sql` deliberately does not,
 * both verbatim from `databaseService.ts`.
 *
 * They are here because leaving either out would measure a database production
 * never has: without the v40 index the phone probe is a scan, which would
 * flatter the "after" number by inflating the "before" one.
 */
const V40_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized)";
const V57_EXTERNAL_UUID_SQL = "ALTER TABLE external_contacts ADD COLUMN external_uuid TEXT";
/** Migration v56's tombstone columns — what `deleteContact`/`restoreContact` write. */
const V56_TOMBSTONE_SQL = [
  "ALTER TABLE contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE contacts ADD COLUMN removed_reason TEXT",
];

const USER_ID = "user-2620";

/** The open handle. Module scope so the helpers below can reach it. */
let db: DatabaseType;
function currentDb(): DatabaseType {
  return db;
}

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(V40_INDEX_SQL);
  db.exec(V57_EXTERNAL_UUID_SQL);
  for (const sql of V56_TOMBSTONE_SQL) db.exec(sql);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.exec(CONTACT_SOURCE_LINKS_INDEX_SQL);
  db.exec(CONTACT_LINK_PROPOSALS_TABLE_SQL);
  db.exec(CONTACT_LINK_PROPOSALS_INDEX_SQL);
  db.exec(CONTACT_LINK_VERDICTS_TABLE_SQL);
  db.exec(CONTACT_LINK_VERDICTS_INDEX_SQL);
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', 'oauth-2620')`,
  ).run(USER_ID, "owner@example.com");
  return db;
}

// ---------------------------------------------------------------------------
// Statement counting
// ---------------------------------------------------------------------------

interface Counter {
  /** Every SQL string executed, in order, while armed. */
  executed: string[];
  stop: () => void;
}

/**
 * Count executions, not preparations.
 *
 * `better-sqlite3` caches nothing for us — `dbAll`/`dbGet` prepare on every
 * call — but counting `prepare` alone would still be the wrong number if that
 * ever changes. Wrapping the returned statement's `all`/`get`/`run` counts what
 * the database actually did.
 */
function countStatements(db: DatabaseType): Counter {
  const executed: string[] = [];
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = realPrepare(sql) as Statement;
    for (const method of ["all", "get", "run", "iterate"] as const) {
      const real = (stmt as unknown as Record<string, unknown>)[method];
      if (typeof real !== "function") continue;
      (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        executed.push(sql);
        return (real as (...a: unknown[]) => unknown).apply(stmt, args);
      };
    }
    return stmt;
  };
  return {
    executed,
    stop: () => {
      (db as unknown as { prepare: unknown }).prepare = realPrepare;
    },
  };
}

/** Statements that probe the contact identifier tables — the content fallback. */
function contentFallbackStatements(executed: string[]): string[] {
  return executed.filter(
    (s) =>
      (s.includes("contact_emails") || s.includes("contact_phones")) &&
      s.includes("SELECT"),
  );
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * Fixture identifiers.
 *
 * The repository is public. Emails are on the RFC 2606 reserved domain and
 * phones are inside the NANP fiction range, varying the AREA CODE to get
 * distinct `toLookupKey` values — the last ten digits are what the linker
 * compares, so `555-01xx` alone would collide after 100 records.
 */
function recordEmail(i: number): string {
  return `record${i}@records.example.com`;
}
function recordPhone(i: number): string {
  const area = 200 + (i % 700);
  const line = String(i % 100).padStart(2, "0");
  return `+1${area}555` + "01" + line;
}
/**
 * Saved contacts live in area codes 900+; records never do. The `555-01xx`
 * range is only 100 values wide, so without disjoint AREA codes the corpus
 * accidentally links a record to a contact and the "everything is unmatched"
 * premise silently stops holding — observed at N=100, where record 99 matched
 * saved contact 99.
 */
function savedPhone(j: number): string {
  const area = 900 + (j % 99);
  const line = String(j % 100).padStart(2, "0");
  return `+1${area}555` + "01" + line;
}

interface Corpus {
  externalRecordIds: string[];
}

/** `n` external records that match nothing, plus `contacts` saved contacts that also match nothing. */
function seedCorpus(db: DatabaseType, n: number, contactCount: number): Corpus {
  const insEc = db.prepare(
    `INSERT INTO external_contacts
       (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 'macos', '2026-08-10T00:00:00.000Z')`,
  );
  const insC = db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
  );
  const insE = db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 0, 'import')",
  );
  const insP = db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, 0, 'import')`,
  );

  const externalRecordIds: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const rid = `rec-${i}`;
      externalRecordIds.push(rid);
      insEc.run(
        `ec-${i}`,
        USER_ID,
        `Record Person ${i}`,
        JSON.stringify([recordPhone(i)]),
        JSON.stringify([recordEmail(i)]),
        rid,
      );
    }
    // Saved contacts with identifiers of their own that no record carries, so
    // the probes are real work that returns nothing — the founder's shape.
    for (let j = 0; j < contactCount; j++) {
      const cid = `c-${j}`;
      insC.run(cid, USER_ID, `Saved Person ${j}`);
      insE.run(`ce-${j}`, cid, `saved${j}@people.example.org`);
      const phone = savedPhone(j);
      insP.run(`cp-${j}`, cid, phone, phone.replace(/\D/g, "").slice(-10));
    }
  })();

  return { externalRecordIds };
}

// ---------------------------------------------------------------------------
// One-record helpers for the invalidation controls
// ---------------------------------------------------------------------------

let nextRow = 0;

/** One row of `external_contacts`, the way a sync writes it. */
function addRecord(
  recordId: string,
  opts: {
    name?: string | null;
    emails?: string[];
    phones?: string[];
    source?: string;
    externalUuid?: string | null;
  },
): void {
  const phones = opts.phones ?? [];
  currentDb()
    .prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-10T00:00:00.000Z', ?)`,
    )
    .run(
      `ext-${nextRow++}`,
      USER_ID,
      opts.name ?? null,
      JSON.stringify(phones),
      JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      opts.externalUuid ?? null,
    );
}

/** Source record ids with this outcome, sorted — an exact set, never a count. */
function idsOf(summary: { resolutions: LinkResolution[] }, outcome: string): string[] {
  return summary.resolutions
    .filter((r) => r.outcome === outcome)
    .map((r) => r.sourceRecordId)
    .sort();
}

/** Every crosswalk row as `[contactId, sourceRecordId]`, origin rows excluded. */
function crosswalkPairs(): Array<[string, string]> {
  return (
    currentDb()
      .prepare(
        `SELECT contact_id, source_record_id FROM contact_source_links
          WHERE match_method != 'origin' ORDER BY contact_id, source_record_id`,
      )
      .all() as Array<{ contact_id: string; source_record_id: string }>
  ).map((r) => [r.contact_id, r.source_record_id]);
}

/** The candidate list `linkExternalContactsForUser` builds, read the same way. */
function readCandidates(): SourceRecordCandidate[] {
  return (
    currentDb()
      .prepare(
        `SELECT external_record_id, source, name, emails_json, phones_json, external_uuid
           FROM external_contacts
          WHERE user_id = ? AND external_record_id IS NOT NULL
          ORDER BY source, external_record_id`,
      )
      .all(USER_ID) as Array<{
      external_record_id: string;
      source: string;
      name: string | null;
      emails_json: string | null;
      phones_json: string | null;
      external_uuid: string | null;
    }>
  ).map((r) => ({
    sourceType: r.source as SourceRecordCandidate["sourceType"],
    sourceRecordId: r.external_record_id,
    externalUuid: r.external_uuid,
    name: r.name,
    emails: JSON.parse(r.emails_json ?? "[]") as string[],
    phones: JSON.parse(r.phones_json ?? "[]") as string[],
  }));
}

/**
 * The corpus for the parity control. Written with raw SQL rather than through
 * `createContact` because several rows are shapes the create path will not
 * produce on purpose — a NULL `phone_normalized`, an untrimmed stored email —
 * and those are exactly the rows a hand-written map gets wrong.
 */
function seedParityCorpus(db: DatabaseType): void {
  const insC = db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
  );
  const insE = db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 0, 'import')",
  );
  const insP = db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, 0, 'import')`,
  );

  // Contact ids are deliberately NOT in insertion order, so `ORDER BY c.id`
  // and "the order rows were written" cannot be confused for one another.
  insC.run("c-pat", USER_ID, "Pat Riverton");
  insE.run("e-pat", "c-pat", "PAT.RIVERTON@Example.COM");
  insC.run("c-robin", USER_ID, "Robin Marsh");
  insE.run("e-robin1", "c-robin", "robin@example.com");
  insE.run("e-robin2", "c-robin", "robin.marsh@example.org");
  insC.run("c-chris", USER_ID, "Chris Alvarez");
  // Leading space in the STORED address. `LOWER()` does not trim it, so this
  // must NOT match a probe for the same address without the space.
  insE.run("e-chris", "c-chris", " chris@example.com");
  insP.run("p-chris", "c-chris", "+15555550171", "5555550171");
  insC.run("c-dana", USER_ID, "Dana Alvarez");
  insP.run("p-dana", "c-dana", "+15555550171", "5555550171");
  insC.run("c-null", USER_ID, "Robin Hale");
  // A NULL lookup key: `IN` can never match it, in either implementation.
  insP.run("p-null", "c-null", "+15555550188", null);
  insC.run("c-short", USER_ID, "Short Code Sender");
  insP.run("p-short", "c-short", "12345", "12345");
  insC.run("c-alpha", USER_ID, "Verizon Notices");
  insP.run("p-alpha", "c-alpha", "VERIZON", "VERIZON");
  insC.run("c-both", USER_ID, "Bo Tran");
  insE.run("e-both", "c-both", "bo.tran@example.com");
  insC.run("c-phone-only", USER_ID, "Other Holder");
  insP.run("p-phone-only", "c-phone-only", "+15555550166", "5555550166");

  const add = (recordId: string, opts: Parameters<typeof addRecord>[1]) => {
    const phones = opts.phones ?? [];
    db.prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-10T00:00:00.000Z', ?)`,
    ).run(
      `ext-p-${recordId}`,
      USER_ID,
      opts.name ?? null,
      JSON.stringify(phones),
      JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      opts.externalUuid ?? null,
    );
  };

  // Case differs on both sides.
  add("p-case", { name: "Pat Riverton", emails: ["pat.riverton@example.com"] });
  // Two of the record's emails reach ONE contact — the live query's DISTINCT.
  add("p-distinct", { name: "Robin Marsh", emails: ["robin@example.com", "robin.marsh@example.org"] });
  // The stored address has a leading space, the probe does not: no match.
  add("p-untrimmed", { name: "Chris Alvarez", emails: ["chris@example.com"] });
  // Two contacts share the phone: order decides which one the question names.
  add("p-shared-phone", { name: "Chris Alvarez", phones: ["+1 (555) 555-0171"] });
  // Email matches nobody, phone matches somebody: the phone arm must be reached.
  add("p-phone-fallback", {
    name: "Other Holder",
    emails: ["nobody@example.net"],
    phones: ["+15555550166"],
  });
  // Email matches; the phone would match a DIFFERENT contact. Email wins.
  add("p-email-first", {
    name: "Bo Tran",
    emails: ["bo.tran@example.com"],
    phones: ["+15555550166"],
  });
  // A NULL stored key is unreachable.
  add("p-null-key", { name: "Robin Hale", phones: ["+15555550188"] });
  add("p-short-code", { name: "Short Code Sender", phones: ["12345"] });
  add("p-alphanumeric", { name: "Verizon Notices", phones: ["VERIZON"] });
  // Nothing to probe with at all.
  add("p-empty", { name: "No Identifiers" });
  // Already claimed by the crosswalk, and carrying a uuid to backfill.
  insC.run("c-claimed", USER_ID, "Claimed Person");
  add("p-claimed", { name: "Claimed Person", externalUuid: "UUID-CLAIMED-0001" });
  db.prepare(
    `INSERT INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id, match_method)
     VALUES ('l-claimed', ?, 'c-claimed', 'macos', 'p-claimed', 'phone')`,
  ).run(USER_ID);
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

describe("BACKLOG-2620 — the linking pass does not scale its SQL with unmatched records", () => {
  afterEach(() => {
    if (db) db.close();
    setDb(undefined as unknown as DatabaseType);
  });

  function runPass(n: number, contactCount: number) {
    db = makeDb();
    seedCorpus(db, n, contactCount);
    setDb(db);
    const counter = countStatements(db);
    const startedAt = Date.now();
    const summary = linkExternalContactsForUser(USER_ID);
    const ms = Date.now() - startedAt;
    counter.stop();
    return {
      summary,
      ms,
      total: counter.executed.length,
      fallback: contentFallbackStatements(counter.executed).length,
    };
  }

  it("CONTROL 1 — content-fallback statements are the same count at 100 and 1,160 unmatched records", () => {
    const small = runPass(100, 200);
    db.close();
    const large = runPass(1160, 2000);

    // The corpus is the shape being claimed about: everything unmatched.
    expect(small.summary.unmatched).toBe(100);
    expect(large.summary.unmatched).toBe(1160);

    process.stderr.write(
      `[2620] N=100  total=${small.total} fallback=${small.fallback} ms=${small.ms}\n` +
        `[2620] N=1160 total=${large.total} fallback=${large.fallback} ms=${large.ms}\n`,
    );

    expect(large.fallback).toBe(small.fallback);
    // And the whole pass, not just the fallback: four index loads plus the one
    // read of `external_contacts`. Naming the number means an extra per-record
    // statement introduced later cannot hide inside "roughly constant".
    expect(large.total).toBe(5);
    expect(small.total).toBe(5);
  });

  /**
   * CONTROL 2 — THE ANTI-TRAP, and the reason this is not a "skip what didn't
   * match" patch.
   *
   * A record that matched nothing must be reconsidered when the contact set
   * changes. Its RED state is the staleness this design forbids: share ONE
   * index across both passes, which is exactly what caching a negative result
   * would amount to, and the record stays unmatched.
   */
  it("CONTROL 2 — a record that matched nothing links to a contact created AFTER it", async () => {
    db = makeDb();
    setDb(db);
    addRecord("rec-late", { emails: ["casey.lane@example.com"], name: "Casey Lane" });

    const first = linkExternalContactsForUser(USER_ID);
    expect(idsOf(first, "no_match")).toEqual(["rec-late"]);
    expect(crosswalkPairs()).toEqual([]);

    const contact = await createContact(
      {
        user_id: USER_ID,
        display_name: "Casey Lane",
        source: "manual",
        email: "casey.lane@example.com",
      } as Parameters<typeof createContact>[0],
      { kind: "derived" },
    );

    const second = linkExternalContactsForUser(USER_ID);
    expect(idsOf(second, "linked")).toEqual(["rec-late"]);
    expect(crosswalkPairs()).toContainEqual([contact.id, "rec-late"]);
  });

  /**
   * CONTROL 3 — one case per way the contact set can change, each driven
   * through the write path the app actually uses.
   */
  describe("CONTROL 3 — every way the contact set changes is seen by the next pass", () => {
    it("3a — an email ADDED to an existing contact links a record that did not match before", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3a", { emails: ["sam.hale@example.com"], name: "Sam Hale" });
      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "Sam Hale",
          source: "manual",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "no_match")).toEqual(["rec-3a"]);

      syncContactEmails(contact.id, [{ email: "sam.hale@example.com", is_primary: true }]);

      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3a"]);
      expect(crosswalkPairs()).toContainEqual([contact.id, "rec-3a"]);
    });

    it("3b — an identifier REMOVED from a contact returns its record to no_match", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3b", { phones: ["+14155550123"], name: "Lee Park" });
      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "Lee Park",
          source: "manual",
          phone: "+14155550123",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3b"]);

      // The crosswalk now claims the record, so STEP 1 would answer it forever.
      // Removing that row is what makes this a test of the CONTENT path.
      db.prepare("DELETE FROM contact_source_links WHERE source_record_id = ?").run("rec-3b");
      syncContactPhones(contact.id, []);

      expect(idsOf(linkExternalContactsForUser(USER_ID), "no_match")).toEqual(["rec-3b"]);
    });

    it("3c — an identifier MOVED between contacts re-points the record to the new holder", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3c", { emails: ["mo.park@example.com"], name: "Mo Park" });
      const first = await createContact(
        {
          user_id: USER_ID,
          display_name: "Mo Park",
          source: "manual",
          email: "mo.park@example.com",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );
      const second = await createContact(
        {
          user_id: USER_ID,
          display_name: "Mo Park",
          source: "manual",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3c"]);
      expect(crosswalkPairs()).toContainEqual([first.id, "rec-3c"]);

      // Move the address, and drop the crosswalk row so the content path is the
      // one under test rather than STEP 1's memory of the old answer.
      syncContactEmails(first.id, []);
      syncContactEmails(second.id, [{ email: "mo.park@example.com", is_primary: true }]);
      db.prepare("DELETE FROM contact_source_links WHERE source_record_id = ?").run("rec-3c");

      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3c"]);
      expect(crosswalkPairs()).toContainEqual([second.id, "rec-3c"]);
    });

    /**
     * 3d — DELETE AND RESTORE CHANGE NOTHING, AND THAT IS THE SHIPPED
     * BEHAVIOUR, NOT AN OVERSIGHT OF THIS CHANGE.
     *
     * Removing a contact is a TOMBSTONE (`contacts.removed_at`), and neither
     * matching query filters on it — so a removed contact has always remained a
     * link candidate. This pins that, because "the batch index missed the
     * delete" and "the linker never looked at deletes" would otherwise be
     * indistinguishable from the outside. Changing the behaviour is a separate
     * decision with a user-visible consequence; it is not this item's.
     */
    it("3d — a tombstoned contact is still a candidate, before and after (existing behaviour, pinned)", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3d", { emails: ["sam.rivers@example.com"], name: "Sam Rivers" });
      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "Sam Rivers",
          source: "manual",
          email: "sam.rivers@example.com",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      await deleteContact(contact.id);
      db.prepare("DELETE FROM contact_source_links WHERE source_record_id = ?").run("rec-3d");
      expect(
        db.prepare("SELECT removed_at FROM contacts WHERE id = ?").get(contact.id),
      ).not.toEqual({ removed_at: null });

      const whileRemoved = linkExternalContactsForUser(USER_ID);
      expect(idsOf(whileRemoved, "linked")).toEqual(["rec-3d"]);
      expect(crosswalkPairs()).toContainEqual([contact.id, "rec-3d"]);

      await restoreContact(contact.id);
      db.prepare("DELETE FROM contact_source_links WHERE source_record_id = ?").run("rec-3d");
      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3d"]);
    });

    it("3e — the RECORD's own identifiers changing is seen on the next pass", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3e", { emails: ["old.address@example.com"], name: "Jane Seller" });
      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "Jane Seller",
          source: "manual",
          email: "new.address@example.com",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "no_match")).toEqual(["rec-3e"]);

      // What a sync does: rewrite the shadow row.
      db.prepare("UPDATE external_contacts SET emails_json = ? WHERE external_record_id = ?").run(
        JSON.stringify(["new.address@example.com"]),
        "rec-3e",
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "linked")).toEqual(["rec-3e"]);
      expect(crosswalkPairs()).toContainEqual([contact.id, "rec-3e"]);
    });

    it("3f — a crosswalk row written between passes is honoured at STEP 1", async () => {
      db = makeDb();
      setDb(db);
      addRecord("rec-3f", { emails: ["typed.by.hand@example.com"], name: "John Smith" });
      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "John Smith",
          source: "manual",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      expect(idsOf(linkExternalContactsForUser(USER_ID), "no_match")).toEqual(["rec-3f"]);

      createLink({
        userId: USER_ID,
        contactId: contact.id,
        sourceType: "macos",
        sourceRecordId: "rec-3f",
        matchMethod: "manual",
      });

      expect(idsOf(linkExternalContactsForUser(USER_ID), "already_linked")).toEqual(["rec-3f"]);
    });

    /**
     * 3g — THE ONE THE ITEM DOES NOT NAME, and the only invalidation that has
     * to happen DURING a pass.
     *
     * A content match calls `applyLinkedSourceValues`, which copies the source
     * record's addresses onto the contact. Those are rows the index is built
     * from, so a LATER record in the SAME pass can legitimately match through an
     * address this pass just created. With per-record SQL that was free; with a
     * batch index it needs `noteContactValuesChanged`, and its RED state is
     * deleting that call.
     */
    it("3g — a record matches through an address an EARLIER record's link contributed in the same pass", async () => {
      db = makeDb();
      setDb(db);
      // Record A: matches Ada by email, and also carries her phone.
      addRecord("rec-a", {
        emails: ["dana.example@example.com"],
        phones: ["+15125550144"],
        name: "Dana Example",
      });
      // Record B: carries ONLY that phone. The saved contact does not have it
      // until record A's link copies it across, mid-pass.
      addRecord("rec-b", { phones: ["+15125550144"], name: "Dana Example", source: "outlook" });

      const contact = await createContact(
        {
          user_id: USER_ID,
          display_name: "Dana Example",
          source: "manual",
          email: "dana.example@example.com",
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );

      const summary = linkExternalContactsForUser(USER_ID);

      expect(idsOf(summary, "linked").sort()).toEqual(["rec-a", "rec-b"]);
      expect(crosswalkPairs()).toContainEqual([contact.id, "rec-b"]);
    });
  });

  /**
   * CONTROL 5 — the id-matched steady state, which is where this feature ENDS
   * UP, not where the founder is today.
   *
   * STEP 1 backfills `external_uuid` onto a crosswalk row that predates it. That
   * call was made on EVERY pass for every id-matched record carrying a uuid: a
   * SELECT plus an UPDATE whose `external_uuid` is COALESCE'd, so on a row that
   * already has one it wrote nothing but `updated_at`. Once linking works and
   * every record id-matches, that is 1,169 pointless writes per pass.
   *
   * Both halves are asserted here because the obvious "fix" — never call it —
   * silently disables the backfill, and NOTHING IN THE SUITE WOULD HAVE NOTICED:
   * mutating the condition to `false` left all 62 tests in this suite and
   * `contactSourceLinker.test.ts` green. The existing uuid test covers the INSERT
   * path (a NEW link carries the uuid), never the backfill of an existing row.
   */
  it("CONTROL 5 — the uuid backfill happens once, and the pass after it writes nothing", () => {
    db = makeDb();
    setDb(db);
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES ('c-steady', ?, 'Test Contact', 1)",
    ).run(USER_ID);
    addRecord("rec-steady", {
      name: "Test Contact",
      emails: ["steady@example.com"],
      externalUuid: "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5062",
    });
    // A crosswalk row that predates the uuid column — exactly what the backfill
    // exists for.
    db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method, external_uuid)
       VALUES ('l-steady', ?, 'c-steady', 'macos', 'rec-steady', 'email', NULL)`,
    ).run(USER_ID);

    const firstCounter = countStatements(db);
    expect(idsOf(linkExternalContactsForUser(USER_ID), "already_linked")).toEqual(["rec-steady"]);
    firstCounter.stop();

    expect(
      db.prepare("SELECT external_uuid FROM contact_source_links WHERE id = 'l-steady'").get(),
    ).toEqual({ external_uuid: "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5062" });
    expect(
      firstCounter.executed.filter((s) => s.includes("UPDATE contact_source_links")).length,
    ).toBe(1);

    // Second pass: nothing has changed, so nothing may be written, and the only
    // statements are the pass's four index loads plus the record read.
    const secondCounter = countStatements(db);
    expect(idsOf(linkExternalContactsForUser(USER_ID), "already_linked")).toEqual(["rec-steady"]);
    secondCounter.stop();

    expect(secondCounter.executed.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s))).toEqual([]);
    expect(secondCounter.executed.length).toBe(5);
  });

  /**
   * CONTROL 4 — the two implementations answer identically.
   *
   * The batch index is a second implementation of three queries, and a second
   * implementation is a place for a silent divergence to live. Every case here
   * is one where a plausible map is WRONG:
   *
   *   - a stored address with a leading space (SQL `LOWER` does not trim, the
   *     probe side does — so it must NOT match);
   *   - case differences on both sides (SQL `LOWER` vs `toLowerCase`);
   *   - email wins over phone even when the phone would match a different
   *     contact (the email-first short circuit);
   *   - one contact reached by two of a record's emails (the live query's
   *     DISTINCT);
   *   - two contacts sharing one identifier, where `matches[0]` decides which
   *     contact the question names — so ORDER matters, not just membership;
   *   - `VERIZON` and a short code, which `toLookupKey` passes through;
   *   - a `contact_phones` row with a NULL `phone_normalized`, which `IN` can
   *     never match;
   *   - a record with no identifiers at all.
   */
  it("CONTROL 4 — live and batch resolution agree, record for record, on a corpus built to break them", () => {
    db = makeDb();
    setDb(db);
    seedParityCorpus(db);

    const candidates = readCandidates();
    expect(candidates.length).toBeGreaterThan(8);

    // Resolve with the live per-record index, on a pristine copy of the data.
    const live = candidates.map((c) => resolveSourceRecord(USER_ID, c));
    const liveCrosswalk = crosswalkPairs();

    // Rebuild byte-identically and resolve with the batch index.
    db.close();
    db = makeDb();
    setDb(db);
    seedParityCorpus(db);
    const batch = linkSourceRecords(USER_ID, readCandidates()).resolutions;

    expect(batch).toEqual(live);
    expect(crosswalkPairs()).toEqual(liveCrosswalk);
  });
});
