/**
 * @jest-environment node
 *
 * BACKLOG-2394 — the Storage section of the support-ticket diagnostics block.
 *
 * Driven against a REAL SQLite database built with the app's own native driver,
 * not a hand-written fake. A fake cannot disagree with the SQL we actually
 * wrote, and "the SQL is wrong" is one of the two things this section could
 * plausibly get wrong (the other is the zero trap, below).
 *
 * The tickets each assertion group answers are named inline. They are real:
 * nine were filed in one day and five of them were answerable from counts
 * nobody was collecting.
 */

import fs from "fs";
import os from "os";
import path from "path";

// The real driver, required by path so jest's moduleNameMapper mock for
// `better-sqlite3-multiple-ciphers` does not intercept it — same trick the
// BACKLOG-2392 address-book fixtures use, and for the same reason.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  collectStorageDiagnostics,
  formatBytes,
  formatStorageDiagnostics,
  type StorageQueryable,
} from "../storageDiagnostics";

/** The subset of the real schema this section reads. */
const SCHEMA = `
  CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER);
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, source TEXT
  );
  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY, contact_id TEXT, phone_e164 TEXT, phone_normalized TEXT
  );
  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY, contact_id TEXT, email TEXT
  );
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT, source TEXT
  );
  CREATE TABLE emails (
    id TEXT PRIMARY KEY, user_id TEXT, subject TEXT, sender TEXT, sent_at DATETIME
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, user_id TEXT, body_text TEXT, sent_at DATETIME
  );
  CREATE TABLE attachments (id TEXT PRIMARY KEY, filename TEXT);
  CREATE TABLE transactions (id TEXT PRIMARY KEY, property_address TEXT);
  CREATE TABLE transaction_contacts (transaction_id TEXT, contact_id TEXT);
  CREATE TABLE communications (id TEXT PRIMARY KEY, user_id TEXT);
  CREATE TABLE email_participants (
    id INTEGER PRIMARY KEY, email_id TEXT, email_address TEXT
  );
  CREATE TABLE email_sync_state (
    user_id TEXT, account_id TEXT, oldest_cached_at DATETIME
  );
  CREATE TABLE message_import_state (
    user_id TEXT PRIMARY KEY, deepest_import_start DATETIME
  );
`;

// Deliberately real-looking PII in every text column. If any of it reaches the
// composed block, the PII assertion below has something to catch.
const CONTACT_NAME = "Margaret Ellsworth";
const CONTACT_EMAIL = "margaret.ellsworth@cbolympia.com";
const CONTACT_PHONE = "+13605550147";
const EMAIL_SUBJECT = "Re: 1428 Cedar Ridge Dr — inspection response";

let tmpRoot: string;
let dbPath: string;
let db: InstanceType<typeof RealDatabase>;

function seed(opts: {
  version?: number;
  contacts?: number;
  phonesNormalized?: number;
  phonesUnnormalized?: number;
  emailsRows?: number;
  messagesRows?: number;
  messageDeepestScan?: string | null;
}): void {
  db.exec(SCHEMA);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(
    opts.version ?? 56,
  );

  const insContact = db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, 'u1', ?, ?)",
  );
  const insPhone = db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES (?, ?, ?, ?)",
  );
  const insEmailAddr = db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)",
  );

  const n = opts.contacts ?? 0;
  for (let i = 0; i < n; i++) {
    insContact.run(`c${i}`, `${CONTACT_NAME} ${i}`, i % 2 === 0 ? "contacts_app" : "manual");
  }

  const normalized = opts.phonesNormalized ?? 0;
  const unnormalized = opts.phonesUnnormalized ?? 0;
  for (let i = 0; i < normalized; i++) {
    insPhone.run(`p${i}`, `c${i % Math.max(n, 1)}`, CONTACT_PHONE, "3605550147");
  }
  for (let i = 0; i < unnormalized; i++) {
    // The ticket-94 population: a phone row search can never match.
    insPhone.run(`u${i}`, `c${(normalized + i) % Math.max(n, 1)}`, CONTACT_PHONE, null);
  }

  for (let i = 0; i < Math.min(n, 3); i++) {
    insEmailAddr.run(`e${i}`, `c${i}`, CONTACT_EMAIL);
  }

  db.prepare(
    "INSERT INTO external_contacts (id, user_id, name, source) VALUES ('x1','u1',?, 'macos')",
  ).run(CONTACT_NAME);
  db.prepare(
    "INSERT INTO external_contacts (id, user_id, name, source) VALUES ('x2','u1',?, 'outlook')",
  ).run(CONTACT_NAME);

  const insEmail = db.prepare(
    "INSERT INTO emails (id, user_id, subject, sender, sent_at) VALUES (?, 'u1', ?, ?, ?)",
  );
  const emailRows = opts.emailsRows ?? 0;
  for (let i = 0; i < emailRows; i++) {
    insEmail.run(
      `em${i}`,
      EMAIL_SUBJECT,
      CONTACT_EMAIL,
      `2024-0${(i % 9) + 1}-03T10:00:00.000Z`,
    );
  }

  const insMsg = db.prepare(
    "INSERT INTO messages (id, user_id, body_text, sent_at) VALUES (?, 'u1', ?, ?)",
  );
  const msgRows = opts.messagesRows ?? 0;
  for (let i = 0; i < msgRows; i++) {
    insMsg.run(`m${i}`, "See you at the walkthrough", `2026-0${(i % 7) + 1}-14T09:00:00.000Z`);
  }

  if (opts.messageDeepestScan) {
    db.prepare(
      "INSERT INTO message_import_state (user_id, deepest_import_start) VALUES ('u1', ?)",
    ).run(opts.messageDeepestScan);
  }
}

function collect(): ReturnType<typeof collectStorageDiagnostics> {
  return collectStorageDiagnostics({
    db: db as unknown as StorageQueryable,
    dbPath,
    latestSchemaVersion: 56,
    locale: "en-US",
    timezone: "America/Los_Angeles",
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2394-storage-"));
  dbPath = path.join(tmpRoot, "mad.db");
  db = new RealDatabase(dbPath);
});

afterEach(() => {
  // Checkpoint before closing. The WAL test deliberately sets
  // `wal_autocheckpoint = 0`, which leaves a `-wal` and `-shm` alive; without
  // an explicit truncate the native handle can outlive the suite and jest
  // force-exits the worker ("failed to exit gracefully").
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* not in WAL mode, or already closed */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================
// FILE-LEVEL FACTS
// ============================================

describe("file and schema facts", () => {
  it("reports db size, wal size, free disk and the basename only", () => {
    seed({ contacts: 5 });
    const diag = collect();

    expect(diag.available).toBe(true);
    expect(diag.db_file).toBe("mad.db");
    expect(diag.db_bytes).toBeGreaterThan(0);
    expect(diag.free_disk_bytes).toBeGreaterThan(0);
    // The directory carries the account name and must never be reported.
    expect(diag.db_file).not.toContain(path.sep);
  });

  it("flags a pending migration when the on-disk version is behind the build", () => {
    seed({ version: 54 });
    const diag = collect();

    expect(diag.schema_version).toBe(54);
    expect(diag.latest_schema_version).toBe(56);
    expect(diag.migration_pending).toBe(true);
    expect(formatStorageDiagnostics(diag).join("\n")).toContain(
      "schema_version=54 (latest 56, MIGRATION PENDING)",
    );
  });

  it("says up to date when the versions match", () => {
    seed({ version: 56 });
    const block = formatStorageDiagnostics(collect()).join("\n");
    expect(block).toContain("schema_version=56 (latest 56, up to date)");
    expect(block).toContain("quick_check=ok");
  });

  describe("quick_check must not freeze the app on a large database", () => {
    /**
     * `PRAGMA quick_check` is synchronous and O(database size), and it runs on
     * the MAIN PROCESS the moment a user hits Submit on a support ticket. The
     * reporting user's database is 253 MB — checking it would freeze the app
     * while somebody is trying to tell us the app is broken.
     *
     * These assert the pragma is genuinely NOT EXECUTED above the bound, not
     * merely that the rendered label changed. A test on the label alone would
     * still pass if the expensive call were left in place.
     */
    function spyOn(realDb: StorageQueryable): {
      spy: StorageQueryable;
      pragmas: string[];
    } {
      const pragmas: string[] = [];
      return {
        pragmas,
        spy: {
          prepare: (sql: string) => realDb.prepare(sql),
          pragma: (sql: string, opts?: { simple?: boolean }) => {
            pragmas.push(sql);
            return realDb.pragma(sql, opts);
          },
        },
      };
    }

    it("skips the check above the size bound and never runs the pragma", () => {
      seed({ contacts: 2 });
      db.close();
      // Grow the file past the 64 MB bound without writing 64 MB of rows.
      fs.truncateSync(dbPath, 80 * 1024 * 1024);
      db = new RealDatabase(dbPath);

      const { spy, pragmas } = spyOn(db as unknown as StorageQueryable);
      const diag = collectStorageDiagnostics({
        db: spy,
        dbPath,
        latestSchemaVersion: 56,
      });

      expect(diag.db_bytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(diag.quick_check).toBe("skipped");
      expect(diag.quick_check_skipped).toBe("db-too-large");
      // The load-bearing assertion: the expensive pragma never ran.
      expect(pragmas).not.toContain("quick_check");

      const block = formatStorageDiagnostics(diag).join("\n");
      expect(block).toContain("quick_check=skipped (db too large)");
      // "skipped" must never read as a passing integrity check.
      expect(block).not.toContain("quick_check=ok");
    });

    it("runs the check below the bound", () => {
      seed({ contacts: 2 });
      const { spy, pragmas } = spyOn(db as unknown as StorageQueryable);
      const diag = collectStorageDiagnostics({
        db: spy,
        dbPath,
        latestSchemaVersion: 56,
      });

      expect(pragmas).toContain("quick_check");
      expect(diag.quick_check).toBe("ok");
      expect(diag.quick_check_skipped).toBeNull();
    });

    it("skips rather than guesses when the file size is unknown", () => {
      seed({ contacts: 2 });
      const { spy, pragmas } = spyOn(db as unknown as StorageQueryable);
      const diag = collectStorageDiagnostics({
        db: spy,
        dbPath: null,
        latestSchemaVersion: 56,
      });

      expect(diag.quick_check).toBe("skipped");
      expect(diag.quick_check_skipped).toBe("size-unknown");
      expect(pragmas).not.toContain("quick_check");
      expect(formatStorageDiagnostics(diag).join("\n")).toContain(
        "quick_check=skipped (db size unknown)",
      );
    });
  });

  it("reports the -wal size separately from the main file", () => {
    // A large WAL against an old main file is a real signal — one was observed
    // at 3.9 MB against a main file three months stale.
    seed({ contacts: 200 });
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('w1','u1','x','manual')").run();

    const diag = collect();
    expect(diag.wal_bytes).not.toBeNull();
    expect(diag.wal_bytes!).toBeGreaterThan(0);
    expect(diag.wal_present).toBe(true);
  });

  it("says wal none — not wal unknown — on a checkpointed store", () => {
    // No `-wal` file is the NORMAL state. Reporting it as "unknown" makes a
    // healthy machine look like one we failed to inspect, which is the same
    // confusion as reporting "never looked" as a zero.
    seed({ contacts: 3 });
    const diag = collect();
    const block = formatStorageDiagnostics(diag).join("\n");

    expect(diag.wal_present).toBe(false);
    expect(diag.wal_bytes).toBeNull();
    expect(block).toContain("(wal none)");
    expect(block).not.toContain("wal unknown");
  });
});

// ============================================
// ROW COUNTS AND BREAKDOWNS
// ============================================

describe("row counts and per-source breakdowns", () => {
  it("counts every table that exists and breaks contacts/external down by source", () => {
    seed({ contacts: 6, phonesNormalized: 4, phonesUnnormalized: 2, emailsRows: 9 });
    const diag = collect();

    expect(diag.tables).toMatchObject({
      contacts: 6,
      contact_phones: 6,
      external_contacts: 2,
    });
    // emails/messages are NOT in the raw count line — they carry their own
    // coverage lines, where a 0 is qualified rather than stated bare.
    expect(Object.keys(diag.tables!)).not.toContain("emails");
    expect(Object.keys(diag.tables!)).not.toContain("messages");
    expect(diag.contacts_by_source).toEqual({ contacts_app: 3, manual: 3 });
    expect(diag.external_contacts_by_source).toEqual({ macos: 1, outlook: 1 });

    const block = formatStorageDiagnostics(diag).join("\n");
    expect(block).toContain("external by source: macos=1, outlook=1");
  });

  it("omits a table that does not exist rather than reporting it as 0", () => {
    // A database mid-migration genuinely lacks tables. "attachments=0" would
    // claim the user has no attachments; the truth is the table is not there.
    db.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT, source TEXT)");
    const diag = collect();

    expect(diag.tables).toEqual({ contacts: 0 });
    expect(Object.keys(diag.tables!)).not.toContain("attachments");
  });
});

// ============================================
// TICKET 94 — search cannot match what was never normalized
// ============================================

describe("data quality (ticket 94: phone search returns nothing)", () => {
  it("reports the gap between phone rows and normalized phone rows", () => {
    seed({ contacts: 4, phonesNormalized: 1, phonesUnnormalized: 7 });
    const diag = collect();

    expect(diag.data_quality!.phone_rows).toBe(8);
    expect(diag.data_quality!.phone_rows_normalized).toBe(1);

    const block = formatStorageDiagnostics(diag).join("\n");
    // This single line IS the answer to the ticket.
    expect(block).toContain("phone rows: 8 (normalized 1)");
  });

  it("reports contacts with a phone, with an email, and with neither (ticket 100)", () => {
    seed({ contacts: 5, phonesNormalized: 2, phonesUnnormalized: 0 });
    const diag = collect();

    // 2 phone rows on c0/c1; 3 contacts have an email (c0,c1,c2).
    expect(diag.data_quality!.contacts_with_phone).toBe(2);
    expect(diag.data_quality!.contacts_with_email).toBe(3);
    expect(diag.data_quality!.contacts_with_neither).toBe(2);
  });
});

// ============================================
// TICKET 99 — THE ZERO TRAP ON COVERAGE
// ============================================

describe("import coverage (ticket 99) and the zero trap", () => {
  it("reports the imported date range when rows exist", () => {
    seed({ messagesRows: 6, messageDeepestScan: "2025-11-02T00:00:00.000Z" });
    const block = formatStorageDiagnostics(collect()).join("\n");

    expect(block).toMatch(/messages: 6 \(2026-01-14 → 2026-06-14\), scanned back to 2025-11-02/);
  });

  it("says NEVER LOOKED, not zero, when no import has been recorded", () => {
    seed({ messagesRows: 0 });
    const diag = collect();
    const block = formatStorageDiagnostics(diag).join("\n");

    expect(diag.coverage!.messages.rows).toBe(0);
    expect(diag.coverage!.messages.deepest_scanned).toBeNull();
    // The load-bearing distinction. "messages: 0" alone would read as
    // "this user has no texts"; the truth is nothing has looked.
    expect(block).toContain(
      "messages: 0 rows, and NO import has been recorded — never looked, not empty",
    );
    expect(block).not.toMatch(/messages: 0$/m);
    expect(block).not.toMatch(/messages=0,/);
  });

  it("distinguishes looked-and-found-nothing from never-looked", () => {
    seed({ messagesRows: 0, messageDeepestScan: "2025-11-02T00:00:00.000Z" });
    const block = formatStorageDiagnostics(collect()).join("\n");

    expect(block).toContain("messages: 0 rows — imported back to 2025-11-02 and found none");
    // Scoped to the messages line: emails legitimately says "never looked" in
    // this fixture, and asserting on the whole block would pass for the wrong
    // reason (or fail for one).
    const messagesLine = block.split("\n").find((l) => l.includes("messages:"))!;
    expect(messagesLine).not.toContain("never looked");
  });
});

// ============================================
// UNAVAILABLE DATABASE
// ============================================

describe("an unopened database reports why, not zeros", () => {
  it("emits no row counts at all when the handle is missing", () => {
    const diag = collectStorageDiagnostics({
      db: null,
      dbPath,
      latestSchemaVersion: 56,
    });
    const block = formatStorageDiagnostics(diag).join("\n");

    expect(diag.available).toBe(false);
    expect(diag.unavailable_reason).toBe("db-not-initialized");
    expect(diag.tables).toBeNull();
    expect(block).toContain("unavailable (db-not-initialized)");
    expect(block).not.toContain("contacts=");
    expect(block).not.toContain("rows:");
  });

  it("still reports the file size, because a database that failed to open still has one", () => {
    seed({ contacts: 3 });
    const diag = collectStorageDiagnostics({
      db: null,
      dbPath,
      latestSchemaVersion: 56,
    });
    expect(diag.db_bytes).toBeGreaterThan(0);
  });
});

// ============================================
// PII
// ============================================

describe("PII: the composed section carries none", () => {
  it("contains no contact name, email, phone, subject line or absolute path", () => {
    seed({
      contacts: 6,
      phonesNormalized: 3,
      phonesUnnormalized: 3,
      emailsRows: 9,
      messagesRows: 4,
      messageDeepestScan: "2025-11-02T00:00:00.000Z",
    });

    const diag = collect();
    // Flatten AND serialise: a recent PR shipped absolute paths because only
    // the rendered level was asserted on and the paths sat in an object.
    const everything = `${formatStorageDiagnostics(diag).join("\n")}\n${JSON.stringify(diag)}`;
    // Byte counts are the ONLY legitimate long digit runs in this section, and
    // only in the serialised form (the rendered form humanises them). Masking
    // them by name keeps the `\d{9,}` check below able to fire on anything
    // else — a raw phone number, an epoch timestamp, an id.
    const masked = everything.replace(
      /"(db_bytes|wal_bytes|free_disk_bytes)":\d+/g,
      '"$1":<bytes>',
    );

    expect(everything).not.toContain(CONTACT_NAME);
    expect(everything).not.toContain("Margaret");
    expect(everything).not.toContain(CONTACT_EMAIL);
    expect(everything).not.toContain(CONTACT_PHONE);
    expect(everything).not.toContain(EMAIL_SUBJECT);
    expect(everything).not.toContain("Cedar Ridge");
    expect(everything).not.toContain(tmpRoot);
    expect(everything).not.toContain(dbPath);
    expect(everything).not.toMatch(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    expect(everything).not.toMatch(/\+\d{10,}/);
    expect(masked).not.toMatch(/\d{9,}/);
  });
});

describe("formatBytes", () => {
  it("renders human sizes and distinguishes unknown from zero", () => {
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(3_985_408)).toBe("3.8MB");
    expect(formatBytes(44_000_000_000)).toBe("41.0GB");
  });
});
