/**
 * @jest-environment node
 *
 * BACKLOG-2392 defect 4 — WAL-correct reads.
 *
 * macOS address books are SQLite in WAL mode and Contacts.app keeps a writer
 * open, so recent changes live in the sibling `-wal` file rather than in the
 * `.abcddb`. Verified on a real machine: a store's main file was last written
 * months before its `-wal`, which had grown to 3.9 MB.
 *
 * The failure mode is that there is NO failure mode to observe. Reading a
 * detached copy of the `.abcddb` returns months-old contacts and reports
 * success — no error, no warning, nothing in a log. That is why this file
 * exists and why it uses real SQLite: a fake driver has no WAL to get wrong.
 *
 * The fixture writer is `better-sqlite3-multiple-ciphers` while the code under
 * test reads through `sqlite3`, so this is a genuine cross-connection check
 * rather than one library agreeing with itself.
 */

import path from "path";
import fs from "fs";
import os from "os";

// Real driver, resolved by absolute path so jest's `^sqlite3$` moduleNameMapper
// does not swap in the stub. A stub cannot hold a WAL.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getContactNames, loadContactsFromDatabase } from "../contactsService";
import { resetContactIngestionFunnel } from "../contactIngestionFunnel";
import { writeWalAddressBook, type FixtureRecord } from "./helpers/addressBookFixture";

/** Already checkpointed into the main `.abcddb`. */
const COMMITTED: FixtureRecord[] = [
  { pk: 1, uid: "OLD-0001:ABPerson", first: "Olive", last: "Older", phones: ["+15551110001"] },
  { pk: 2, uid: "OLD-0002:ABPerson", first: "Oscar", last: "Older", emails: ["oscar@example.com"] },
];

/** Written by a second connection and left sitting in the `-wal`. */
const PENDING: FixtureRecord[] = [
  { pk: 3, uid: "NEW-0003:ABPerson", first: "Nina", last: "Newer", phones: ["+15559990003"] },
  { pk: 4, uid: "NEW-0004:ABPerson", first: "Nate", last: "Newer", emails: ["nate@example.com"] },
];

const COMMITTED_IDS = ["OLD-0001:ABPerson", "OLD-0002:ABPerson"];
const PENDING_IDS = ["NEW-0003:ABPerson", "NEW-0004:ABPerson"];

describe("BACKLOG-2392: address books are read WAL-correctly", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let baseDir: string;
  let dbPath: string;
  let writer: { close: () => void } | null = null;

  const idsOf = (contacts: Array<{ recordId?: string }> | undefined): string[] =>
    (contacts ?? []).map((c) => c.recordId!).sort();

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-wal-"));
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    dbPath = path.join(baseDir, "AddressBook-v22.abcddb");
    process.env.HOME = home;
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    // Closing the writer checkpoints the WAL, so it must happen AFTER the read.
    if (writer) {
      writer.close();
      writer = null;
    }
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Build the store and hold the writer open, as a running Contacts.app does. */
  function buildWalStore(): number {
    const built = writeWalAddressBook(dbPath, COMMITTED, PENDING);
    writer = built.writer;
    return built.walBytes;
  }

  it("the fixture really does leave rows in an uncheckpointed -wal", () => {
    const walBytes = buildWalStore();

    // Guard on the fixture itself. If the WAL were empty, every assertion below
    // would pass for the wrong reason — this is the exact shape of false green
    // that makes a checkpoint bug invisible.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(walBytes).toBeGreaterThan(0);
  });

  it("sees rows that exist ONLY in the -wal", async () => {
    buildWalStore();

    const result = await getContactNames();

    expect(idsOf(result.contacts)).toEqual([...COMMITTED_IDS, ...PENDING_IDS].sort());
  });

  it("resolves a phone number written only to the -wal", async () => {
    buildWalStore();

    const { contactMap } = await getContactNames();

    expect(contactMap["+15559990003"]).toBe("Nina Newer");
  });

  it("the single-book loader is WAL-correct too", async () => {
    buildWalStore();

    const result = await loadContactsFromDatabase(dbPath);

    expect(idsOf(result.contacts)).toEqual([...COMMITTED_IDS, ...PENDING_IDS].sort());
  });

  /**
   * The control that gives the tests above their meaning.
   *
   * This is not testing our code — it is demonstrating, against real SQLite,
   * that the mistake this ticket guards against is SILENT. If a future change
   * copies the `.abcddb` to work around Full Disk Access, this is precisely
   * what the user gets: an older address book, and a success status.
   */
  it("proves a detached copy of the .abcddb silently returns STALE data", async () => {
    buildWalStore();

    const detachedDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-detached-"));
    const detached = path.join(detachedDir, "AddressBook-v22.abcddb");
    fs.copyFileSync(dbPath, detached); // the -wal and -shm deliberately left behind

    try {
      const result = await loadContactsFromDatabase(detached);

      // No error. No warning. Just the wrong contacts.
      expect(idsOf(result.contacts)).toEqual([...COMMITTED_IDS].sort());
      for (const missing of PENDING_IDS) {
        expect(idsOf(result.contacts)).not.toContain(missing);
      }
    } finally {
      fs.rmSync(detachedDir, { recursive: true, force: true });
    }
  });
});
