/**
 * @jest-environment node
 *
 * BACKLOG-2404 — a partial read is distinguishable AT THE API BOUNDARY.
 *
 * BACKLOG-2392 taught the reader to read every address book and to isolate
 * per-book failures, and it reports `read 2 of 3` faithfully — to the log. The
 * RETURN VALUE carried `success: true` plus a contact count, which is exactly
 * what a 3-of-3 read carries. So `permissionService` — the code that decides
 * what the user is told — was structurally unable to tell the two apart.
 *
 * Concrete: a user has iCloud and Exchange. Her Exchange store is locked
 * mid-write. Keepr reads iCloud, skips Exchange, reports success. She sees half
 * her contacts, no warning, and when she files a ticket the first thing she is
 * told is that her sync succeeded.
 *
 * EVERY ASSERTION HERE IS ON THE RETURNED `status`, NEVER ON THE LOG. A test
 * that inspects the funnel proves 2392 still works; it does not prove 2404,
 * because the funnel was already correct while the contract was not. The log is
 * asserted in exactly one place below, and only to show the two disagree before
 * the fix and agree after it.
 *
 * Assertion style: exact ZUNIQUEID sets, never counts (catalogue rule 1).
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
import { resetContactIngestionFunnel } from "../contactIngestionFunnel";
import {
  writeAddressBook,
  writeCorruptAddressBook,
  type FixtureRecord,
} from "./helpers/addressBookFixture";

const SOURCE_A_DIR = "0CA70C1F-1234-5678-9ABC-DEF012345678";
const SOURCE_B_DIR = "1DB81D2E-2345-6789-ABCD-EF0123456789";

const LOCAL_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "LOCAL-0001:ABPerson", first: "Homer", last: "Local", phones: ["+15555550114"] },
  { pk: 7, uid: "LOCAL-0002:ABPerson", first: "Marge", last: "Local", emails: ["marge.local@example.com"] },
];
const ICLOUD_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "ICLOUD-0001:ABPerson", first: "Ada", last: "Cloud", phones: ["+15555550124"] },
  { pk: 2, uid: "ICLOUD-0002:ABPerson", first: "Grace", last: "Cloud", emails: ["grace.cloud@example.com"] },
];
const EXCHANGE_BOOK: FixtureRecord[] = [
  { pk: 1, uid: "EXCH-0001:ABPerson", first: "Ruth", last: "Work", phones: ["+15555550123"] },
];

const LOCAL_IDS = ["LOCAL-0001:ABPerson", "LOCAL-0002:ABPerson"];
const ICLOUD_IDS = ["ICLOUD-0001:ABPerson", "ICLOUD-0002:ABPerson"];
const EXCHANGE_IDS = ["EXCH-0001:ABPerson"];

describe("BACKLOG-2404: read coverage escapes the reader", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let baseDir: string;

  const localPath = (): string => path.join(baseDir, "AddressBook-v22.abcddb");
  const sourcePath = (dir: string): string =>
    path.join(baseDir, "Sources", dir, "AddressBook-v22.abcddb");

  const idsOf = (contacts: Array<{ recordId?: string }> | undefined): string[] =>
    (contacts ?? []).map((c) => c.recordId!).sort();

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-cov-"));
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    fs.mkdirSync(baseDir, { recursive: true });
    process.env.HOME = home;
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockLogDebug.mockClear();
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("a complete read says so", () => {
    it("reports complete coverage with every book accounted for", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeAddressBook(sourcePath(SOURCE_A_DIR), ICLOUD_BOOK);
      writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);

      const { status, contacts } = await getContactNames();

      expect(status.success).toBe(true);
      expect(status.coverage).toBe("complete");
      expect(status.booksFound).toBe(3);
      expect(status.booksRead).toBe(3);
      expect(status.booksFailed).toBe(0);
      expect(status.failures).toEqual([]);
      // Exact ID set, not a count: "5 contacts" is equally satisfied by reading
      // one book twice.
      expect(idsOf(contacts)).toEqual(
        [...LOCAL_IDS, ...ICLOUD_IDS, ...EXCHANGE_IDS].sort(),
      );
    });
  });

  describe("a partial read is distinguishable from a complete one", () => {
    it("reports partial coverage when a book fails mid-read (corrupt store)", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));
      writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);

      const { status, contacts } = await getContactNames();

      // `success` stays TRUE — partial success is success, and one locked book
      // must not cost her the others. The distinction lives in `coverage`.
      expect(status.success).toBe(true);
      expect(status.coverage).toBe("partial");
      expect(status.booksFound).toBe(3);
      expect(status.booksRead).toBe(2);
      expect(status.booksFailed).toBe(1);
      // A corrupt store OPENS fine (node-sqlite3 opens lazily) and throws on
      // the first query — the corruption signature, NOT the permissions one.
      // Conflating them sends this user to grant an access she already has.
      expect(status.failures).toEqual([
        { path: "Sources/0CA70…/AddressBook-v22.abcddb", reason: "load-error" },
      ]);
      // The books that DID read are intact — exact IDs.
      expect(idsOf(contacts)).toEqual([...LOCAL_IDS, ...EXCHANGE_IDS].sort());
    });

    it("reports the read-error phase when a book cannot be opened at all", async () => {
      // A book that vanishes between discovery and read: Contacts.app and
      // iCloud rewrite these stores underneath us, so the race is real, and a
      // missing path is also what a Full Disk Access denial looks like.
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeAddressBook(sourcePath(SOURCE_A_DIR), ICLOUD_BOOK);
      const doomed = sourcePath(SOURCE_A_DIR);
      const realRealpath = fs.promises.realpath;
      const spy = jest
        .spyOn(fs.promises, "realpath")
        .mockImplementation(async (...args: Parameters<typeof realRealpath>) => {
          const resolved = await realRealpath(...args);
          if (args[0] === doomed) fs.rmSync(doomed, { force: true });
          return resolved as never;
        });

      try {
        const { status, contacts } = await getContactNames();

        expect(status.coverage).toBe("partial");
        expect(status.booksFound).toBe(2);
        expect(status.booksRead).toBe(1);
        expect(status.failures).toEqual([
          { path: "Sources/0CA70…/AddressBook-v22.abcddb", reason: "read-error" },
        ]);
        expect(idsOf(contacts)).toEqual([...LOCAL_IDS].sort());
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * THE ASSERTION THE WHOLE TICKET IS ABOUT (catalogue A5).
     *
     * Two runs that read the SAME NUMBER of books. One lost an entire account;
     * the other lost nothing. A failure count alone cannot separate them from
     * the caller's side without also knowing how many books existed, which is
     * why `booksFound` is on the contract and not merely in the log.
     */
    it("tells 'read 2 of 3' apart from 'read 2 of 2'", async () => {
      // Run A — two books, both read. Nothing is missing.
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeAddressBook(sourcePath(SOURCE_A_DIR), ICLOUD_BOOK);
      const twoOfTwo = (await getContactNames()).status;

      // Run B — three books, one corrupt. An account IS missing.
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(baseDir, { recursive: true });
      resetContactIngestionFunnel();
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeAddressBook(sourcePath(SOURCE_A_DIR), ICLOUD_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_B_DIR));
      const twoOfThree = (await getContactNames()).status;

      // Identical on every field that existed BEFORE this ticket…
      expect(twoOfThree.success).toBe(twoOfTwo.success);
      expect(twoOfThree.booksRead).toBe(twoOfTwo.booksRead);
      expect(twoOfThree.contactCount).toBe(twoOfTwo.contactCount);
      // …and different on the ones it added. This pair of expectations is the
      // regression guard: delete the coverage fields and the block above still
      // passes, which is precisely how the bug survived 2392.
      expect(twoOfTwo.coverage).toBe("complete");
      expect(twoOfThree.coverage).toBe("partial");
      expect(twoOfTwo.booksFound).toBe(2);
      expect(twoOfThree.booksFound).toBe(3);
      expect(twoOfTwo.failures).toEqual([]);
      expect(twoOfThree.failures).toEqual([
        { path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "load-error" },
      ]);
    });

    it("agrees with the funnel log rather than contradicting it", async () => {
      // The log was already right; the contract was not. This pins them
      // together so a future change cannot fix one and leave the other.
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));
      writeAddressBook(sourcePath(SOURCE_B_DIR), EXCHANGE_BOOK);

      const { status } = await getContactNames();
      const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");

      expect(emitted).toContain("address books found: 3, read: 2, failed: 1");
      expect(`address books found: ${status.booksFound}, read: ${status.booksRead}, failed: ${status.booksFailed}`)
        .toBe("address books found: 3, read: 2, failed: 1");
    });
  });

  describe("a total failure still reports what it FOUND", () => {
    it("distinguishes 'found 1, opened none' from 'no address book at all'", async () => {
      // Three stores present and none opening is a Full Disk Access diagnosis.
      // No store present at all is a different one — nothing to read. Reaching
      // the failure return with a bare `success: false` made them identical.
      writeCorruptAddressBook(localPath());

      const withBooks = (await getContactNames()).status;

      expect(withBooks.success).toBe(false);
      expect(withBooks.coverage).toBe("none");
      expect(withBooks.booksFound).toBe(1);
      expect(withBooks.booksRead).toBe(0);
      expect(withBooks.booksFailed).toBe(1);
      expect(withBooks.failures).toEqual([
        { path: "AddressBook-v22.abcddb", reason: "load-error" },
      ]);

      // Now the same machine with no address book whatsoever.
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(baseDir, { recursive: true });
      resetContactIngestionFunnel();

      const noBooks = (await getContactNames()).status;

      expect(noBooks.success).toBe(false);
      expect(noBooks.coverage).toBe("none");
      // The number that separates the two diagnoses.
      expect(noBooks.booksFound).toBe(0);
      expect(noBooks.booksFailed).toBe(0);
      expect(noBooks.failures).toEqual([]);
    });
  });

  describe("empty is not failure (catalogue A8)", () => {
    it("a book of name-only contacts reads COMPLETE, not partial and not failed", async () => {
      // `contactCount` was once derived from `contactMap`, which is keyed only
      // by phone and email, so a name-only book reported 0 and permissionService
      // told the user to grant Full Disk Access she already had. 2392 fixed the
      // count; this pins that the coverage verdict agrees with it.
      writeAddressBook(localPath(), [
        { pk: 1, uid: "NAMEONLY-1:ABPerson", first: "Nora", last: "Nophone" },
        { pk: 2, uid: "NAMEONLY-2:ABPerson", first: "Ned", last: "Nomail" },
      ]);

      const { status, contacts, contactMap } = await getContactNames();

      expect(status.success).toBe(true);
      expect(status.coverage).toBe("complete");
      expect(status.booksFound).toBe(1);
      expect(status.booksRead).toBe(1);
      expect(status.contactCount).toBe(2);
      expect(idsOf(contacts)).toEqual(["NAMEONLY-1:ABPerson", "NAMEONLY-2:ABPerson"]);
      // The lookup map is legitimately empty. That is not a failure and must
      // not read as one.
      expect(Object.keys(contactMap)).toEqual([]);
    });

    it("a genuinely EMPTY address book reads complete with zero contacts", async () => {
      writeAddressBook(localPath(), []);

      const { status } = await getContactNames();

      expect(status.success).toBe(true);
      expect(status.coverage).toBe("complete");
      expect(status.booksRead).toBe(1);
      expect(status.booksFailed).toBe(0);
      expect(status.contactCount).toBe(0);
    });
  });

  describe("the failure list carries no PII and no absolute paths", () => {
    /**
     * Asserted on the SERIALISED `failures` array, flattened — catalogue
     * cross-cutting rule 3. Recent PRs in this workstream shipped absolute
     * paths because an assertion only checked one field and the value was
     * hiding in a nested object.
     *
     * ⚠️ SCOPED TO `failures` DELIBERATELY, and the reason is a finding, not an
     * omission: `LoadStatus.source` and `LoadStatus.sources` (BACKLOG-2392,
     * pre-existing) carry ABSOLUTE `.abcddb` paths, which embed the user's
     * account name. They are not a live leak — no production caller reads
     * either field, and nothing added by BACKLOG-2404 forwards them to the
     * renderer, the funnel or the diagnostics block, all of which build from
     * `redactAddressBookPath`. Widening this assertion to the whole status
     * would therefore be fixing an unrelated latent hazard inside a ticket
     * about read coverage. Filed instead; see the PR issue log.
     */
    it("reports redacted, home-relative paths only", async () => {
      writeAddressBook(localPath(), LOCAL_BOOK);
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));

      const { status } = await getContactNames();
      const serialisedFailures = JSON.stringify(status.failures);

      expect(status.failures).toHaveLength(1);
      expect(serialisedFailures).not.toContain(home);
      expect(serialisedFailures).not.toContain(os.tmpdir());
      expect(serialisedFailures).not.toContain(SOURCE_A_DIR);
      expect(status.failures[0].path).toBe("Sources/0CA70…/AddressBook-v22.abcddb");
    });
  });
});
