/**
 * @jest-environment node
 *
 * BACKLOG-2391 — discovery and parse funnel stages.
 * BACKLOG-2392 — updated for "read EVERY address book".
 *
 * A reporter filed five contact tickets in one day. Her 1 MB log contained ZERO
 * lines mentioning `ContactsService`, `abcddb` or `AddressBook`, because file
 * discovery was logged at `debug` and production emits only `info` (3454 info /
 * 2606 warn / 25 error / 0 debug). Nobody could tell whether her address book
 * had been read at all.
 *
 * WHAT CHANGED IN 2392: the stage no longer reports which single book "won" —
 * there is no selection and no record-count threshold, because macOS stores one
 * database per account and reading only one of them WAS the bug. It now reports
 * how many accounts were found, read, and FAILED. `readCount`/`failedCount`
 * exist so that "read 2 of 3" cannot be mistaken for a clean run, which is the
 * whole reason this instrumentation exists.
 *
 * These tests drive the REAL `getContactNames()` over REAL `.abcddb` files, so
 * the assertions are about numbers the shipped code actually produces. The
 * previous version used a fake sqlite3 driver; a fake cannot fail to open,
 * cannot fail mid-read, and cannot disagree with the SQL we wrote — and all
 * three are things these counters now have to report.
 *
 * ASSERTION STYLE: exact numbers AND, for the parsed set, exact record-ID sets.
 * "usable: 20" is equally satisfied by keeping the wrong 20 people.
 */

import path from "path";
import fs from "fs";
import os from "os";

// Real driver, resolved by absolute path so jest's `^sqlite3$` moduleNameMapper
// does not swap in the stub.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

const mockLogInfo = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { getContactNames } from "../contactsService";
import {
  getContactIngestionFunnel,
  resetContactIngestionFunnel,
} from "../contactIngestionFunnel";
import {
  writeAddressBook,
  writeCorruptAddressBook,
  type FixtureRecord,
} from "./helpers/addressBookFixture";

const SOURCE_A = "AAAAAAAA-1111-2222-3333-444444444444";
const SOURCE_B = "BBBBBBBB-5555-6666-7777-888888888888";

// ---------------------------------------------------------------------------
// FIXTURES — engineered so EVERY parse counter is distinct and non-zero. A
// counter wired to the wrong branch cannot hide behind a coincidence.
// ---------------------------------------------------------------------------

/** "On My Mac": 3 people, all with a phone. Below the old >10 threshold. */
const LOCAL_BOOK: FixtureRecord[] = Array.from({ length: 3 }, (_, i) => ({
  pk: i + 1,
  uid: `D${i + 1}:ABPerson`,
  first: `Local${i + 1}`,
  last: "Person",
  phones: [`+1555100000${i}`],
}));

/**
 * iCloud: every shape at once.
 *   A1-A8   name + phone           -> withPhone
 *   A9,A10  name + email, no phone -> emailOnly
 *   A11     name only              -> neither
 *   A12     NO name, has an email  -> emailOnly AND labelFromContact
 *   groups/info/container          -> nonPersonRows
 *
 * The first group also OWNS a phone and an email, proving `phoneRows`/
 * `emailRows` count rows READ from the database rather than rows successfully
 * attached to a person.
 */
const ICLOUD_BOOK: FixtureRecord[] = [
  ...Array.from({ length: 8 }, (_, i) => ({
    pk: i + 1,
    uid: `A${i + 1}:ABPerson`,
    first: `Cloud${i + 1}`,
    last: "Person",
    phones: [`+1555200000${i}`],
  })),
  { pk: 9, uid: "A9:ABPerson", first: "Emailonly", last: "Nine", emails: ["a9@example.com"] },
  { pk: 10, uid: "A10:ABPerson", first: "Emailonly", last: "Ten", emails: ["a10@example.com"] },
  { pk: 11, uid: "A11:ABPerson", first: "Nameonly", last: "Eleven" },
  { pk: 12, uid: "A12:ABPerson", emails: ["nameless12@example.com"] },
  {
    pk: 900,
    uid: "AG1:ABGroup",
    first: "Sellers 2026",
    phones: ["+15559998888"],
    emails: ["group@example.com"],
  },
  { pk: 901, uid: "AG2:ABGroup", first: "Buyers 2026" },
  { pk: 902, uid: "AI1:ABInfo" },
  { pk: 903, uid: "AC1:ABContainer", org: "iCloud" },
];

/** Exchange: 5 people, all with a phone. */
const EXCHANGE_BOOK: FixtureRecord[] = Array.from({ length: 5 }, (_, i) => ({
  pk: i + 1,
  uid: `B${i + 1}:ABPerson`,
  first: `Work${i + 1}`,
  last: "Person",
  phones: [`+1555300000${i}`],
}));

const ALL_PERSON_IDS = [
  ...LOCAL_BOOK.map((r) => r.uid!),
  ...ICLOUD_BOOK.filter((r) => r.uid!.endsWith(":ABPerson")).map((r) => r.uid!),
  ...EXCHANGE_BOOK.map((r) => r.uid!),
].sort();

describe("BACKLOG-2391/2392: discovery + parse funnel", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let baseDir: string;

  const localPath = (): string => path.join(baseDir, "AddressBook-v22.abcddb");
  const sourcePath = (dir: string): string =>
    path.join(baseDir, "Sources", dir, "AddressBook-v22.abcddb");
  const lines = (): string[] => mockLogInfo.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-funnel-"));
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    fs.mkdirSync(baseDir, { recursive: true });
    process.env.HOME = home;
    mockLogInfo.mockClear();
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function buildAllThree(): void {
    writeAddressBook(localPath(), LOCAL_BOOK);
    writeAddressBook(sourcePath(SOURCE_A), ICLOUD_BOOK);
    writeAddressBook(sourcePath(SOURCE_B), EXCHANGE_BOOK);
  }

  describe("discovery", () => {
    it("counts EVERY address book found — and now reads every one of them", async () => {
      buildAllThree();

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.found).toBe(3);
      expect(discovery.readCount).toBe(3);
      expect(discovery.failedCount).toBe(0);
      expect(discovery.usedFallback).toBe(false);
      // Per-book PERSON counts, so "which account came back short" is answerable.
      expect(discovery.candidates.map((c) => c.recordCount)).toEqual([3, 12, 5]);
    });

    it("names every book it read", async () => {
      buildAllThree();

      await getContactNames();

      expect(lines()).toEqual(
        expect.arrayContaining([
          "[ContactsService] address books found: 3, read: 3, failed: 0",
          "[ContactsService]   read: AddressBook-v22.abcddb (3 records)",
          "[ContactsService]   read: Sources/AAAAA…/AddressBook-v22.abcddb (12 records)",
          "[ContactsService]   read: Sources/BBBBB…/AddressBook-v22.abcddb (5 records)",
        ]),
      );
    });

    it("reports the account name NOWHERE, and no absolute path", async () => {
      buildAllThree();

      await getContactNames();
      const emitted = lines().join("\n");

      expect(emitted).toContain("address books found: 3");
      expect(emitted).not.toContain(home);
      expect(emitted).not.toContain("/Users/");
      expect(emitted).not.toContain(SOURCE_A); // full UUID never printed
      expect(emitted).not.toContain(SOURCE_B);
    });

    it("emits exactly ONE discovery block, not one per book", async () => {
      buildAllThree();

      await getContactNames();

      expect(lines().filter((m) => m.includes("address books found:"))).toHaveLength(1);
    });

    it("falls back to the default path when the directory walk finds nothing", async () => {
      // The walk is blocked (permissions on the container) but the store file
      // itself is readable. That is the only remaining meaning of "fallback".
      writeAddressBook(localPath(), LOCAL_BOOK);
      const spy = jest
        .spyOn(fs.promises, "readdir")
        .mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

      try {
        const result = await getContactNames();
        const discovery = getContactIngestionFunnel().discovery!;

        expect(discovery.usedFallback).toBe(true);
        expect(discovery.readCount).toBe(1);
        expect(result.contacts!.map((c) => c.recordId).sort()).toEqual(
          LOCAL_BOOK.map((r) => r.uid!).sort(),
        );
        expect(lines()).toContain(
          "[ContactsService] address books found: 1, read: 1, failed: 0 (default path fallback)",
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("per-book error isolation (SR blocker, BACKLOG-2391)", () => {
    /**
     * Pre-2391 the load sat INSIDE the per-book try/catch, so a book that threw
     * during the full read was logged, skipped, and the loop continued. An
     * earlier draft hoisted the load OUT of the loop, so one bad book aborted
     * discovery entirely and fell through to the default path — a healthy
     * 60-contact book was never opened and the call returned failure.
     *
     * Under 2392 this matters MORE, not less: reading every book makes per-book
     * isolation a core property. If the reporter's Exchange store is corrupt she
     * must still get all of iCloud and all of "On My Mac".
     */
    it("reads the healthy books when one fails, and returns their EXACT ids", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A));
      writeAddressBook(sourcePath(SOURCE_B), EXCHANGE_BOOK);

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(result.contacts!.map((c) => c.recordId).sort()).toEqual(
        [...LOCAL_BOOK.map((r) => r.uid!), ...EXCHANGE_BOOK.map((r) => r.uid!)].sort(),
      );
    });

    it("parses the healthy books' rows, not the failed one's", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A));
      writeAddressBook(sourcePath(SOURCE_B), EXCHANGE_BOOK);

      await getContactNames();

      expect(getContactIngestionFunnel().parse).toMatchObject({
        books: 2,
        rowsRead: 8, // 3 local + 5 Exchange; the 12-person corrupt book gives nothing
        usable: 8,
        withPhone: 8,
      });
    });

    it("distinguishes a corrupt book (load-error) from an unopenable one (read-error)", async () => {
      // Different DIAGNOSES: one says the store is damaged, the other says
      // grant Full Disk Access. Conflating them sends the user to the wrong fix.
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A));

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.candidates.find((c) => c.path.includes("AAAAA"))).toMatchObject({
        read: false,
        skipReason: "load-error",
      });
      expect(lines()).toContain(
        "[ContactsService]   FAILED: Sources/AAAAA…/AddressBook-v22.abcddb" +
          " (opened, then failed mid-read — store may be corrupt)",
      );
    });

    it("makes a partial read impossible to mistake for a clean one", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A));
      writeAddressBook(sourcePath(SOURCE_B), EXCHANGE_BOOK);

      await getContactNames();

      expect(getContactIngestionFunnel().discovery).toMatchObject({
        found: 3,
        readCount: 2,
        failedCount: 1,
      });
      expect(lines()).toContain("[ContactsService] address books found: 3, read: 2, failed: 1");
    });

    it("never claims to have read a book it could not read", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A));

      await getContactNames();

      expect(
        lines().some((m) => m.startsWith("[ContactsService]   read: Sources/AAAAA…")),
      ).toBe(false);
    });

    it("returns a structured failure (not a rejection) when nothing can be read", async () => {
      const result = await getContactNames();

      expect(result.status.success).toBe(false);
      expect(result.status.userMessage).toBe("Could not load contacts from Contacts app");
      expect(result.contacts).toEqual([]);
    });

    it("emits discovery BEFORE parse, so the funnel reads top-down", async () => {
      buildAllThree();

      await getContactNames();
      const emitted = lines();
      const discoveryAt = emitted.findIndex((m) => m.includes("address books found:"));
      const parseAt = emitted.findIndex((m) => m.includes("parsed:"));

      expect(discoveryAt).toBeGreaterThanOrEqual(0);
      expect(parseAt).toBeGreaterThan(discoveryAt);
    });
  });

  describe("parse", () => {
    beforeEach(() => {
      buildAllThree();
    });

    it("reports rows in, the excluded rows, and the usable split", async () => {
      await getContactNames();

      expect(getContactIngestionFunnel().parse).toMatchObject({
        books: 3,
        rowsRead: 20,       // 3 local + 12 iCloud people + 5 Exchange
        nonPersonRows: 4,   // 2 groups + 1 info + 1 container
        missingUniqueId: 0,
        phoneRows: 17,      // 16 attached + 1 owned by a GROUP: rows READ, not attached
        emailRows: 4,       // 3 attached + 1 owned by a group
        droppedNoName: 0,   // MEASURED as rowsRead - usable, not a literal
        nameless: 1,        // A12: the record the old gate discarded
        usable: 20,
        withPhone: 16,
        emailOnly: 3,
        neither: 1,
        labelFromContact: 1,
        unlabelled: 0,
      });
    });

    it("the usable split adds up to usable, and nothing is dropped", async () => {
      await getContactNames();
      const parse = getContactIngestionFunnel().parse!;

      expect(parse.withPhone + parse.emailOnly + parse.neither).toBe(parse.usable);
      // Post-2392 every person row read becomes a person: no field is a
      // precondition for import.
      expect(parse.usable).toBe(parse.rowsRead);
      expect(parse.droppedNoName).toBe(0);
      // droppedNoName is DERIVED (rowsRead - usable), so this identity is what
      // makes it a live sentinel rather than a literal that always reads 0.
      expect(parse.droppedNoName).toBe(parse.rowsRead - parse.usable);
      // ...and the population it guards is genuinely present in the fixture.
      expect(parse.nameless).toBeGreaterThan(0);
    });

    it("the surviving people are the EXACT records the count claims", async () => {
      const result = await getContactNames();

      // Identity, not count: `usable: 20` is equally satisfied by keeping four
      // group rows and dropping four real people.
      expect(result.contacts!.map((c) => c.recordId).sort()).toEqual(ALL_PERSON_IDS);
    });

    it("keeps the previously-dropped nameless record, labelled by its email", async () => {
      const result = await getContactNames();
      const nameless = result.contacts!.find((c) => c.recordId === "A12:ABPerson");

      expect(nameless).toBeDefined();
      expect(nameless!.name).toBe("nameless12@example.com");
    });

    it("leaks no contact name, phone or email into the parse line", async () => {
      await getContactNames();
      const emitted = lines().join("\n");

      expect(emitted).toContain("parsed: 20");
      for (const secret of [
        "Cloud1", "Emailonly", "Nameonly", "Sellers 2026", "Local1", "Work1",
        "a9@example.com", "nameless12@example.com", "group@example.com",
        "+15552000000", "+15559998888",
      ]) {
        expect(emitted).not.toContain(secret);
      }
    });

    it("emits ONE parse line — counters, never one line per contact", async () => {
      await getContactNames();

      const parseLines = lines().filter((m) => m.includes("parsed:"));

      expect(parseLines).toEqual([
        "[ContactsService] parsed: 20 rows from 3 book(s) -> dropped: 0 -> usable: 20" +
          "   [nameless: 1]" +
          "   (phone: 16, email-only: 3, neither: 1)" +
          "   [labelled from contact: 1, unlabelled: 0]" +
          "   [rows: 17 phone, 4 email; excluded: 4 non-person, 0 no-uid]",
      ]);
    });
  });
});
