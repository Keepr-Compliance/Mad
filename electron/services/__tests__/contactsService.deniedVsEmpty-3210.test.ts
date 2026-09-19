/**
 * @jest-environment node
 *
 * BACKLOG-3210 — TRANSCRIPTION SUITE.
 *
 * Two jobs, and the second is the one that matters.
 *
 * 1. It runs the SHIPPED reader against real `.abcddb` stores in a temp `$HOME`
 *    and records what it actually returns for each state. Every status fixture
 *    used by `contactHandlers.syncExternalCause-3210.test.ts` is pinned here,
 *    so no handler test can assert against a state the reader cannot emit.
 *
 * 2. It proves the reader ALONE CANNOT ANSWER THE QUESTION. A Full Disk Access
 *    denial and a Mac with no address book at all produce a byte-identical
 *    status, because `addressBookDiscovery.findAbcddbFiles` catches and
 *    discards its own `readdir` rejection. That identity is the justification
 *    for probing the permission separately in the handler — without it the
 *    probe would be redundant plumbing.
 *
 * ERRNO, STATED HONESTLY: the denial here is produced with `chmod 000`, which
 * yields EACCES. Real macOS TCC yields EPERM — measured 2026-09-07 on macOS 15
 * from a process without Full Disk Access (`~/Library/Application
 * Support/AddressBook` -> EPERM; a non-existent sibling -> ENOENT). This suite
 * does NOT claim to reproduce TCC's errno; it reproduces the SHAPE the reader
 * emits when the directory will not list. `permissionService.contactsErrno-3210`
 * covers the errno mapping itself, EPERM included.
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

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getContactNames } from "../contactsService";
import { resetContactIngestionFunnel } from "../contactIngestionFunnel";
import {
  writeAddressBook,
  writeCorruptAddressBook,
  type FixtureRecord,
} from "./helpers/addressBookFixture";
import {
  shapeOf,
  NOTHING_DISCOVERED,
  READ_AND_EMPTY,
  FOUND_BUT_UNREADABLE,
  READ_WITH_CONTACTS,
} from "./helpers/macOSReadStates-3210";

// Per-account address-book directory names. Both are typed by hand for this
// suite and match the shape macOS uses; neither came from a real machine.
const SOURCE_A_DIR = "0CA70C1F-1234-5678-9ABC-DEF012345678"; // pii-allow-uuid: invented, not from any live row
const SOURCE_B_DIR = "1DB81D2E-2345-6789-ABCD-EF0123456789"; // pii-allow-uuid: invented, not from any live row

const TWO_PEOPLE: FixtureRecord[] = [
  { pk: 1, uid: "P-0001:ABPerson", first: "Ada", last: "Reader", phones: ["+15555550124"] },
  { pk: 2, uid: "P-0002:ABPerson", first: "Grace", last: "Reader", emails: ["grace.reader@example.com"] },
];

/**
 * Can this platform actually deny a directory with mode bits? Windows cannot,
 * and neither can a process running as root. Computed once, against a throwaway
 * directory, so a platform that cannot produce the state SKIPS the test loudly
 * instead of passing it vacuously.
 */
const CAN_DENY_BY_CHMOD = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-chmod-probe-"));
  try {
    fs.mkdirSync(path.join(probe, "inner"));
    fs.chmodSync(probe, 0o000);
    try {
      fs.readdirSync(probe);
      return false; // listing still worked — root, or a filesystem that ignores mode bits
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      fs.chmodSync(probe, 0o755);
    } catch {
      /* best effort */
    }
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

const itIfCanDeny = CAN_DENY_BY_CHMOD ? it : it.skip;

describe("BACKLOG-3210: what the real reader returns for each empty-read cause", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let baseDir: string;

  const localPath = (): string => path.join(baseDir, "AddressBook-v22.abcddb");
  const sourcePath = (dir: string): string =>
    path.join(baseDir, "Sources", dir, "AddressBook-v22.abcddb");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3210-"));
    baseDir = path.join(home, "Library", "Application Support", "AddressBook");
    fs.mkdirSync(baseDir, { recursive: true });
    process.env.HOME = home;
    resetContactIngestionFunnel();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    // Restore the mode bits BEFORE removing the tree: a 000 directory cannot be
    // recursed into, so cleanup would fail and leak into the next test.
    try {
      fs.chmodSync(baseDir, 0o755);
    } catch {
      /* directory may already be gone */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("the reader cannot tell a denial from an absent address book", () => {
    it("reports NOTHING_DISCOVERED when there is no address book at all", async () => {
      // baseDir exists and is readable; it just holds no .abcddb.
      const { status, contacts, phoneToContactInfo } = await getContactNames();

      expect(shapeOf(status)).toEqual(NOTHING_DISCOVERED);
      expect(contacts).toEqual([]);
      expect(Object.keys(phoneToContactInfo)).toEqual([]);
    });

    itIfCanDeny(
      "reports THE SAME shape when a populated address book cannot be listed",
      async () => {
        // A real store WITH people in it — the founder's case. The only thing
        // wrong is that we are not allowed to look.
        writeAddressBook(localPath(), TWO_PEOPLE);
        writeAddressBook(sourcePath(SOURCE_A_DIR), TWO_PEOPLE);
        fs.chmodSync(baseDir, 0o000);

        // The denial must be real, or this test proves nothing.
        expect(() => fs.readdirSync(baseDir)).toThrow();

        const { status, contacts } = await getContactNames();

        // IDENTICAL to the "no address book at all" case above. Two causes,
        // one shape — which is exactly why the handler has to probe.
        expect(shapeOf(status)).toEqual(NOTHING_DISCOVERED);
        expect(contacts).toEqual([]);
      },
    );
  });

  describe("a read that succeeded is distinguishable from one that never happened", () => {
    it("reports READ_AND_EMPTY for a readable address book holding nobody", async () => {
      writeAddressBook(localPath(), []);

      const { status, contacts, phoneToContactInfo } = await getContactNames();

      expect(shapeOf(status)).toEqual(READ_AND_EMPTY);
      // `booksRead: 1` is the direct evidence the classifier leans on.
      expect(status.booksRead).toBeGreaterThan(0);
      expect(contacts).toEqual([]);
      expect(Object.keys(phoneToContactInfo)).toEqual([]);
    });

    it("reports READ_WITH_CONTACTS for a readable address book holding people", async () => {
      writeAddressBook(localPath(), TWO_PEOPLE);

      const { status, contacts } = await getContactNames();

      expect(shapeOf(status)).toEqual(READ_WITH_CONTACTS);
      // Exact ID set, not a count: "2 contacts" is equally satisfied by
      // reading one person twice.
      expect((contacts ?? []).map((c) => c.recordId).sort()).toEqual([
        "P-0001:ABPerson",
        "P-0002:ABPerson",
      ]);
    });

    it("reports FOUND_BUT_UNREADABLE when stores exist and none will open", async () => {
      writeCorruptAddressBook(sourcePath(SOURCE_A_DIR));
      writeCorruptAddressBook(sourcePath(SOURCE_B_DIR));

      const { status, contacts } = await getContactNames();

      expect(shapeOf(status)).toEqual(FOUND_BUT_UNREADABLE);
      // Distinct from NOTHING_DISCOVERED by `booksFound`, which is what lets
      // the handler avoid blaming a permission the user already holds.
      expect(status.booksFound).toBeGreaterThan(0);
      expect(contacts).toEqual([]);
    });
  });
});
