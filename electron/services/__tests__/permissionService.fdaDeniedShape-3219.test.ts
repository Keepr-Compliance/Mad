/**
 * BACKLOG-3219 / BACKLOG-3213 — TRANSCRIPTION: what each `checkFullDiskAccess`
 * outcome actually looks like coming out of `permissionService`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * Other suites (`diagnosticHandlers.fdaIssueAction-3219`, the renderer banner,
 * and BACKLOG-3213's Messages panel suite) assert on these objects. They are
 * fed the shared constants in `tests/fixtures/fdaDeniedIssue-3219.ts`. This
 * suite is the only thing tying those constants to the REAL producer: it
 * drives the real `permissionService.checkFullDiskAccess()` against a real
 * filesystem and asserts the result IS the constant. Drift a constant and this
 * reds first; change the producer and this reds first. Neither can go quietly
 * green.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-3213 RE-POINTED WHICH LEG PROVES WHICH CONSTANT
 * ---------------------------------------------------------------------------
 * `checkFullDiskAccess` now reads `error.code`, so "an empty HOME" and "a Mac
 * that refuses us" are no longer the same object:
 *
 *   ABSENT   an empty temp HOME -> a real ENOENT -> MESSAGES_STORE_NOT_FOUND.
 *            Filesystem-real on every platform, Windows CI included.
 *   DENIED   a real `chmod 000` fixture -> a real EACCES ->
 *            FULL_DISK_ACCESS_DENIED. POSIX only; skipped on Windows, where
 *            chmod does not remove read access and the leg would be
 *            green-but-vacuous. The platform-independent denied transcription
 *            is `permissionService.messagesErrno-3213.test.ts`, which injects
 *            the errno and runs everywhere.
 *
 * THE KEY-SET ASSERTION IS KEPT ON BOTH LEGS, with different key sets — the
 * absent object omits `action` on purpose, and that omission is what takes the
 * "grant Full Disk Access" button off the health-banner row. Loosening or
 * dropping a key-set assertion to make this suite pass IS the failure mode of
 * a re-point; it is named here so review can look for it directly.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * REAL: `fs`, the temp directories, the rejections, the errnos, the catch
 * block, the returned objects.
 *
 * FAKED: exactly one thing — `os.platform()` returns "darwin", because
 * `checkFullDiskAccess` short-circuits to `hasPermission: true` off macOS and
 * this suite would otherwise be vacuous on the Windows CI leg. Everything else
 * on `os` is the real module.
 *
 * ---------------------------------------------------------------------------
 * EVERY PREMISE IS ASSERTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * Each leg first asserts that the probe really fails the way the leg claims —
 * with the errno named. Without that, a fixture that stopped producing its
 * errno would silently move the leg onto the other branch and the assertions
 * after it would be green for the wrong reason. It also means that if this
 * ever runs as root — where `fs.access(R_OK)` succeeds regardless of mode —
 * the denied leg RED S rather than going vacuous, which is the correct
 * direction to fail in.
 *
 * NOT TOUCHED, EVER: the developer's own `~/Library/Messages/chat.db`. Every
 * fixture here is a `mkdtemp` directory, and the `chmod` below operates on a
 * file this suite created inside one.
 */

import path from "path";
import { promises as fsPromises } from "fs";
import realOs from "os";
import permissionService from "../permissionService";
import {
  FDA_DENIED_PERMISSION_RESULT,
  MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

// Force the macOS branch ONLY. `fs` is untouched and real.
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const itOnPosix = process.platform === "win32" ? it.skip : it;

describe("the shape of each Full Disk Access outcome (transcribed)", () => {
  const originalHome = process.env.HOME;
  let emptyHome: string;

  beforeAll(async () => {
    emptyHome = await fsPromises.mkdtemp(
      path.join(realOs.tmpdir(), "keepr-fda-3219-")
    );
  });

  afterAll(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fsPromises.rm(emptyHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.HOME = emptyHome;
    permissionService.clearCache();
  });

  describe("ABSENT — there is no Messages database on this Mac", () => {
    it("the probe really fails with ENOENT in this fixture (the premise of every assertion below)", async () => {
      // If this ever passed, or failed with a different errno, everything
      // after it would be measuring a different branch.
      await expect(
        fsPromises.access(path.join(emptyHome, "Library/Messages/chat.db"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("returns exactly the shared absent fixture's fields (minus the machine-specific errno message)", async () => {
      const result = await permissionService.checkFullDiskAccess();

      const { error, ...withoutErrnoMessage } = result as unknown as Record<
        string,
        unknown
      >;

      expect(withoutErrnoMessage).toEqual({
        ...MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT,
      });
      // The errno message carries an absolute path, so it is asserted as
      // present rather than pinned to a value that differs per machine.
      expect(typeof error).toBe("string");
      expect((error as string).length).toBeGreaterThan(0);
    });

    it("carries NO action, actionHandler, title or severity — this is why the banner row has no button", async () => {
      const result = (await permissionService.checkFullDiskAccess()) as unknown as Record<
        string,
        unknown
      >;

      // `SystemHealthMonitor` renders its button as
      // `{issue.action && (<button …>)}`, so an absent `action` renders
      // nothing at all. That is the whole banner change for this state.
      expect(result).not.toHaveProperty("action");
      // `handleAction` switches on `actionHandler`; absent means no explainer.
      expect(result).not.toHaveProperty("actionHandler");
      // The renderer shows `title || userMessage`, so the heading is the
      // honest sentence above.
      expect(result).not.toHaveProperty("title");
      // Absent `severity` renders amber (warning), not red.
      expect(result).not.toHaveProperty("severity");

      expect(Object.keys(result).sort()).toEqual(
        ["error", "errorCode", "hasPermission", "userMessage"].sort()
      );
    });

    it("still refuses: hasPermission is false, exactly as for a denial", async () => {
      // The diagnosis moved; the verdict did not. Every consumer that branches
      // on `hasPermission` — the import preflight, onboarding, the support
      // ticket — sees no change.
      const result = await permissionService.checkFullDiskAccess();
      expect(result.hasPermission).toBe(false);
    });
  });

  describe("DENIED — macOS refuses a database that IS there", () => {
    let deniedHome: string;

    beforeEach(async () => {
      deniedHome = await fsPromises.mkdtemp(
        path.join(realOs.tmpdir(), "keepr-fda-3219-denied-")
      );
      await fsPromises.mkdir(path.join(deniedHome, "Library/Messages"), {
        recursive: true,
      });
      const dbPath = path.join(deniedHome, "Library/Messages/chat.db");
      await fsPromises.writeFile(dbPath, "");
      await fsPromises.chmod(dbPath, 0o000);
      process.env.HOME = deniedHome;
      permissionService.clearCache();
    });

    afterEach(async () => {
      if (deniedHome) {
        await fsPromises
          .chmod(path.join(deniedHome, "Library/Messages/chat.db"), 0o600)
          .catch(() => undefined);
        await fsPromises.rm(deniedHome, { recursive: true, force: true });
      }
      process.env.HOME = emptyHome;
    });

    itOnPosix(
      "the probe really fails with EACCES in this fixture (skipped on win32: chmod does not remove read access there)",
      async () => {
        // Also the guard against running as root, where fs.access(R_OK)
        // succeeds whatever the mode. This reds rather than going vacuous.
        await expect(
          fsPromises.access(
            path.join(deniedHome, "Library/Messages/chat.db"),
            fsPromises.constants.R_OK
          )
        ).rejects.toMatchObject({ code: "EACCES" });
      }
    );

    itOnPosix(
      "returns exactly the shared denied fixture's fields, unchanged by BACKLOG-3213",
      async () => {
        const result = await permissionService.checkFullDiskAccess();

        const { error, ...withoutErrnoMessage } = result as unknown as Record<
          string,
          unknown
        >;

        expect(withoutErrnoMessage).toEqual({ ...FDA_DENIED_PERMISSION_RESULT });
        expect(typeof error).toBe("string");

        // The FIVE-key set, kept from before this item. The denial still
        // carries its `action`, and that is what keeps the banner's "Show me
        // how" button alive for the state where it is the right advice.
        expect(Object.keys(result).sort()).toEqual(
          ["action", "error", "errorCode", "hasPermission", "userMessage"].sort()
        );
      }
    );
  });

  describe("GRANTED — and the empty database that is NOT an absent one", () => {
    it("returns no issue fields at all when the probe succeeds (the control for state 2)", async () => {
      const grantedHome = await fsPromises.mkdtemp(
        path.join(realOs.tmpdir(), "keepr-fda-3219-ok-")
      );
      await fsPromises.mkdir(path.join(grantedHome, "Library/Messages"), {
        recursive: true,
      });
      // BACKLOG-3213: a ZERO-BYTE chat.db. This is the state that is
      // deliberately OUT OF SCOPE — "no Messages history" is not the same
      // condition as "no Messages database". An empty file passes
      // `fs.access`, so it reports GRANTED, the import is offered, and it
      // imports nothing. Unchanged by this item, and pinned here so a future
      // change to the errno split cannot quietly reclassify it as absent.
      await fsPromises.writeFile(
        path.join(grantedHome, "Library/Messages/chat.db"),
        ""
      );
      process.env.HOME = grantedHome;
      permissionService.clearCache();

      try {
        const result = await permissionService.checkFullDiskAccess();
        expect(result).toEqual({ hasPermission: true });
      } finally {
        await fsPromises.rm(grantedHome, { recursive: true, force: true });
      }
    });
  });
});
