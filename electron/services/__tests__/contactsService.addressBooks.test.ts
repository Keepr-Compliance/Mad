/**
 * @jest-environment node
 *
 * BACKLOG-2392 — the macOS reader, driven over REAL `.abcddb` files.
 *
 * A reporter has iCloud (~857), Exchange (~701) and a local "On My Mac" store.
 * Keepr read ONE book: the loop returned on the first file with more than 10
 * records, in readdir order. Her count was 947 one day and 716 two days later
 * because the winner flipped. The top-level store — 3 rows on the machine
 * inspected — was discarded by the same threshold, so that account could never
 * be read at all.
 *
 * These tests build actual SQLite address books with the real Core Data table
 * shape and run the shipped `getContactNames()` over them. A fake driver cannot
 * fail to open, cannot hold a WAL, and cannot disagree with the SQL we wrote —
 * so a fake cannot prove any of the four defects are fixed.
 *
 * ASSERTION STYLE: exact ZUNIQUEID **sets**, never counts. "read 1558 contacts"
 * is equally satisfied by reading the same book twice.
 */

import path from "path";
import fs from "fs";
import os from "os";

// The real driver, resolved by absolute path so jest's `^sqlite3$`
// moduleNameMapper (which points at a hand-written stub) does not intercept it.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

// EVERY level is captured. The PR's redaction rule applies to the whole log,
// not just the funnel lines; asserting only on `info` is how an absolute path
// reaches production from a warn/error that nobody looked at.
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
const mockLogDebug = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    debug: (...args: unknown[]) => mockLogDebug(...args),
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

const SOURCE_A_DIR = "0CA70C1F-1234-5678-9ABC-DEF012345678";
const SOURCE_B_DIR = "1DB81D2E-2345-6789-ABCD-EF0123456789";

// ---------------------------------------------------------------------------
// FIXTURE CONTENT
//
// Z_PK values are deliberately arbitrary, overlapping ACROSS books, and would
// be plausible record ids if anything still used them. Book A and book B both
// contain Z_PK 1 and 2 — under the old `String(person.person_id)` identity
// those distinct humans collided on "1" and "2".
// ---------------------------------------------------------------------------

/** "On My Mac" — 3 rows, BELOW the old >10 threshold that discarded it. */
const LOCAL_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "LOCAL-0001:ABPerson", first: "Homer", last: "Local", phones: ["+15555550114"] },
  { pk: 7, uid: "LOCAL-0002:ABPerson", first: "Marge", last: "Local", emails: ["marge.local@example.com"] },
  { pk: 42, uid: "LOCAL-0003:ABPerson", first: "Bart", last: "Local", phones: ["+15555550128"] },
];

/** iCloud account. Includes the non-person rows a real store carries. */
const ICLOUD_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "ICLOUD-0001:ABPerson", first: "Ada", last: "Cloud", phones: ["+15555550124"] },
  { pk: 2, uid: "ICLOUD-0002:ABPerson", first: "Grace", last: "Cloud", emails: ["grace.cloud@example.com"] },
  { pk: 3, uid: "ICLOUD-0003:ABPerson", first: "Alan", last: "Cloud" },
  // Non-person rows: groups, an info row and a container, exactly as macOS
  // stores them in the SAME table. The old `WHERE Z_PK IS NOT NULL` was a
  // no-op and pulled every one of these through.
  { pk: 900, uid: "ICLOUD-G1:ABGroup", first: "Sellers 2026" },
  { pk: 901, uid: "ICLOUD-G2:ABGroup", first: "Buyers 2026" },
  { pk: 902, uid: "ICLOUD-I1:ABInfo" },
  { pk: 903, uid: "ICLOUD-C1:ABContainer", org: "iCloud" },
];

/** Exchange account. Carries the label edge cases. */
const EXCHANGE_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "EXCH-0001:ABPerson", first: "Ruth", last: "Work", phones: ["+15555550123"] },
  // No name at all, but a real email — 18 of 1123 people on the reporter's
  // machine looked like this and were dropped without a log line.
  { pk: 2, uid: "EXCH-0002:ABPerson", emails: ["nameless@example.com"] },
  // No name and no email — only a phone.
  { pk: 3, uid: "EXCH-0003:ABPerson", phones: ["+15553330003"] },
  // First name + organisation, NO surname — the realtor-style
  // "FirstName / Role-in-Org" card. See the precedence test (BACKLOG-2399).
  { pk: 4, uid: "EXCH-0004:ABPerson", first: "Margaret", org: "Miller - Seller", phones: ["+15555550111"] },
  // Organisation only — a genuine company record.
  { pk: 5, uid: "EXCH-0005:ABPerson", org: "Title Co", emails: ["escrow@titleco.example.com"] },
];

const LOCAL_IDS = ["LOCAL-0001:ABPerson", "LOCAL-0002:ABPerson", "LOCAL-0003:ABPerson"];
const ICLOUD_PERSON_IDS = ["ICLOUD-0001:ABPerson", "ICLOUD-0002:ABPerson", "ICLOUD-0003:ABPerson"];
const ICLOUD_NON_PERSON_IDS = ["ICLOUD-G1:ABGroup", "ICLOUD-G2:ABGroup", "ICLOUD-I1:ABInfo", "ICLOUD-C1:ABContainer"];
const EXCHANGE_IDS = [
  "EXCH-0001:ABPerson", "EXCH-0002:ABPerson", "EXCH-0003:ABPerson",
  "EXCH-0004:ABPerson", "EXCH-0005:ABPerson",
];

describe("BACKLOG-2392: every address book is read", () => {
  const originalHome = process.env.HOME;

  // -------------------------------------------------------------------------
  // FIXTURE LIFECYCLE (BACKLOG-2735)
  //
  // These books are REAL sqlite files written through the real driver — that is
  // the whole point of the suite and is not negotiable. What was negotiable is
  // how often. Building the three-account tree per test meant 64 address-book
  // databases and 27 create-and-destroy temp trees for one run of 27 tests,
  // against a global 30 s per-test timeout. On a Windows runner, where every
  // newly created file goes through Defender, that margin is thin enough that
  // one stall failed the file at 155.954 s — and `bail: 1` then discarded 601
  // suites that had not run yet.
  //
  // So the tree is built ONCE, in beforeAll, and the 17 tests that only READ it
  // share it. The 10 tests that write their own books or delete one call
  // useOwnHome() and are as isolated as they ever were. Nothing else changes:
  // the log mocks and the ingestion funnel are still reset per test, and not one
  // assertion in this file was touched.
  // -------------------------------------------------------------------------

  /** Built once in beforeAll; read by the tests that do not mutate books. */
  let sharedHome: string;
  /** Set by useOwnHome() for the current test only; removed in afterEach. */
  let ownHome: string | null = null;

  /** Whichever tree the CURRENT test is pointed at. */
  let home: string;
  let baseDir: string;

  /** Absolute path of a book inside the fixture tree. */
  const localPath = (): string => path.join(baseDir, "AddressBook-v22.abcddb");
  const sourcePath = (dir: string): string =>
    path.join(baseDir, "Sources", dir, "AddressBook-v22.abcddb");

  /**
   * Everything written to the log at ANY level, arguments included — the
   * structured metadata object is where absolute paths actually hide.
   */
  const allLogOutput = (): string =>
    [mockLogInfo, mockLogWarn, mockLogError, mockLogDebug]
      .flatMap((m) => m.mock.calls)
      .map((call: unknown[]) =>
        call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
      )
      .join("\n");

  /** recordIds of everything the reader returned, sorted for comparison. */
  const idsOf = (contacts: Array<{ recordId?: string }> | undefined): string[] =>
    (contacts ?? []).map((c) => c.recordId!).sort();

  /** An empty `$HOME/Library/Application Support/AddressBook` tree. */
  function makeHomeTree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-ab-"));
    fs.mkdirSync(path.join(dir, "Library", "Application Support", "AddressBook"), {
      recursive: true,
    });
    return dir;
  }

  /** Point HOME — and therefore localPath()/sourcePath() — at `dir`. */
  function pointAt(dir: string): void {
    home = dir;
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    process.env.HOME = home;
  }

  /**
   * Opt THIS test out of the shared tree and give it a private, empty one.
   *
   * Required by every test that writes its own books, corrupts one, or deletes
   * one mid-read. Those tests are unchanged in every other respect — they still
   * get a tree nobody else can see, created and destroyed around them.
   */
  function useOwnHome(): void {
    ownHome = makeHomeTree();
    pointAt(ownHome);
  }

  /**
   * Declares that this test reads the SHARED tree, and proves it is still whole.
   *
   * The tree now outlives the test that reads it, so a mutation escaping an
   * earlier test would surface as a baffling failure several tests later. This
   * turns that into an immediate, named error at the site that would have been
   * misled. (Content drift is caught by the exact-ZUNIQUEID-set assertions the
   * tests already make.)
   */
  function sharedThreeAccountTree(): void {
    for (const book of [localPath(), sourcePath(SOURCE_A_DIR), sourcePath(SOURCE_B_DIR)]) {
      if (!fs.existsSync(book)) {
        throw new Error(
          `shared fixture tree is missing ${path.basename(path.dirname(book))}/${path.basename(book)} — ` +
            "an earlier test mutated it and needs useOwnHome()",
        );
      }
    }
  }

  /** The three-account layout: local at the top level, two network sources. */
  function buildThreeAccountTree(): void {
    writeAddressBook(localPath(), LOCAL_BOOK);
    writeAddressBook(sourcePath(SOURCE_A_DIR), ICLOUD_BOOK);
    writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);
  }

  beforeAll(() => {
    sharedHome = makeHomeTree();
    pointAt(sharedHome);
    buildThreeAccountTree();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    pointAt(sharedHome);
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockLogDebug.mockClear();
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (ownHome) {
      fs.rmSync(ownHome, { recursive: true, force: true });
      ownHome = null;
    }
  });

  describe("multi-account discovery", () => {
    it("returns the EXACT union of all three books, not the winner of a race", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(idsOf(result.contacts)).toEqual(
        [...LOCAL_IDS, ...ICLOUD_PERSON_IDS, ...EXCHANGE_IDS].sort(),
      );
    });

    it("reads the 3-record top-level store the old >10 threshold discarded", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();

      // Defect 2 stated on its own: the "On My Mac" account is present.
      for (const id of LOCAL_IDS) {
        expect(idsOf(result.contacts)).toContain(id);
      }
    });

    it("reads a lone small book when it is the ONLY account", async () => {
      useOwnHome();
      // Nothing else exists. Under the old rule nothing cleared the threshold,
      // so this fell through to the default-path fallback by luck; a small book
      // under Sources/ was simply lost.
      writeAddressBook(sourcePath(SOURCE_A_DIR), LOCAL_BOOK);

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(idsOf(result.contacts)).toEqual([...LOCAL_IDS].sort());
    });

    it("reports found/read/failed so all three books are visibly read", async () => {
      sharedThreeAccountTree();

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.found).toBe(3);
      expect(discovery.readCount).toBe(3);
      expect(discovery.failedCount).toBe(0);
      expect(discovery.candidates.filter((c) => c.read).map((c) => c.path)).toEqual([
        "AddressBook-v22.abcddb",
        `Sources/0CA70…/AddressBook-v22.abcddb`,
        `Sources/1DB81…/AddressBook-v22.abcddb`,
      ]);
      // Per-book person counts, so "which account is short" is answerable.
      expect(discovery.candidates.map((c) => c.recordCount)).toEqual([3, 3, 5]);
    });

    it("is INDEPENDENT of readdir order — the mechanism that flipped 947 to 716", async () => {
      // The old reader took "the first book over 10 records in readdir order",
      // so a filesystem that enumerated her accounts differently between two
      // syncs changed which account she saw. Order must never again decide
      // anything. Discovery sorts; this reverses what readdir hands back, so
      // its natural order is the OPPOSITE of sorted, and pins both the reported
      // order and the resulting contact set.
      sharedThreeAccountTree();
      const realReaddir = fs.promises.readdir;
      const spy = jest
        .spyOn(fs.promises, "readdir")
        .mockImplementation(async (...args: Parameters<typeof realReaddir>) => {
          const entries = await realReaddir(...args);
          return (entries as unknown[]).slice().reverse() as never;
        });

      try {
        const result = await getContactNames();
        const discovery = getContactIngestionFunnel().discovery!;

        // Reported in sorted order regardless of how the directory enumerated.
        expect(discovery.candidates.map((c) => c.path)).toEqual([
          "AddressBook-v22.abcddb",
          `Sources/0CA70…/AddressBook-v22.abcddb`,
          `Sources/1DB81…/AddressBook-v22.abcddb`,
        ]);
        expect(discovery.candidates.map((c) => c.recordCount)).toEqual([3, 3, 5]);
        expect(idsOf(result.contacts)).toEqual(
          [...LOCAL_IDS, ...ICLOUD_PERSON_IDS, ...EXCHANGE_IDS].sort(),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("does not read the same physical file twice via the default path", async () => {
      // The default path IS the top-level book. It must be read once, or every
      // count doubles and the funnel lies.
      sharedThreeAccountTree();

      const result = await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.usedFallback).toBe(false);
      expect(discovery.readCount).toBe(3);
      expect(idsOf(result.contacts)).toHaveLength(
        LOCAL_IDS.length + ICLOUD_PERSON_IDS.length + EXCHANGE_IDS.length,
      );
    });

    it("leaks no account name and no absolute path into the log", async () => {
      sharedThreeAccountTree();

      await getContactNames();
      const emitted = allLogOutput();

      expect(emitted).toContain("address books found: 3, read: 3, failed: 0");
      expect(emitted).not.toContain(home);
      expect(emitted).not.toContain(SOURCE_A_DIR);
      expect(emitted).not.toContain("Ada");
      expect(emitted).not.toContain("grace.cloud@example.com");
      expect(emitted).not.toContain("+15555550124");
    });

    it("keeps absolute paths out of the FAILURE logs too, not just the funnel", async () => {
      // The redaction rule is about the whole log. These two sites are `warn`
      // and `error`, so a test that only inspects `info` would never see them —
      // and both used to emit an absolute path, which carries the account name.
      // No books exist at all: this drives the "no .abcddb files found" warn.
      useOwnHome();
      await getContactNames();
      const emitted = allLogOutput();

      expect(emitted).not.toContain(home);
      expect(emitted).not.toContain(os.tmpdir());
      // Home-relative form is what should appear instead.
      expect(emitted).toContain("~/Library/Application Support/AddressBook");
    });
  });

  describe("per-book failure isolation", () => {
    it("one unreadable book does not cost the user the other two", async () => {
      // The reporter's Exchange store could be locked or mid-write. If that
      // takes down the whole read she gets NOTHING, when she should get all of
      // iCloud and all of "On My Mac".
      useOwnHome();
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));
      writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(idsOf(result.contacts)).toEqual([...LOCAL_IDS, ...EXCHANGE_IDS].sort());
    });

    it("makes 'read 2 of 3' impossible to mistake for a clean run", async () => {
      useOwnHome();
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));
      writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);

      await getContactNames();
      const discovery = getContactIngestionFunnel().discovery!;

      expect(discovery.found).toBe(3);
      expect(discovery.readCount).toBe(2);
      expect(discovery.failedCount).toBe(1);
      // A corrupt store OPENS fine (node-sqlite3 opens lazily) and throws on
      // the first query — so this is `load-error`, the corruption signature,
      // NOT `read-error`, the permissions signature. Conflating them would tell
      // this user to go grant Full Disk Access she already has.
      expect(
        discovery.candidates.find((c) => c.path.includes("0CA70")),
      ).toMatchObject({ read: false, recordCount: null, skipReason: "load-error" });

      const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");
      expect(emitted).toContain("address books found: 3, read: 2, failed: 1");
      expect(emitted).toContain(
        "FAILED: Sources/0CA70…/AddressBook-v22.abcddb (opened, then failed mid-read — store may be corrupt)",
      );
    });

    it("still fails cleanly, without throwing, when NO book can be read", async () => {
      useOwnHome();
      writeCorruptAddressBook(localPath());

      const result = await getContactNames();

      expect(result.status.success).toBe(false);
      expect(result.status.userMessage).toBe("Could not load contacts from Contacts app");
      expect(result.contacts).toEqual([]);
    });

    it("survives a book that vanishes between discovery and read", async () => {
      // A missing path makes node-sqlite3 EMIT an 'error' event; unhandled,
      // that is an uncaught exception and a main-process crash. Contacts.app
      // and iCloud rewrite these stores underneath us, so this race is real.
      useOwnHome();
      buildThreeAccountTree();
      const doomed = sourcePath(SOURCE_A_DIR);
      // Delete the book at the LAST moment of discovery — after the directory
      // walk has already listed it — so it is a book we committed to reading
      // and then could not open, which is exactly the race.
      const realRealpath = fs.promises.realpath;
      const spy = jest
        .spyOn(fs.promises, "realpath")
        .mockImplementation(async (...args: Parameters<typeof realRealpath>) => {
          const resolved = await realRealpath(...args);
          if (args[0] === doomed) fs.rmSync(doomed, { force: true });
          return resolved as never;
        });

      try {
        const result = await getContactNames();

        expect(result.status.success).toBe(true);
        expect(idsOf(result.contacts)).toEqual([...LOCAL_IDS, ...EXCHANGE_IDS].sort());

        const discovery = getContactIngestionFunnel().discovery!;
        expect(discovery.failedCount).toBe(1);
        // Could not open at all -> the PERMISSIONS signature, distinct from the
        // corrupt-store `load-error` above.
        expect(
          discovery.candidates.find((c) => c.path.includes("0CA70")),
        ).toMatchObject({ read: false, skipReason: "read-error" });

        const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");
        expect(emitted).toContain("could not open — check Full Disk Access");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("identity is ZUNIQUEID, never the Core Data row number", () => {
    it("keys every contact on ZUNIQUEID", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();

      for (const contact of result.contacts!) {
        expect(contact.recordId).toMatch(/:ABPerson$/);
      }
    });

    it("emits no Z_PK value as a record id, and does not collide across books", async () => {
      // Z_PK 1 exists in all three books and Z_PK 2 in two of them. Under
      // `String(person.person_id)` those distinct humans shared a record id —
      // and `external_record_id` is the external_contacts upsert conflict key,
      // so the collision silently overwrote real people.
      sharedThreeAccountTree();

      const result = await getContactNames();
      const ids = idsOf(result.contacts);

      expect(new Set(ids).size).toBe(ids.length);
      for (const rowNumber of ["1", "2", "3", "4", "5", "7", "42"]) {
        expect(ids).not.toContain(rowNumber);
      }
      expect(ids.every((id) => !/^\d+$/.test(id))).toBe(true);
    });
  });

  describe("record type filtering", () => {
    it("excludes groups, info and container rows from the contacts", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();
      const ids = idsOf(result.contacts);

      for (const nonPerson of ICLOUD_NON_PERSON_IDS) {
        expect(ids).not.toContain(nonPerson);
      }
      // And the group NAME never surfaces as a contact either.
      expect(result.contacts!.map((c) => c.name)).not.toContain("Sellers 2026");
    });

    it("counts the excluded rows rather than dropping them silently", async () => {
      sharedThreeAccountTree();

      await getContactNames();

      expect(getContactIngestionFunnel().parse).toMatchObject({
        books: 3,
        rowsRead: 11,          // 3 local + 3 iCloud people + 5 Exchange
        nonPersonRows: 4,      // 2 groups + 1 info + 1 container
        missingUniqueId: 0,
      });
    });
  });

  describe("import everything — no field is a precondition", () => {
    it("imports a nameless contact and labels it by email", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();
      const nameless = result.contacts!.find((c) => c.recordId === "EXCH-0002:ABPerson");

      expect(nameless).toBeDefined();
      expect(nameless!.name).toBe("nameless@example.com");
    });

    it("imports a contact with only a phone and labels it by phone", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();
      const phoneOnly = result.contacts!.find((c) => c.recordId === "EXCH-0003:ABPerson");

      expect(phoneOnly).toBeDefined();
      expect(phoneOnly!.name).toBeTruthy();
      expect(phoneOnly!.name).not.toBe("");
    });

    it("a book of ONLY name-only contacts is read, not reported as a failure", async () => {
      // `contactCount` used to be derived from `contactMap`, which is keyed
      // only by phone and email. A book like this therefore reported
      // contactCount: 0 — and permissionService reads a zero count as
      // `canLoadContacts: false` and tells the user to grant Full Disk Access.
      // A perfectly readable account was indistinguishable from a permissions
      // failure, and the remedy offered was wrong.
      useOwnHome();
      writeAddressBook(localPath(), [
        { pk: 1, uid: "NAMEONLY-1:ABPerson", first: "Nora", last: "Nophone" },
        { pk: 2, uid: "NAMEONLY-2:ABPerson", first: "Ned", last: "Nomail" },
        { pk: 3, uid: "NAMEONLY-3:ABPerson", org: "Silent Escrow LLC" },
      ]);

      const result = await getContactNames();

      expect(result.status.success).toBe(true);
      expect(result.status.contactCount).toBe(3);
      expect(idsOf(result.contacts)).toEqual([
        "NAMEONLY-1:ABPerson", "NAMEONLY-2:ABPerson", "NAMEONLY-3:ABPerson",
      ]);
      // They are reachable by no phone or email, which is what `neither` is for.
      expect(getContactIngestionFunnel().parse).toMatchObject({
        usable: 3,
        neither: 3,
        withPhone: 0,
        emailOnly: 0,
      });
      // And the lookup map is legitimately empty — that is not a failure.
      expect(Object.keys(result.contactMap)).toEqual([]);
    });

    it("droppedRows is DERIVED, not a literal — a merge makes it non-zero", async () => {
      // The counter is only a real sentinel if some input makes it non-zero;
      // otherwise a hard-coded `0` passes every test, which is exactly how the
      // previous version shipped a sentinel that could never fire.
      //
      // Same ZUNIQUEID in two books: 2 rows read, 1 distinct contact out. This
      // also covers the merge path itself — the union of both books' contact
      // methods, rather than one record silently overwriting the other.
      useOwnHome();
      writeAddressBook(sourcePath(SOURCE_A_DIR), [
        { pk: 1, uid: "SHARED-0001:ABPerson", first: "Dana", last: "Twice", phones: ["+15554440001"] },
      ]);
      writeAddressBook(sourcePath(SOURCE_B_DIR), [
        { pk: 9, uid: "SHARED-0001:ABPerson", first: "Dana", last: "Twice", emails: ["dana@example.com"] },
      ]);

      const result = await getContactNames();
      const parse = getContactIngestionFunnel().parse!;

      expect(parse.rowsRead).toBe(2);
      expect(parse.usable).toBe(1);
      // NON-ZERO: a literal 0 cannot satisfy this.
      expect(parse.droppedRows).toBe(1);
      expect(parse.droppedRows).toBe(parse.rowsRead - parse.usable);

      // And the survivor carries BOTH books' contact methods.
      expect(idsOf(result.contacts)).toEqual(["SHARED-0001:ABPerson"]);
      expect(result.contacts![0].phones).toEqual(["+15554440001"]);
      expect(result.contacts![0].emails).toEqual(["dana@example.com"]);
    });

    it("counts the nameless population instead of asserting it away", async () => {
      // `droppedRows` was briefly a hard-coded literal 0 — a regression
      // sentinel that could never fire, reporting success unconditionally.
      // It is now DERIVED (rowsRead - usable), and `nameless` measures the
      // population the old gate discarded. Both have to be real numbers for
      // "import everything" to be checkable at all.
      sharedThreeAccountTree();

      await getContactNames();
      const parse = getContactIngestionFunnel().parse!;

      expect(parse.droppedRows).toBe(parse.rowsRead - parse.usable);
      // EXCH-0002 (email only) and EXCH-0003 (phone only) have no name at all.
      expect(parse.nameless).toBe(2);
      expect(parse.labelFromContact).toBe(2);
      // The nameless records were nonetheless imported — nothing was dropped.
      expect(parse.droppedRows).toBe(0);
      expect(idsOf((await getContactNames()).contacts)).toContain("EXCH-0002:ABPerson");
    });

    it("reports zero name-drops — the gate is gone, and stays gone", async () => {
      sharedThreeAccountTree();

      await getContactNames();
      const parse = getContactIngestionFunnel().parse!;

      // droppedRows is retained purely as a regression sentinel.
      expect(parse.droppedRows).toBe(0);
      expect(parse.usable).toBe(parse.rowsRead);
      expect(parse.labelFromContact).toBe(2); // the email-only and phone-only records
      expect(parse.unlabelled).toBe(0);
    });
  });

  describe("display-name precedence (BACKLOG-2399 — a name outranks an org)", () => {
    /**
     * THIS TEST WAS DELIBERATELY INVERTED BY BACKLOG-2399.
     *
     * BACKLOG-2392 pinned the KNOWN-WRONG behaviour here on purpose — "Margaret"
     * at "Miller - Seller" displayed as "Miller - Seller" — and left a note
     * saying the fix would have to change this assertion deliberately. It did.
     *
     * The reason 2392 could not simply fix it: at the time the ONLY bridge from
     * a saved contact back to its address-book row was display-name string
     * equality (`... FROM external_contacts WHERE user_id = ? AND name = ?`).
     * Relabelling orphaned every contact stored under an organisation name, all
     * on one release. BACKLOG-2401 replaced that join with the
     * `contact_source_links` crosswalk, which is keyed on the source RECORD;
     * contactsService.relabelSafety.test.ts proves the link survives this
     * relabel by exact id.
     */
    it("shows 'Margaret', not her organisation, when she has no surname", async () => {
      sharedThreeAccountTree();

      const result = await getContactNames();
      const margaret = result.contacts!.find((c) => c.recordId === "EXCH-0004:ABPerson");

      expect(margaret!.name).toBe("Margaret");
      // THE COMPANY IS NOT LOST. It has its own field and always did — which is
      // why the old fallback was discarding a real name to store a string that
      // was already stored one column over. There was never a trade-off here.
      expect(margaret!.company).toBe("Miller - Seller");
    });

    it("an organisation-only record is still labelled by its organisation", async () => {
      // The org fallback STAYS — it moves to last resort, it does not go away.
      // A vendor card like this has no person on it and the organisation is the
      // only label it has.
      sharedThreeAccountTree();

      const result = await getContactNames();
      const titleCo = result.contacts!.find((c) => c.recordId === "EXCH-0005:ABPerson");

      expect(titleCo!.name).toBe("Title Co");
      expect(titleCo!.company).toBe("Title Co");
    });

    it("prefers a surname to an organisation when there is no first name", async () => {
      // The middle of the chain, which no fixture covered before: last-only
      // must beat org for the same reason first-only does.
      useOwnHome();
      writeAddressBook(localPath(), [
        { pk: 1, uid: "LASTONLY-1:ABPerson", last: "Okonkwo", org: "Bridgeview Realty" },
      ]);

      const result = await getContactNames();

      expect(result.contacts![0].name).toBe("Okonkwo");
      expect(result.contacts![0].company).toBe("Bridgeview Realty");
    });

    it("still falls back to email, then phone, when there is no name AND no org", async () => {
      // Import-everything (catalogue A11) is unchanged by the precedence flip.
      useOwnHome();
      writeAddressBook(localPath(), [
        { pk: 1, uid: "FALLBACK-1:ABPerson", emails: ["only.email@example.com"] },
        { pk: 2, uid: "FALLBACK-2:ABPerson", phones: ["+15555550122"] },
      ]);

      const result = await getContactNames();
      const byId = Object.fromEntries(result.contacts!.map((c) => [c.recordId!, c.name]));

      expect(byId["FALLBACK-1:ABPerson"]).toBe("only.email@example.com");
      expect(byId["FALLBACK-2:ABPerson"]).toBeTruthy();
      expect(byId["FALLBACK-2:ABPerson"]).not.toBe("");
    });
  });

  describe("lookup maps span every book", () => {
    it("resolves phones and emails from all three accounts", async () => {
      sharedThreeAccountTree();

      const { contactMap } = await getContactNames();

      expect(contactMap["+15555550114"]).toBe("Homer Local");     // local
      expect(contactMap["+15555550124"]).toBe("Ada Cloud");       // iCloud
      expect(contactMap["+15555550123"]).toBe("Ruth Work");       // Exchange
      expect(contactMap["grace.cloud@example.com"]).toBe("Grace Cloud");
    });
  });
});
