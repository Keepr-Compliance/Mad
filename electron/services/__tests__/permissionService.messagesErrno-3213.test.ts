/**
 * BACKLOG-3213 — "IT THREW" IS NOT A DIAGNOSIS, for the MESSAGES probe.
 *
 * `checkFullDiskAccess` probes `~/Library/Messages/chat.db` with `fs.access`
 * and used to collapse every rejection into one `errorCode`. Two different
 * conditions arrive at that catch block and they send a user to opposite
 * places:
 *
 *   EPERM   macOS TCC refused a protected path -> Full Disk Access is missing.
 *   ENOENT  `chat.db` is not on this Mac -> nothing to grant. Telling this
 *           user to grant Full Disk Access is worse than unhelpful: she grants
 *           it, and nothing changes.
 *
 * This is BACKLOG-3210's split applied to the second probe. The errno keying
 * is MIRRORED from `checkContactsPermission` deliberately rather than invented
 * — same codes, same default direction, same in-repo precedent.
 *
 * THE DEFAULT DIRECTION IS ASSERTED, not assumed. An unknown errno, and a
 * rejection with no `code` at all, must stay DENIED. Guessing "nothing is
 * there" for a failure we do not recognise would tell a denied Mac it has no
 * messages, which is the bug this item exists to delete, restated.
 *
 * `hasPermission` is asserted unchanged (`false`) on every path. It is the
 * only field crossing `window.api` that `checkAllPermissions`, the import
 * preflight (`macOSMessagesImportService`) and the support-ticket diagnostics
 * branch on, so this change must not move it.
 *
 * WHAT IS REAL AND WHAT IS NOT: the catch block, the errno keying and the
 * returned object are real. `fs` is mocked so the rejection's `.code` can be
 * chosen — the same technique, and the same reason, as
 * `permissionService.contactsErrno-3210.test.ts`. The REAL-filesystem legs
 * live in `permissionService.fdaDeniedShape-3219.test.ts`.
 */

import permissionService from "../permissionService";
import { promises as fs } from "fs";
import os from "os";
import {
  FDA_DENIED_PERMISSION_RESULT,
  MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

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

describe("BACKLOG-3213: checkFullDiskAccess names which failure it saw", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    permissionService.clearCache();
    mockOs.platform.mockReturnValue("darwin" as NodeJS.Platform);
  });

  /** C1 — the fix exists at producer B, and the verdict did not move. */
  it("does NOT call a missing database (ENOENT) a permission denial", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("ENOENT", "ENOENT: no such file or directory, access '/Users/x/Library/Messages/chat.db'"),
    );

    const result = await permissionService.checkFullDiskAccess();

    expect(result.errorCode).toBe("MESSAGES_STORE_NOT_FOUND");
    // Still `false` — this change moves the diagnosis, never the verdict.
    expect(result.hasPermission).toBe(false);
    // The omission IS the banner change: `SystemHealthMonitor` renders its
    // button as `{issue.action && (<button …>)}`, so an `action` here would
    // put "grant Full Disk Access" back as a live button on a row where
    // granting it changes nothing.
    expect(result).not.toHaveProperty("action");
    expect(result.userMessage).toBe(
      MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT.userMessage,
    );
    // The sentence names the missing DATABASE and no permission at all.
    expect(result.userMessage).not.toMatch(/full disk access/i);
  });

  /** C2 — the absent set is BOTH codes, not just ENOENT. */
  it("does NOT call a path-that-is-not-a-directory (ENOTDIR) a denial", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("ENOTDIR", "ENOTDIR: not a directory"),
    );

    const result = await permissionService.checkFullDiskAccess();

    expect(result.errorCode).toBe("MESSAGES_STORE_NOT_FOUND");
    expect(result.hasPermission).toBe(false);
    expect(result).not.toHaveProperty("action");
  });

  /**
   * C3 — the denial path is UNTOUCHED, field for field.
   *
   * This is the regression this item could cause, so it is asserted as an
   * equality against the shared fixture rather than as a code check. Three
   * other suites render from that fixture; if the denial's wording moved here,
   * this reds before any of them go quietly green.
   */
  it("still calls a TCC refusal (EPERM) a Full Disk Access denial, byte for byte", async () => {
    const message =
      "EPERM: operation not permitted, access '/Users/x/Library/Messages/chat.db'";
    (mockFs.access as jest.Mock).mockRejectedValue(fsError("EPERM", message));

    const result = await permissionService.checkFullDiskAccess();

    expect(result).toEqual({ ...FDA_DENIED_PERMISSION_RESULT, error: message });
    expect(Object.keys(result).sort()).toEqual(
      ["action", "error", "errorCode", "hasPermission", "userMessage"].sort(),
    );
  });

  /** C4 — EACCES is a denial, not an absence. */
  it("calls EACCES a permission denial too", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("EACCES", "EACCES: permission denied"),
    );

    const result = await permissionService.checkFullDiskAccess();

    expect(result.errorCode).toBe("FULL_DISK_ACCESS_DENIED");
    expect(result.hasPermission).toBe(false);
  });

  /**
   * C5 — the keying is on `error.code`, NOT on string-sniffing `error.message`.
   *
   * Both shapes below are ones the real producer never emits. They are
   * asserted anyway, and only to pin the MECHANISM: a fix that matched
   * `message.startsWith("ENOENT")` would pass every other test in this file
   * and fail both halves of this one.
   */
  it("keys on error.code, not on the error message", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("ENOENT", "the file is not here"),
    );
    expect((await permissionService.checkFullDiskAccess()).errorCode).toBe(
      "MESSAGES_STORE_NOT_FOUND",
    );

    permissionService.clearCache();
    (mockFs.access as jest.Mock).mockRejectedValue(
      fsError("EPERM", "ENOENT appears in this message but the code is EPERM"),
    );
    expect((await permissionService.checkFullDiskAccess()).errorCode).toBe(
      "FULL_DISK_ACCESS_DENIED",
    );
  });

  /** C6 — an unrecognised errno defaults to DENIED, never to absent. */
  it("defaults an UNRECOGNISED errno to denied, not to missing", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(fsError("EIO", "EIO: i/o error"));

    const result = await permissionService.checkFullDiskAccess();

    expect(result.errorCode).toBe("FULL_DISK_ACCESS_DENIED");
    expect(result.hasPermission).toBe(false);
  });

  /**
   * C7 — a rejection with NO `.code` defaults to denied.
   *
   * Worth naming: `permissionService.test.ts:56-67` is titled "should return
   * hasPermission: false when access denied" and rejects with
   * `new Error("EACCES: permission denied")` — which carries NO `.code`. It
   * therefore exercises THIS path, not C4's, while reading as an EACCES
   * control. C4 and C7 split the two things it conflates.
   */
  it("defaults a rejection carrying NO code to denied", async () => {
    (mockFs.access as jest.Mock).mockRejectedValue(
      new Error("EPERM: operation not permitted"),
    );

    const result = await permissionService.checkFullDiskAccess();

    expect(result.errorCode).toBe("FULL_DISK_ACCESS_DENIED");
    expect(result.hasPermission).toBe(false);
  });

  it("reports no failure at all when the database is readable", async () => {
    (mockFs.access as jest.Mock).mockResolvedValue(undefined);

    const result = await permissionService.checkFullDiskAccess();

    expect(result).toEqual({ hasPermission: true });
  });
});
