/**
 * @jest-environment node
 *
 * BACKLOG-2391 — discovery and parse funnel stages.
 *
 * A reporter filed five contact tickets in one day. Her 1 MB log contained ZERO
 * lines mentioning `ContactsService`, `abcddb` or `AddressBook`, because file
 * discovery was logged at `debug` and production emits only `info` (3454 info /
 * 2606 warn / 25 error / 0 debug). Nobody could tell whether her address book
 * had been read at all.
 *
 * These tests drive the REAL `getContactNames()` over a fake filesystem and a
 * fake sqlite3 driver, so the assertions are about the numbers the shipped code
 * actually produces — not about a hand-built stats object.
 *
 * ASSERTION STYLE: exact numbers AND, for the parsed set, exact record-ID sets.
 * "usable: 11" is equally satisfied by keeping the wrong 11 people.
 */

const HOME = "/Users/margaret";
const BASE_DIR = `${HOME}/Library/Application Support/AddressBook`;
const TOP_LEVEL_DB = `${BASE_DIR}/AddressBook-v22.abcddb`;
const SOURCE_DIR = "0CA70C1F-1234-5678-9ABC-DEF012345678";
const SOURCE_DB = `${BASE_DIR}/Sources/${SOURCE_DIR}/AddressBook-v22.abcddb`;

interface FakeBook {
  records: Array<{
    person_id: number;
    first_name?: string;
    last_name?: string;
    organization?: string;
  }>;
  phones: Array<{ person_id: number; phone: string }>;
  emails: Array<{ person_id: number; email: string }>;
  /** Simulates a book that cannot be opened at all (e.g. Full Disk Access denied). */
  unreadable?: boolean;
  /**
   * Simulates a book that COUNTS fine and then throws on the full read
   * (corruption, partial permissions) — the case that must fall through to the
   * NEXT candidate rather than abort discovery.
   */
  failOnLoad?: boolean;
}

// Must be `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
const mockBooks = new Map<string, FakeBook>();
const mockLogInfo = jest.fn();

jest.mock("fs/promises", () => ({
  __esModule: true,
  default: {
    // The fixture tree IS the set of registered books, so a test that registers
    // one book cannot accidentally "find" two.
    readdir: jest.fn(async (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const children = new Map<string, boolean>(); // name -> isDirectory
      let dirExists = false;
      for (const bookPath of mockBooks.keys()) {
        if (!bookPath.startsWith(prefix)) continue;
        dirExists = true;
        const rest = bookPath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) children.set(rest, false);
        else children.set(rest.slice(0, slash), true);
      }
      if (!dirExists) throw new Error("ENOENT");
      return [...children].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    }),
    access: jest.fn(async (p: string) => {
      if (!mockBooks.has(p)) throw new Error("ENOENT");
    }),
  },
}));

jest.mock("sqlite3", () => {
  class FakeDatabase {
    private dbPath: string;
    constructor(dbPath: string) {
      this.dbPath = dbPath;
      const book = mockBooks.get(dbPath);
      if (!book) throw new Error(`no such file: ${dbPath}`);
      if (book.unreadable) throw new Error("SQLITE_CANTOPEN: unable to open database file");
    }
    all(sql: string, cb: (err: Error | null, rows?: unknown[]) => void): void {
      const book = mockBooks.get(this.dbPath)!;
      if (sql.includes("COUNT(*)")) {
        // The probe always succeeds for a failOnLoad book — that is the point.
        cb(null, [{ count: book.records.length }]);
      } else if (book.failOnLoad) {
        cb(new Error("SQLITE_CORRUPT: database disk image is malformed"));
      } else if (sql.includes("ZABCDPHONENUMBER")) {
        cb(null, book.phones);
      } else if (sql.includes("ZABCDEMAILADDRESS")) {
        cb(null, book.emails);
      } else {
        cb(null, book.records);
      }
    }
    close(cb: (err: Error | null) => void): void {
      cb(null);
    }
  }
  return { __esModule: true, default: { Database: FakeDatabase, OPEN_READONLY: 1 } };
});

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

/**
 * The real book. 12 ZABCDRECORD rows engineered so every parse counter is
 * distinct and non-zero — a counter wired to the wrong branch cannot hide:
 *   ids 1-8   : name + phone            -> withPhone
 *   ids 9-10  : name + email, no phone  -> emailOnly
 *   id  11    : name only               -> neither
 *   id  12    : NO name at all          -> droppedNoName (never becomes a person)
 *
 * Row 12 also owns a phone and an email, proving `phoneRows`/`emailRows` count
 * rows READ from the database rather than rows successfully attached.
 */
function realBook(): FakeBook {
  const records: FakeBook["records"] = [];
  for (let i = 1; i <= 8; i++) {
    records.push({ person_id: i, first_name: `Person${i}`, last_name: "Withphone" });
  }
  records.push({ person_id: 9, first_name: "Emailonly", last_name: "Nine" });
  records.push({ person_id: 10, organization: "Acme Brokerage" });
  records.push({ person_id: 11, first_name: "Nameonly", last_name: "Eleven" });
  records.push({ person_id: 12 }); // no first/last/organization -> dropped

  const phones = [
    ...Array.from({ length: 8 }, (_, i) => ({ person_id: i + 1, phone: `+1555111000${i}` })),
    { person_id: 12, phone: "+15559990000" }, // owner was dropped
  ];
  const emails = [
    { person_id: 9, email: "emailonly.nine@example.com" },
    { person_id: 10, email: "acme@example.com" },
    { person_id: 12, email: "ghost@example.com" }, // owner was dropped
  ];

  return { records, phones, emails };
}

/** A near-empty book, like the stub one macOS leaves at the top level. */
const STUB_BOOK: FakeBook = {
  records: [
    { person_id: 100, first_name: "Stub", last_name: "One" },
    { person_id: 101, first_name: "Stub", last_name: "Two" },
    { person_id: 102, first_name: "Stub", last_name: "Three" },
  ],
  phones: [],
  emails: [],
};

describe("BACKLOG-2391: discovery + parse funnel", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = HOME;
    mockBooks.clear();
    mockLogInfo.mockClear();
    resetContactIngestionFunnel();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
  });

  describe("discovery", () => {
    it("counts EVERY address book found, not just the one it stops on", async () => {
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, realBook());

      await getContactNames();

      const discovery = getContactIngestionFunnel().discovery;
      expect(discovery).toBeDefined();
      expect(discovery!.found).toBe(2);
      expect(discovery!.threshold).toBe(10);
      expect(discovery!.usedFallback).toBe(false);

      // Both books measured. The old loop returned on the first qualifying
      // file, so a second book was never opened and could never be reported.
      expect(discovery!.candidates.map((c) => c.recordCount)).toEqual([3, 12]);
    });

    it("names the selected book and why each other was passed over", async () => {
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, realBook());

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.selected).toBe(`Sources/0CA70…/AddressBook-v22.abcddb`);
      expect(discovery.candidates[0]).toEqual({
        path: "AddressBook-v22.abcddb",
        recordCount: 3,
        selected: false,
        skipReason: "below-threshold",
      });
      expect(discovery.candidates[1].selected).toBe(true);
    });

    it("reports the account name NOWHERE, and no absolute path", async () => {
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, realBook());

      await getContactNames();

      const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");
      expect(emitted).toContain("address books found: 2");
      expect(emitted).not.toContain("margaret");
      expect(emitted).not.toContain("/Users/");
      expect(emitted).not.toContain(SOURCE_DIR); // full UUID never printed
    });

    it("distinguishes an unreadable book from an under-threshold one", async () => {
      // Full Disk Access denied on the real book, stub book still readable.
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, { ...realBook(), unreadable: true });

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.candidates[0].skipReason).toBe("below-threshold");
      expect(discovery.candidates[1]).toMatchObject({
        recordCount: null,
        skipReason: "read-error",
      });
      // Nothing qualified -> the hard-coded default path was tried.
      expect(discovery.usedFallback).toBe(true);
    });

    it("records the fallback when NO discovered book clears the threshold", async () => {
      // Only the 3-record stub exists, and it is also the default path — so the
      // log has to show "skipped for being too small" and "read it anyway".
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.found).toBe(1);
      expect(discovery.usedFallback).toBe(true);
      expect(discovery.selected).toBe("AddressBook-v22.abcddb");
      expect(discovery.candidates[0].skipReason).toBe("below-threshold");

      // And it really did fall back and parse those 3 stub records.
      expect(getContactIngestionFunnel().parse!.rowsRead).toBe(3);
    });
  });

  describe("parse", () => {
    beforeEach(() => {
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, realBook());
    });

    it("reports rows in, the silent no-name drop, and the usable split", async () => {
      await getContactNames();

      expect(getContactIngestionFunnel().parse).toMatchObject({
        rowsRead: 12,
        phoneRows: 9,   // includes the dropped person's phone: rows READ, not attached
        emailRows: 3,   // ditto
        droppedNoName: 1,
        usable: 11,
        withPhone: 8,
        emailOnly: 2,
        neither: 1,
      });
    });

    it("the usable split adds up to usable", async () => {
      await getContactNames();
      const parse = getContactIngestionFunnel().parse!;

      expect(parse.withPhone + parse.emailOnly + parse.neither).toBe(parse.usable);
      expect(parse.rowsRead - parse.droppedNoName).toBe(parse.usable);
    });

    it("the surviving people are the EXACT records the count claims", async () => {
      const result = await getContactNames();

      // Identity, not count: `usable: 11` is equally satisfied by keeping the
      // no-name ghost (12) and dropping a real person.
      expect(result.contacts!.map((c) => c.recordId).sort()).toEqual(
        ["1", "10", "11", "2", "3", "4", "5", "6", "7", "8", "9"],
      );
      expect(result.contacts!.map((c) => c.recordId)).not.toContain("12");
    });

    it("leaks no contact name, phone or email into the parse line", async () => {
      await getContactNames();

      const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");
      expect(emitted).toContain("parsed: 12");
      for (const secret of [
        "Person1", "Emailonly", "Nameonly", "Acme Brokerage",
        "emailonly.nine@example.com", "acme@example.com", "ghost@example.com",
        "+15551110000", "+15559990000",
      ]) {
        expect(emitted).not.toContain(secret);
      }
    });

    it("emits ONE parse line — counters, never one line per contact", async () => {
      await getContactNames();

      const parseLines = mockLogInfo.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("parsed:"));

      expect(parseLines).toEqual([
        "[ContactsService] parsed: 12 -> no-name dropped: 1 -> usable: 11" +
          "   (phone: 8, email-only: 2, neither: 1)   [rows: 9 phone, 3 email]",
      ]);
    });
  });

  /**
   * SR review of BACKLOG-2391 — per-book error isolation.
   *
   * Pre-PR, `loadContactsFromDatabase` sat INSIDE the per-book try/catch, so a
   * book that cleared the COUNT(*) probe and then threw on the full read was
   * logged, skipped, and the loop continued to the next candidate. An earlier
   * draft of this ticket hoisted the load OUT of the loop, so one bad book
   * aborted discovery entirely and fell through to the hard-coded default path:
   *
   *   PRE-PR   loaded: .../Sources/BBBBBBBB-2222/AddressBook-v22.abcddb
   *   DRAFT    loaded: .../AddressBook/AddressBook-v22.abcddb   (source: undefined)
   *
   * A healthy 60-contact book was never opened and the call returned failure.
   * That would have changed which book multi-address-book users read — the
   * exact population BACKLOG-2392 targets — so the "baseline" this ticket
   * exists to capture would not have been a baseline at all.
   */
  describe("per-book error isolation (SR blocker)", () => {
    const BOOK_A = `${BASE_DIR}/Sources/AAAAAAAA-1111/AddressBook-v22.abcddb`;
    const BOOK_B = `${BASE_DIR}/Sources/BBBBBBBB-2222/AddressBook-v22.abcddb`;

    /** n named records, all with a phone — enough to clear the threshold. */
    function bookOf(n: number, tag: string): FakeBook {
      return {
        records: Array.from({ length: n }, (_, i) => ({
          person_id: i + 1,
          first_name: `${tag}${i + 1}`,
          last_name: "Person",
        })),
        phones: Array.from({ length: n }, (_, i) => ({
          person_id: i + 1,
          phone: `+1555${tag.charCodeAt(0)}${String(i).padStart(4, "0")}`,
        })),
        emails: [],
      };
    }

    beforeEach(() => {
      // A: 50 records, load throws. B: 60 records, healthy. Default: 5 records.
      // The default book carries phones on purpose — `contactMap` is keyed by
      // phone/email, so a name-only book yields contactCount 0 and would fail
      // for an unrelated pre-existing reason, masking what is under test.
      mockBooks.set(BOOK_A, { ...bookOf(50, "A"), failOnLoad: true });
      mockBooks.set(BOOK_B, bookOf(60, "B"));
      mockBooks.set(TOP_LEVEL_DB, bookOf(5, "D"));
    });

    it("skips a book that throws on load and reads the NEXT healthy one", async () => {
      const result = await getContactNames();

      // The regression returned success:false with source undefined.
      expect(result.status.success).toBe(true);
      expect(result.status.source).toBe(BOOK_B);
      expect(result.status.contactCount).toBeGreaterThan(0);
    });

    it("parses the healthy book's rows, not the failed one's", async () => {
      await getContactNames();

      // 60, not 50 (book A) and not 3 (the default-path stub).
      expect(getContactIngestionFunnel().parse).toMatchObject({
        rowsRead: 60,
        usable: 60,
        withPhone: 60,
      });
    });

    it("reports the failed book as a load error, distinct from unreadable", async () => {
      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.usedFallback).toBe(false);
      expect(discovery.selected).toBe("Sources/BBBBB…/AddressBook-v22.abcddb");

      const bookA = discovery.candidates.find((c) => c.path.includes("AAAAA"))!;
      // It counted fine (50) — so `recordCount` is NOT null and the reason is
      // load-error, not read-error. Conflating the two would hide the fact that
      // the book is present and sized but corrupt.
      expect(bookA).toMatchObject({
        recordCount: 50,
        selected: false,
        skipReason: "load-error",
      });

      const lines = mockLogInfo.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(
        "[ContactsService]   skipped: Sources/AAAAA…/AddressBook-v22.abcddb (load failed after counting 50 records)",
      );
    });

    it("does NOT fall back to the default path when a healthy book exists", async () => {
      const result = await getContactNames();

      expect(result.status.source).not.toBe(TOP_LEVEL_DB);
      expect(getContactIngestionFunnel().discovery!.usedFallback).toBe(false);
    });

    it("falls back only when EVERY qualifying book fails to load", async () => {
      mockBooks.set(BOOK_B, { ...bookOf(60, "B"), failOnLoad: true });

      const result = await getContactNames();

      // Both qualifying books are broken -> the default path is correct here.
      const discovery = getContactIngestionFunnel().discovery!;
      expect(discovery.usedFallback).toBe(true);
      expect(discovery.candidates.filter((c) => c.skipReason === "load-error")).toHaveLength(2);
      expect(result.status.source).toBe(TOP_LEVEL_DB);
    });

    it("emits discovery BEFORE parse, so the funnel reads top-down", async () => {
      await getContactNames();

      const lines = mockLogInfo.mock.calls.map((c) => String(c[0]));
      const discoveryAt = lines.findIndex((m) => m.includes("address books found:"));
      const parseAt = lines.findIndex((m) => m.includes("parsed:"));

      expect(discoveryAt).toBeGreaterThanOrEqual(0);
      expect(parseAt).toBeGreaterThan(discoveryAt);
    });

    it("never claims a book it could not actually read", async () => {
      await getContactNames();

      const lines = mockLogInfo.mock.calls.map((c) => String(c[0]));
      // Discovery is recorded only after a load SUCCEEDS, so the failed book is
      // never printed as `selected:`.
      expect(lines.some((m) => m.startsWith("[ContactsService]   selected: Sources/AAAAA…"))).toBe(false);
      // ...and exactly one discovery block is emitted, not one per attempt.
      expect(lines.filter((m) => m.includes("address books found:"))).toHaveLength(1);
    });
  });

  describe("selection behaviour is unchanged by the instrumentation", () => {
    it("still reads the first book over the threshold", async () => {
      mockBooks.set(TOP_LEVEL_DB, STUB_BOOK);
      mockBooks.set(SOURCE_DB, realBook());

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(result.status.source).toBe(SOURCE_DB);
      expect(result.status.contactCount).toBeGreaterThan(0);
    });

    it("still returns a structured failure (not a rejection) when nothing can be read", async () => {
      // No books at all: discovery finds nothing, fallback path does not exist.
      const result = await getContactNames();

      expect(result.status.success).toBe(false);
      expect(result.status.userMessage).toBe("Could not load contacts from Contacts app");
      expect(result.contacts).toEqual([]);
    });
  });
});
