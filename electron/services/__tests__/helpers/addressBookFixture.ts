/**
 * Real macOS address-book fixtures — BACKLOG-2392.
 *
 * These build actual `.abcddb` SQLite files with the real Core Data table shape
 * (`ZABCDRECORD` / `ZABCDPHONENUMBER` / `ZABCDEMAILADDRESS`), so the tests drive
 * the shipped reader against a real driver instead of a hand-written fake that
 * agrees with whatever the reader happens to do.
 *
 * That distinction is the point: a fake sqlite3 cannot exhibit WAL semantics,
 * cannot fail to open, and cannot disagree with the SQL we actually wrote — and
 * all three of those are defects this task exists to fix.
 *
 * The writer is `better-sqlite3-multiple-ciphers` (synchronous, and already the
 * app's own native dependency) while the code under test reads through
 * `sqlite3`. Two independent drivers means the WAL test is a genuine
 * cross-connection check rather than one library agreeing with itself.
 *
 * NEVER point these at a real address book. Everything here writes to a
 * caller-supplied temp directory.
 */

import path from "path";
import fs from "fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * The subset of the real schema the reader touches. Column names and types are
 * taken from a live store; `Z_PK` is deliberately sparse and out of order in
 * the fixtures below to mirror the 449 gaps observed in 1128 real rows.
 */
const SCHEMA = `
  CREATE TABLE ZABCDRECORD (
    Z_PK INTEGER PRIMARY KEY,
    Z_ENT INTEGER,
    ZUNIQUEID TEXT,
    ZFIRSTNAME TEXT,
    ZLASTNAME TEXT,
    ZORGANIZATION TEXT,
    -- BACKLOG-2401: the CardDAV server-side identity that sits beside the
    -- device-local ZUNIQUEID. The reader SELECTs it, so the fixture must
    -- declare it or every reader test dies on "no such column". Nullable and
    -- usually NULL here, mirroring the real store where 3 of 1128 rows (a
    -- group, an info row and a container) have none.
    ZEXTERNALUUID TEXT
  );
  CREATE TABLE ZABCDPHONENUMBER (
    Z_PK INTEGER PRIMARY KEY,
    ZOWNER INTEGER,
    ZFULLNUMBER TEXT
  );
  CREATE TABLE ZABCDEMAILADDRESS (
    Z_PK INTEGER PRIMARY KEY,
    ZOWNER INTEGER,
    ZADDRESS TEXT
  );
`;

export interface FixtureRecord {
  /** Core Data rowid. Intentionally arbitrary — it must not reach any output. */
  pk: number;
  /**
   * Full ZUNIQUEID, e.g. `AAAA-1111:ABPerson`. The suffix decides record type;
   * pass `:ABGroup` / `:ABInfo` / `:ABContainer` to build a non-person row.
   * Pass `null` to build a row with no unique id at all.
   */
  uid: string | null;
  first?: string;
  last?: string;
  org?: string;
  phones?: string[];
  emails?: string[];
  /**
   * BACKLOG-2401 — ZEXTERNALUUID. A bare 36-char UUID in the real store, and
   * never equal to the UUID portion of ZUNIQUEID, so tests that assert the two
   * are carried independently must be able to set it explicitly.
   */
  externalUuid?: string | null;
}

/** Write a complete `.abcddb`, creating parent directories as needed. */
export function writeAddressBook(dbPath: string, records: FixtureRecord[]): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new RealDatabase(dbPath);
  try {
    db.exec(SCHEMA);
    insertRecords(db, records);
  } finally {
    db.close();
  }
}

function insertRecords(
  db: InstanceType<typeof RealDatabase>,
  records: FixtureRecord[],
): void {
  const rec = db.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZUNIQUEID, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZEXTERNALUUID)
     VALUES (?, 15, ?, ?, ?, ?, ?)`,
  );
  const phone = db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)",
  );
  const email = db.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)",
  );

  for (const r of records) {
    rec.run(r.pk, r.uid, r.first ?? null, r.last ?? null, r.org ?? null, r.externalUuid ?? null);
    for (const p of r.phones ?? []) phone.run(r.pk, p);
    for (const e of r.emails ?? []) email.run(r.pk, e);
  }
}

/**
 * A WAL-mode store whose newest rows are ONLY in the `-wal` file.
 *
 * Returns the still-open writer connection: the caller must keep it open for
 * the duration of the read and close it in cleanup. Closing the last connection
 * checkpoints the WAL back into the main file, which would erase the very
 * condition under test.
 *
 * `wal_autocheckpoint = 0` stops SQLite folding the WAL back in on its own.
 */
export function writeWalAddressBook(
  dbPath: string,
  committed: FixtureRecord[],
  pending: FixtureRecord[],
): { writer: InstanceType<typeof RealDatabase>; walBytes: number } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Pass 1: create + checkpoint the committed rows into the main file.
  const seed = new RealDatabase(dbPath);
  seed.exec(SCHEMA);
  insertRecords(seed, committed);
  seed.close();

  // Pass 2: a fresh connection writes the pending rows and STAYS OPEN, so they
  // remain in the -wal exactly like a running Contacts.app leaves them.
  const writer = new RealDatabase(dbPath);
  writer.pragma("journal_mode = WAL");
  writer.pragma("wal_autocheckpoint = 0");
  insertRecords(writer, pending);

  const walBytes = fs.existsSync(`${dbPath}-wal`)
    ? fs.statSync(`${dbPath}-wal`).size
    : 0;

  return { writer, walBytes };
}

/** A file that exists, ends in `.abcddb`, and is not a database. */
export function writeCorruptAddressBook(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from("this is not a sqlite database ".repeat(64)));
}
