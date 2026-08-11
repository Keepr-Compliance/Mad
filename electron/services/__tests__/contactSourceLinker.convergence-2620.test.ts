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
  resolveSourceRecord,
  type LinkResolution,
} from "../contactSourceLinker";
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

const USER_ID = "user-2620";

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(V40_INDEX_SQL);
  db.exec(V57_EXTERNAL_UUID_SQL);
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
// The measurement
// ---------------------------------------------------------------------------

describe("BACKLOG-2620 — the linking pass does not scale its SQL with unmatched records", () => {
  let db: DatabaseType;

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
  });
});
