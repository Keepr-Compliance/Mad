/**
 * BACKLOG-3210 — "IT THREW" IS NOT A DIAGNOSIS.
 *
 * `checkContactsPermission` probes the macOS contacts store with `fs.access`
 * and used to collapse every rejection into one `errorCode`. Two different
 * conditions arrive at that catch block and they send a user to opposite
 * places:
 *
 *   EPERM   macOS TCC refused a protected path -> Full Disk Access is missing.
 *   ENOENT  the path is not on this Mac -> nothing to grant; there is simply
 *           no address book here.
 *
 * Measured 2026-09-07 on macOS 15 from a process WITHOUT Full Disk Access:
 * `~/Library/Application Support/AddressBook` and `.../AddressBook/Sources`
 * both -> EPERM; a non-existent sibling of the same directory -> ENOENT.
 *
 * `contacts:syncExternal` branches on this code to decide whether an empty
 * contacts read gets blamed on the permission or reported as an empty address
 * book, so a wrong code here becomes a wrong sentence on the user's screen.
 *
 * THE DEFAULT DIRECTION IS ASSERTED, not assumed. An unknown errno, and a
 * rejection with no `code` at all, must stay DENIED — guessing "nothing is
 * there" for a failure we do not recognise is the very bug this item exists to
 * delete, restated in a new place.
 *
 * `hasPermission` is asserted unchanged (`false`) on every path. It is the only
 * field that crosses the `window.api` boundary and the only one
 * `checkAllPermissions` branches on, so this change must not move it.
 */

import permissionService from "../permissionService";
import { promises as fs } from "fs";
import os from "os";

jest.mock("fs", () => ({
  promises: {
    access: jest.fn(),
    constants: { R_OK: 4 },
  },
}));

jest.mock("os", () => ({ platform: jest.fn() }));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

/** An `fs` rejection shaped like the real thing: a message AND a `.code`. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("BACKLOG-3210: checkContactsPermission names which failure it saw", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    permissionService.clearCache();
    mockOs.platform.mockReturnValue("darwin" as NodeJS.Platform);
  });

  it("calls a TCC refusal (EPERM) a permission denial", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("EPERM", "EPERM: operation not permitted, access '/Users/x/Library/Application Support/AddressBook/Sources'"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.hasPermission).toBe(false);
    expect(result.errorCode).toBe("CONTACTS_ACCESS_DENIED");
  });

  it("calls EACCES a permission denial too", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("EACCES", "EACCES: permission denied"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.hasPermission).toBe(false);
    expect(result.errorCode).toBe("CONTACTS_ACCESS_DENIED");
  });

  it("does NOT call a missing store (ENOENT) a permission denial", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("ENOENT", "ENOENT: no such file or directory"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.errorCode).toBe("CONTACTS_STORE_NOT_FOUND");
    // Still `false` — this change moves the diagnosis, never the verdict.
    expect(result.hasPermission).toBe(false);
  });

  it("does NOT call a path-that-is-not-a-directory (ENOTDIR) a denial", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("ENOTDIR", "ENOTDIR: not a directory"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.errorCode).toBe("CONTACTS_STORE_NOT_FOUND");
    expect(result.hasPermission).toBe(false);
  });

  it("defaults an UNRECOGNISED errno to denied, not to missing", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("EIO", "EIO: i/o error"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.errorCode).toBe("CONTACTS_ACCESS_DENIED");
    expect(result.hasPermission).toBe(false);
  });

  it("defaults a rejection carrying NO code to denied", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      new Error("EPERM: operation not permitted"),
    );

    const result = await permissionService.checkContactsPermission();

    expect(result.errorCode).toBe("CONTACTS_ACCESS_DENIED");
    expect(result.hasPermission).toBe(false);
  });

  it("reports no failure at all when the store is readable", async () => {
    (mockFs.access as jest.Mock).mockResolvedValue(undefined);

    const result = await permissionService.checkContactsPermission();

    expect(result.hasPermission).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });
});
