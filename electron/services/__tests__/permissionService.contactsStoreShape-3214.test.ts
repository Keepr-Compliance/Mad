/**
 * BACKLOG-3233 — THE ABSENT-CONTACTS SHAPE, TRANSCRIBED FROM THE REAL PRODUCER.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS A CONDITION OF CHANGING THE FIXTURE
 * ---------------------------------------------------------------------------
 * `CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT` was consumed by three suites and
 * tied to NOTHING. Two of them asserted
 *
 *     expect(row.action).toBe(CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT.action)
 *
 * through a MOCKED `checkAllPermissions` — both sides of the comparison came
 * from the fixture, so the real producer never ran. Measured: changing
 * `checkContactsPermission` to drop `action` left both suites GREEN. They were
 * comparing the fixture to itself.
 *
 * BACKLOG-3233 changes that fixture. Shipping a changed fixture with no tether
 * would re-create the drift one PR later, so this suite is the tether: it drives
 * the REAL `checkContactsPermission` against a REAL temp HOME with no address
 * book — producing a REAL ENOENT — and asserts the exact key set the fixture
 * declares. Drift the producer and this suite reds FIRST, then everything fed
 * from it.
 *
 * It mirrors `permissionService.fdaDeniedShape-3219.test.ts`'s ABSENT block,
 * which does the same job for the Messages probe.
 *
 * ---------------------------------------------------------------------------
 * THE ERRNO LEGS, AND THE ORIGINAL FILING'S OWN BAR
 * ---------------------------------------------------------------------------
 * BACKLOG-3214 was filed against a bar this suite closes explicitly:
 * "denied AND `Sources/` absent -> must classify as DENIED". Before the fix the
 * probe read `Sources/`, so that Mac produced ENOENT and was classified as an
 * empty address book — the exact defect. After it, the probe reads
 * `AddressBook/` itself, which EXISTS on a denied Mac and answers EPERM
 * (measured 2026-09-07, macOS 15, a process without Full Disk Access, recorded
 * in `permissionService.ts`). The denied-leg tests below are that control.
 *
 * STILL UNTRACED, and deliberately not asserted here: denied AND `AddressBook/`
 * ITSELF absent. A different intersection, never measured, not measurable on a
 * development machine. See the note in `permissionService.ts`.
 */

import os from "os";
import fs from "fs";
import path from "path";
import { promises as realFsPromises } from "fs";

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import permissionService from "../permissionService";
import {
  CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
  CONTACTS_DENIED_PERMISSION_RESULT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

const realHome = process.env.HOME;
let tmp: string;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kp3214-shape-")); });
afterAll(() => { process.env.HOME = realHome; });

beforeEach(() => { permissionService.clearCache(); });

describe("ABSENT — there is no address book on this Mac (transcribed)", () => {
  /** An empty HOME. Nothing is stubbed: the probe really fails here. */
  function emptyHome(name: string): string {
    const h = path.join(tmp, name);
    fs.mkdirSync(h, { recursive: true });
    process.env.HOME = h;
    permissionService.clearCache();
    return h;
  }

  it("the probe really fails with ENOENT in this fixture (the premise of every assertion below)", async () => {
    const h = emptyHome("premise");
    await expect(
      realFsPromises.access(path.join(h, "Library/Application Support/AddressBook")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns exactly the shared absent fixture's fields (minus the machine-specific errno message)", async () => {
    emptyHome("fields");
    const result = await permissionService.checkContactsPermission();

    // `error` carries the raw errno message including an absolute path, which
    // differs per machine; it is asserted as a non-empty string, not pinned.
    const { error, ...rest } = result;
    expect(typeof error).toBe("string");
    expect((error as string).length).toBeGreaterThan(0);
    expect(rest).toEqual({ ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT });
  });

  it("carries NO action and NO actionHandler — this is why the banner row has no button", async () => {
    emptyHome("nobutton");
    const result = await permissionService.checkContactsPermission();

    // BACKLOG-2392: the row used to carry the DENIAL's "grant Full Disk Access"
    // sentence as a button label, with no handler behind it. Omitting `action`
    // is what removes it — `SystemHealthMonitor` renders `{issue.action && …}`.
    expect(result).not.toHaveProperty("action");
    expect(result).not.toHaveProperty("actionHandler");
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("severity");
  });

  it("says nothing about any permission, in any field the banner renders", async () => {
    emptyHome("nopermission");
    const result = await permissionService.checkContactsPermission();
    const rendered = [result.userMessage, (result as { title?: string }).title, result.action]
      .filter(Boolean)
      .join(" | ");
    expect(rendered).not.toMatch(/Full Disk Access/i);
    expect(rendered).not.toMatch(/permission/i);
  });

  it("still refuses: hasPermission is false, exactly as for a denial", async () => {
    emptyHome("refuses");
    const result = await permissionService.checkContactsPermission();
    // The verdict does not move. `checkAllPermissions`, the health banner and
    // `classifyEmptyMacOSRead` all branch on this field.
    expect(result.hasPermission).toBe(false);
  });
});

describe("DENIED — macOS refuses a directory that IS there", () => {
  /**
   * Errno-injected rather than filesystem-built. A real TCC refusal cannot be
   * produced on a development machine (the process inherits Full Disk Access),
   * so the rejection's `.code` is chosen directly — the same technique, and the
   * same reason, as `permissionService.contactsErrno-3210.test.ts`.
   */
  function withErrno(code: string | undefined, message: string) {
    const err = new Error(message) as NodeJS.ErrnoException;
    if (code !== undefined) err.code = code;
    return jest
      .spyOn(realFsPromises, "access")
      .mockRejectedValue(err as unknown as never);
  }

  afterEach(() => { jest.restoreAllMocks(); });

  /**
   * THE ORIGINAL FILING'S BAR. On a denied Mac `AddressBook/` exists, so the
   * moved probe meets EPERM where the old `Sources/` probe met ENOENT and
   * wrongly reported an empty address book.
   */
  it("EPERM on the base directory is a DENIAL, not a missing store (BACKLOG-3214's filed bar)", async () => {
    const spy = withErrno("EPERM", "EPERM: operation not permitted, access '<redacted>'");
    const result = await permissionService.checkContactsPermission();
    expect(result.errorCode).toBe("CONTACTS_ACCESS_DENIED");
    expect(result.userMessage).toBe(CONTACTS_DENIED_PERMISSION_RESULT.userMessage);
    expect(result.action).toBe(CONTACTS_DENIED_PERMISSION_RESULT.action);
    spy.mockRestore();
  });

  it("EACCES is a denial too", async () => {
    const spy = withErrno("EACCES", "EACCES: permission denied");
    expect((await permissionService.checkContactsPermission()).errorCode).toBe(
      "CONTACTS_ACCESS_DENIED",
    );
    spy.mockRestore();
  });

  // THE DEFAULT DIRECTION, asserted rather than assumed. Defaulting the other
  // way would tell a denied Mac it has no address book — the bug being deleted.
  it("defaults an UNRECOGNISED errno to denied, not to missing", async () => {
    const spy = withErrno("EBUSY", "EBUSY: resource busy");
    expect((await permissionService.checkContactsPermission()).errorCode).toBe(
      "CONTACTS_ACCESS_DENIED",
    );
    spy.mockRestore();
  });

  it("defaults a rejection carrying NO code to denied", async () => {
    const spy = withErrno(undefined, "something went wrong");
    expect((await permissionService.checkContactsPermission()).errorCode).toBe(
      "CONTACTS_ACCESS_DENIED",
    );
    spy.mockRestore();
  });

  it("ENOTDIR is absent, not denied — a path that cannot be a directory holds no store", async () => {
    const spy = withErrno("ENOTDIR", "ENOTDIR: not a directory");
    expect((await permissionService.checkContactsPermission()).errorCode).toBe(
      "CONTACTS_STORE_NOT_FOUND",
    );
    spy.mockRestore();
  });
});
