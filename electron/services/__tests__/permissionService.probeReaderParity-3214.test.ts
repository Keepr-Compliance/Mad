/**
 * BACKLOG-3214 — THE PROBE AND THE READER MUST ANSWER ABOUT THE SAME THING.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INVARIANT SWEEP AND NOT ANOTHER EXAMPLE
 * ---------------------------------------------------------------------------
 * The defect was a single sampled path: the probe read
 * `.../AddressBook/Sources` and the reader walks `.../AddressBook`. Fixing it
 * with one example test would leave the mirror-image wrong fix — probe
 * `AddressBook-v22.abcddb`, the default store FILE — caught by exactly one
 * sampled state. CLAUDE.md: sweep boundaries, do not sample them.
 *
 * So this asserts two INVARIANTS across every on-disk layout the reader can
 * meet, rather than asserting an outcome for one of them:
 *
 *   1. If the reader can find ANY address book (`booksFound > 0`), the probe
 *      may NEVER answer "there is no store here". That is the whole defect,
 *      stated as a property.
 *   2. `CONTACTS_STORE_NOT_FOUND` if and ONLY if the DIRECTORY is absent.
 *      Keying on any particular file inside it is the same bug mirror-imaged —
 *      it just moves which users it lies to.
 *
 * Measured: 5 passed against the fix; 2 failed against the original bug
 * (`CONTACTS_BASE_DIR + "/Sources"`); 2 failed against probing
 * `DEFAULT_CONTACTS_DB`. It catches the defect AND both path-shaped wrong
 * fixes, which one example cannot.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL
 * ---------------------------------------------------------------------------
 * Real temp HOME directories, the real `checkContactsPermission`, and the real
 * `discoverAddressBooks` that `contactsService` uses to find books. Nothing
 * about the two paths is transcribed — both sides are executed.
 *
 * `booksFound` is a real `readdir` result. This suite deliberately does NOT
 * assert `booksRead`: opening a store needs the native sqlite driver, which is
 * jest-mocked here, so a read count would be the mock's answer and not a
 * measurement. Discovery is the half that decides this invariant.
 */

import os from "os";
import fs from "fs";
import path from "path";

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import permissionService from "../permissionService";
import { discoverAddressBooks } from "../addressBookDiscovery";
import { CONTACTS_BASE_DIR, DEFAULT_CONTACTS_DB } from "../../constants";

const realHome = process.env.HOME;
let tmp: string;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kp3214-parity-")); });
afterAll(() => { process.env.HOME = realHome; });

/** One on-disk shape a real Mac can be in. */
interface Layout {
  name: string;
  /** Does `~/Library/Application Support/AddressBook` itself exist? */
  directoryExists: boolean;
  build: (home: string) => void;
}

const LAYOUTS: Layout[] = [
  {
    // A Mac with no network accounts. THE CASE THAT WAS BROKEN: the reader
    // finds this store, the old probe looked for a `Sources/` that macOS never
    // created, and the user was told a permission was missing.
    name: "top-level store only (contacts all 'On My Mac', no Sources/)",
    directoryExists: true,
    build: (home) => {
      fs.mkdirSync(path.join(home, CONTACTS_BASE_DIR), { recursive: true });
      fs.writeFileSync(path.join(home, DEFAULT_CONTACTS_DB), "x");
    },
  },
  {
    // THE MIRROR IMAGE. Probing the default FILE instead of the directory
    // would break exactly here, and nowhere the other layouts look.
    //
    // macOS names these folders with a UUID per account. The name is arbitrary
    // here on purpose: `findAbcddbFiles` recurses and matches on the `.abcddb`
    // extension, never on the folder name, so a readable name tests the same
    // path and keeps an id-shaped string out of a public repo.
    name: "Sources/<account> store only, no top-level store",
    directoryExists: true,
    build: (home) => {
      const s = path.join(home, CONTACTS_BASE_DIR, "Sources", "account-one");
      fs.mkdirSync(s, { recursive: true });
      fs.writeFileSync(path.join(s, "AddressBook-v22.abcddb"), "x");
    },
  },
  {
    name: "both a top-level store and a Sources/<account> store",
    directoryExists: true,
    build: (home) => {
      const s = path.join(home, CONTACTS_BASE_DIR, "Sources", "account-two");
      fs.mkdirSync(s, { recursive: true });
      fs.writeFileSync(path.join(s, "AddressBook-v22.abcddb"), "x");
      fs.writeFileSync(path.join(home, DEFAULT_CONTACTS_DB), "x");
    },
  },
  {
    // The directory exists and holds nothing. NOT a missing store: the probe
    // must pass, and the honest "nothing to read" answer is the loading
    // probe's to give. See BACKLOG-3243 (STATE D) — out of scope here.
    name: "AddressBook/ exists but holds no store at all",
    directoryExists: true,
    build: (home) => { fs.mkdirSync(path.join(home, CONTACTS_BASE_DIR), { recursive: true }); },
  },
  {
    name: "no AddressBook/ directory at all",
    directoryExists: false,
    build: () => {},
  },
];

describe("BACKLOG-3214: the probe and the reader answer about the same path", () => {
  for (const layout of LAYOUTS) {
    it(`${layout.name}`, async () => {
      const home = path.join(tmp, layout.name.replace(/[^a-z0-9]+/gi, "-"));
      fs.mkdirSync(home, { recursive: true });
      layout.build(home);
      process.env.HOME = home;
      permissionService.clearCache();

      // What the READER can see, from the module contactsService calls.
      const { books } = await discoverAddressBooks(
        path.join(home, CONTACTS_BASE_DIR),
        path.join(home, DEFAULT_CONTACTS_DB),
      );
      const booksFound = books.length;

      const probe = await permissionService.checkContactsPermission();

      // INVARIANT 1 — the reader can see a store, so the probe may not deny it.
      if (booksFound > 0) {
        expect({ layout: layout.name, errorCode: probe.errorCode }).toEqual({
          layout: layout.name,
          errorCode: undefined,
        });
        expect(probe.hasPermission).toBe(true);
      }

      // INVARIANT 2 — "store not found" tracks the DIRECTORY, nothing inside it.
      const saysNotFound = probe.errorCode === "CONTACTS_STORE_NOT_FOUND";
      expect({ layout: layout.name, saysNotFound }).toEqual({
        layout: layout.name,
        saysNotFound: !layout.directoryExists,
      });
    });
  }
});
