/**
 * @jest-environment node
 *
 * BACKLOG-2394 — the Contacts and Storage sections, driven END TO END.
 *
 * The two section-level suites (`contactsDiagnostics.test.ts`,
 * `storageDiagnostics.test.ts`) test the collectors in isolation. This one
 * exists for the seam they cannot cover: the whole path a real ticket takes.
 *
 *   real address-book files on disk
 *     -> the real collectors
 *       -> the real `sanitizeDiagnostics()` gate
 *         -> the real `composeDiagnosticsSummary()`
 *           -> the string a support engineer pastes into a public issue
 *
 * `os` is NOT mocked here (unlike the sibling suite), because `sanitizeDiagnostics`
 * redacts against `os.homedir()` and the whole point is to run that gate for
 * real against a home directory containing an account name.
 *
 * Every text column in the fixtures holds real-looking PII — a name, an email
 * address, an E.164 phone number, a subject line quoting a street address —
 * so the PII assertions have something to catch when they are wrong.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// ---- Fixture identity. `ACCOUNT` is also the home-directory name. ----------
const ACCOUNT = "margaret";
const CONTACT_NAME = "Margaret Ellsworth";
const CONTACT_EMAIL = "margaret.ellsworth@cbolympia.com";
const CONTACT_PHONE = "+13605550147";
const EMAIL_SUBJECT = "Re: 1428 Cedar Ridge Dr — inspection response";

let tmpRoot: string;
let home: string;
let dbPath: string;
let db: InstanceType<typeof RealDatabase> | null = null;

// ---- Mocks -----------------------------------------------------------------

jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.27.0") },
  BrowserWindow: { getFocusedWindow: jest.fn() },
}));

const mockIsInitialized = jest.fn().mockReturnValue(true);
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => mockIsInitialized(),
    getRawDatabase: () => db,
    getDatabasePath: () => dbPath,
    getLatestSchemaVersion: () => 56,
  },
}));

jest.mock("../databaseEncryptionService", () => ({
  __esModule: true,
  default: { isEncryptionAvailable: jest.fn().mockReturnValue(true) },
}));

jest.mock("../syncStatusService", () => ({
  syncStatusService: {
    getStatus: jest.fn().mockReturnValue({
      isAnyOperationRunning: false,
      currentOperation: null,
    }),
  },
}));

jest.mock("../deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("machine-guid-abc-123"),
}));

/**
 * A failure whose message embeds an absolute path AND an email address — the
 * exact shape that makes raw error text unsafe to carry, and the reason the
 * new sections report error CATEGORIES only.
 *
 * The path is built from the fixture home at call time rather than hard-coded.
 * That is not cosmetic: `sanitizeDiagnostics()` redacts by replacing the
 * literal `os.homedir()` string, so a hard-coded `/Users/margaret/...` would
 * sail straight through the gate and the test would be reporting a fixture
 * artifact as a product leak. (It also means the gate genuinely only covers
 * paths under the CURRENT home — see the PR notes.)
 */
jest.mock("../failureLogService", () => ({
  __esModule: true,
  default: {
    getRecentFailures: jest.fn(async () => [
      {
        operation: "contacts_sync",
        error_message:
          `EACCES: permission denied, open '${home}/Library/Application Support/AddressBook/AddressBook-v22.abcddb'` +
          ` while syncing margaret.ellsworth@cbolympia.com`,
        timestamp: "2026-07-28T14:02:00.000Z",
      },
    ]),
  },
}));

jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn().mockResolvedValue({ user: { id: "user-123" } }) },
}));

jest.mock("../connectionStatusService", () => ({
  __esModule: true,
  default: {
    checkAllConnections: jest.fn().mockResolvedValue({
      google: { connected: false },
      microsoft: { connected: true },
    }),
  },
}));

jest.mock("../deviceDetectionService", () => ({
  deviceDetectionService: {
    collectIphoneSyncDiagnostics: jest.fn().mockResolvedValue({
      libimobiledeviceAvailable: true,
      libimobiledeviceInPath: true,
      connectedDeviceCount: 0,
      deviceMounted: false,
      deviceDetected: false,
      driverMissingSuspected: false,
      trustState: null,
      windows: null,
    }),
  },
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({
    isInstalled: true,
    version: "1.2.3",
    serviceRunning: true,
  }),
}));

jest.mock("../pairingService", () => ({
  pairingService: { getStatus: jest.fn().mockReturnValue({ isPaired: false, devices: [] }) },
}));

jest.mock("../localSyncService", () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn().mockReturnValue({ running: false, lastSyncTimestamp: null }),
  },
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn().mockResolvedValue({}) },
}));

const mockCheckFda = jest.fn().mockResolvedValue({ hasPermission: true });
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: () => mockCheckFda() },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../updaterFailureStore", () => ({
  getRecentUpdaterFailure: jest.fn().mockReturnValue(null),
}));

import { collectDiagnostics, composeDiagnosticsSummary } from "../supportTicketService";
import {
  recordDiscovery,
  recordParse,
  recordPicker,
  recordShadowSync,
  resetContactIngestionFunnel,
} from "../contactIngestionFunnel";

// ---- Fixtures --------------------------------------------------------------

const BASE_REL = "Library/Application Support/AddressBook";

function makeBook(relPath: string): void {
  const full = path.join(home, BASE_REL, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

function makeDatabase(): void {
  db = new RealDatabase(dbPath);
  db.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, source TEXT);
    CREATE TABLE contact_phones (id TEXT PRIMARY KEY, contact_id TEXT, phone_e164 TEXT, phone_normalized TEXT);
    CREATE TABLE contact_emails (id TEXT PRIMARY KEY, contact_id TEXT, email TEXT);
    CREATE TABLE external_contacts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, source TEXT);
    CREATE TABLE emails (id TEXT PRIMARY KEY, user_id TEXT, subject TEXT, sender TEXT, sent_at DATETIME);
    CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, body_text TEXT, sent_at DATETIME);
    CREATE TABLE message_import_state (user_id TEXT PRIMARY KEY, deepest_import_start DATETIME);
  `);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 54)").run();
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c1','u1',?, 'contacts_app')",
  ).run(CONTACT_NAME);
  db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('p1','c1',?, NULL)",
  ).run(CONTACT_PHONE);
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email) VALUES ('e1','c1',?)",
  ).run(CONTACT_EMAIL);
  db.prepare(
    "INSERT INTO external_contacts (id, user_id, name, source) VALUES ('x1','u1',?, 'macos')",
  ).run(CONTACT_NAME);
  db.prepare(
    "INSERT INTO emails (id, user_id, subject, sender, sent_at) VALUES ('em1','u1',?,?, '2024-01-03T10:00:00.000Z')",
  ).run(EMAIL_SUBJECT, CONTACT_EMAIL);
  db.prepare(
    "INSERT INTO messages (id, user_id, body_text, sent_at) VALUES ('m1','u1','see you at the walkthrough','2026-07-28T09:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO message_import_state (user_id, deepest_import_start) VALUES ('u1','2025-11-02T00:00:00.000Z')",
  ).run();
}

function recordAFunnelRun(): void {
  recordDiscovery({
    found: 3,
    readCount: 1,
    failedCount: 2,
    usedFallback: false,
    candidates: [
      { path: "AddressBook-v22.abcddb", recordCount: 3, read: true },
      {
        path: "Sources/0CA70…/AddressBook-v22.abcddb",
        recordCount: null,
        read: false,
        skipReason: "read-error",
      },
      {
        path: "Sources/BBBBB…/AddressBook-v22.abcddb",
        recordCount: null,
        read: false,
        skipReason: "load-error",
      },
    ],
  });
  recordParse({
    books: 1,
    rowsRead: 716,
    nonPersonRows: 12,
    missingUniqueId: 0,
    phoneRows: 500,
    emailRows: 400,
    droppedRows: 12,
    nameless: 18,
    usable: 704,
    withPhone: 500,
    emailOnly: 100,
    neither: 104,
    labelFromContact: 18,
    unlabelled: 2,
  });
  recordShadowSync({
    source: "macos",
    inserted: 4,
    updated: 12,
    unchanged: 688,
    deleted: 0,
    total: 704,
  });
  recordPicker({
    dbRowsIn: 0,
    externalRowsIn: 704,
    rowsIn: 704,
    sourceDisabled: 0,
    alreadyImported: 105,
    duplicateSuppressed: 336,
    shown: 263,
  });
}

let realHomedir: typeof os.homedir;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2394-e2e-"));
  home = path.join(tmpRoot, "Users", ACCOUNT);
  fs.mkdirSync(home, { recursive: true });
  dbPath = path.join(tmpRoot, "keepr", "mad.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.HOME = home;
  realHomedir = os.homedir;
  // sanitizeDiagnostics redacts against os.homedir(); point it at the fixture
  // home so the real gate runs against the real account-name string.
  (os as { homedir: () => string }).homedir = () => home;

  resetContactIngestionFunnel();
  mockIsInitialized.mockReturnValue(true);
  mockCheckFda.mockResolvedValue({ hasPermission: true });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  (os as { homedir: () => string }).homedir = realHomedir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetContactIngestionFunnel();
});

async function composedBlock(): Promise<string> {
  const diag = await collectDiagnostics();
  return composeDiagnosticsSummary(diag);
}

// ============================================
// 1. A REAL MACHINE WITH THREE ADDRESS BOOKS
// ============================================

describe("a ticket from a machine with 3 address books", () => {
  it("carries the live count, the partial read, and the storage facts", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");
    makeBook("Sources/BBBBBBBB-2222-2222-2222-222222222222/AddressBook-v22.abcddb");
    makeDatabase();
    recordAFunnelRun();

    const block = await composedBlock();

    // The line that would have answered the very first ticket.
    expect(block).toContain("address books on disk: 3");
    expect(block).toContain("FDA=granted");
    // …and the gap between what is on disk and what we ingested.
    expect(block).toContain("read 1 of 3 (failed 2)");
    expect(block).toContain("parsed 716 rows from 1 book(s) -> usable 704");
    expect(block).toContain("picker 704 in");
    expect(block).toContain("shown 263");

    // Storage: schema behind the build, and the ticket-94 normalization gap.
    expect(block).toContain("schema_version=54 (latest 56, MIGRATION PENDING)");
    expect(block).toContain("phone rows: 1 (normalized 0)");
    expect(block).toContain("external by source: macos=1");
    // Ticket 99: the imported window and how far back the importer scanned.
    expect(block).toContain("scanned back to 2025-11-02");
  });

  it("never renders a never-synced machine as zeros", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");
    makeDatabase();
    // No funnel run recorded — the app just started.

    const block = await composedBlock();

    expect(block).toContain("address books on disk: 2");
    expect(block).toContain("no contacts read recorded since app start");
    expect(block).toContain("NOT a count of zero");
    // Not a single "read: 0" / "parsed 0" anywhere.
    expect(block).not.toMatch(/read \d+ of/);
    expect(block).not.toContain("parsed 0");
  });

  it("reports a failed storage collection as failed, not as an empty database", async () => {
    makeBook("AddressBook-v22.abcddb");
    mockIsInitialized.mockReturnValue(false);

    const block = await composedBlock();

    expect(block).toContain("unavailable (db-not-initialized)");
    expect(block).not.toContain("contacts=0");
  });
});

// ============================================
// 2. PII — THROUGH THE REAL SANITIZE GATE
// ============================================

describe("the composed block contains no PII", () => {
  it("carries no account name, absolute path, contact name, phone, email or subject", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");
    makeDatabase();
    recordAFunnelRun();

    const diag = await collectDiagnostics();
    const block = composeDiagnosticsSummary(diag);

    // Flatten and serialise EVERYTHING. A recent PR shipped absolute paths
    // because only one level was asserted on and the paths were hiding inside
    // a metadata object; asserting on the rendered string alone would repeat it.
    const everything = `${block}\n${JSON.stringify(diag)}`;
    // Byte counters are the only legitimate 9+ digit runs in the payload, and
    // only in the serialised form. Masking them BY NAME (rather than relaxing
    // the pattern) keeps the check below able to fire on a raw phone number,
    // an epoch timestamp or an id that appears anywhere else.
    const masked = everything.replace(
      /"(db_bytes|wal_bytes|free_disk_bytes|rss|heap_used|heap_total)":\d+/g,
      '"$1":<bytes>',
    );

    expect(everything).not.toContain(ACCOUNT);
    expect(everything).not.toContain(CONTACT_NAME);
    expect(everything).not.toContain(CONTACT_EMAIL);
    expect(everything).not.toContain(CONTACT_PHONE);
    expect(everything).not.toContain(EMAIL_SUBJECT);
    expect(everything).not.toContain("Cedar Ridge");
    expect(everything).not.toContain(home);
    expect(everything).not.toContain(tmpRoot);
    expect(everything).not.toMatch(/\/Users\//);
    expect(everything).not.toMatch(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    expect(everything).not.toMatch(/\+\d{10,}/);
    expect(everything).not.toMatch(/\(\d{3}\)\s*\d{3}-\d{4}/);
    expect(masked).not.toMatch(/\d{9,}/);
    // The full account-directory UUID is shortened, not printed whole.
    expect(everything).not.toContain("0CA70C1F-1234-5678-9ABC-DEF012345678");
  });

  it("keeps the diagnostics sections inside the sanitize gate", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeDatabase();

    // A funnel recorded with an ABSOLUTE path — i.e. a future caller forgetting
    // to redact upstream. `sanitizeDiagnostics()` is the last line of defence
    // and this asserts it actually covers the new sections.
    recordDiscovery({
      found: 1,
      readCount: 1,
      failedCount: 0,
      usedFallback: false,
      candidates: [
        {
          path: `${home}/Library/Application Support/AddressBook/AddressBook-v22.abcddb`,
          recordCount: 3,
          read: true,
        },
      ],
    });

    const diag = await collectDiagnostics();
    const everything = `${composeDiagnosticsSummary(diag)}\n${JSON.stringify(diag)}`;

    expect(everything).not.toContain(home);
    expect(everything).not.toContain(ACCOUNT);
    expect(everything).toContain("~/Library/Application Support/AddressBook");
  });
});
