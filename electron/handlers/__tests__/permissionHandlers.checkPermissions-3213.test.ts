/**
 * @jest-environment node
 *
 * BACKLOG-3213 — the `check-permissions` IPC, which had NO tests at all.
 *
 * Measured before a line was written:
 *   git grep -ln "check-permissions" -- electron/handlers/__tests__ electron/__tests__
 *   -> empty.
 *
 * This handler is the SECOND of two independent probes of
 * `~/Library/Messages/chat.db`. It drives the Messages settings panel (via
 * `systemService.checkMessagesPermission`); `permissionService.checkFullDiskAccess`
 * drives the System Health banner. Neither calls the other, so a fix applied
 * to one leaves the other still telling a Mac with no database to grant a
 * permission that will change nothing. That is why both are changed, and why
 * both are covered separately: a renderer suite alone cannot tell a real
 * main-process fix from a renderer sniffing the error string.
 *
 * Harness copied from `permissionHandlers.triggerFda.test.ts` — `jest.doMock`
 * on `electron` to capture `ipcMain.handle`, plus module isolation, because
 * `permissionHandlers` keeps a module-level `handlersRegistered` guard.
 */

import path from "path";

const mockAccess = jest.fn();

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const appMock = {
  // `true` keeps the double-gated KEEPR_E2E short-circuit at the top of the
  // handler out of the way; it is dead code in any packaged build.
  isPackaged: true,
  getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
  getName: jest.fn(() => "Keepr"),
};

type CheckPermissionsResult = {
  hasPermission?: boolean;
  error?: string;
  errorCode?: string;
};

function loadCheckPermissionsHandler(): () => Promise<CheckPermissionsResult> {
  const registered: Record<string, (...a: unknown[]) => unknown> = {};

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
        registered[channel] = handler;
      },
    },
    app: appMock,
    shell: { openExternal: jest.fn() },
  }));

  jest.doMock("fs", () => ({
    promises: {
      open: jest.fn(),
      access: mockAccess,
      constants: { R_OK: 4 },
    },
    constants: { R_OK: 4 },
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: mockLog,
  }));

  jest.doMock("../../services/sessionService", () => ({
    __esModule: true,
    default: {
      loadSession: jest.fn(),
      saveSession: jest.fn(),
      getSessionExpirationMs: jest.fn(() => 24 * 60 * 60 * 1000),
    },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: {
      getPreferences: jest.fn(),
      syncPreferences: jest.fn(),
      getAuthSession: jest.fn(),
    },
  }));

  jest.doMock("../../services/databaseService", () => ({
    __esModule: true,
    default: { getUserById: jest.fn(), createSession: jest.fn() },
  }));

  let handler!: () => Promise<CheckPermissionsResult>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    handler = registered["check-permissions"] as () => Promise<CheckPermissionsResult>;
  });
  return handler;
}

/** An `fs` rejection shaped like the real thing: a message AND a `.code`. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("BACKLOG-3213 — check-permissions names which failure it saw", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_E2E = process.env.KEEPR_E2E;

  beforeEach(() => {
    jest.resetModules();
    mockAccess.mockReset();
    mockLog.info.mockReset();
    mockLog.warn.mockReset();
    mockLog.error.mockReset();
    mockLog.debug.mockReset();
    process.env.HOME = "/Users/testuser";
    delete process.env.KEEPR_E2E;
  });

  afterAll(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_E2E === undefined) delete process.env.KEEPR_E2E;
    else process.env.KEEPR_E2E = ORIGINAL_E2E;
  });

  /**
   * C8 — the fix exists at PRODUCER A, across the IPC boundary.
   *
   * The likeliest wrong fix is the smallest one: sniff the reason string in
   * the renderer and change no main-process code. It passes every renderer
   * test. It fails here, because there is no `errorCode` in the payload to
   * read.
   */
  it("reports an absent database as MESSAGES_STORE_NOT_FOUND", async () => {
    mockAccess.mockRejectedValue(
      fsError("ENOENT", "ENOENT: no such file or directory, access '/Users/testuser/Library/Messages/chat.db'"),
    );

    const result = await loadCheckPermissionsHandler()();

    expect(result.errorCode).toBe("MESSAGES_STORE_NOT_FOUND");
    // The verdict does NOT move. `hasPermission` is what the onboarding flow,
    // the import preflight and the support diagnostics all branch on.
    expect(result.hasPermission).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("reports ENOTDIR as absent too", async () => {
    mockAccess.mockRejectedValue(fsError("ENOTDIR", "ENOTDIR: not a directory"));

    const result = await loadCheckPermissionsHandler()();

    expect(result.errorCode).toBe("MESSAGES_STORE_NOT_FOUND");
    expect(result.hasPermission).toBe(false);
  });

  /** C9 — the denied payload is unchanged except for the additive field. */
  it("reports a TCC refusal as FULL_DISK_ACCESS_DENIED, with hasPermission and error unchanged", async () => {
    const message =
      "EPERM: operation not permitted, access '/Users/testuser/Library/Messages/chat.db'";
    mockAccess.mockRejectedValue(fsError("EPERM", message));

    const result = await loadCheckPermissionsHandler()();

    // The whole payload, so an accidental extra or renamed field reds here.
    expect(result).toEqual({
      hasPermission: false,
      error: message,
      errorCode: "FULL_DISK_ACCESS_DENIED",
    });
  });

  /** C10 — the default direction at producer A too. */
  it("defaults an unrecognised errno and a no-code rejection to denied", async () => {
    mockAccess.mockRejectedValue(fsError("EIO", "EIO: i/o error"));
    expect((await loadCheckPermissionsHandler()()).errorCode).toBe(
      "FULL_DISK_ACCESS_DENIED",
    );

    jest.resetModules();
    mockAccess.mockReset();
    mockAccess.mockRejectedValue(new Error("EACCES: permission denied"));
    expect((await loadCheckPermissionsHandler()()).errorCode).toBe(
      "FULL_DISK_ACCESS_DENIED",
    );
  });

  /**
   * C11 — THE TRIPWIRE. The handler actually probed.
   *
   * Without this, every assertion above would pass against a handler that
   * never called `fs.access` at all and returned a canned object — a vacuous
   * green that looks exactly like a real one.
   *
   * The path is built the same way the handler builds it (`path.join` under
   * `process.env.HOME`). A hardcoded POSIX string would red on Windows CI,
   * where `path.join` uses backslashes — BACKLOG-2036, and the same reason
   * `triggerFda.test.ts:161-165` says so.
   */
  it("really probes chat.db with R_OK, and logs the errno it got", async () => {
    mockAccess.mockRejectedValue(fsError("ENOENT", "ENOENT: no such file or directory"));

    await loadCheckPermissionsHandler()();

    const expectedPath = path.join(
      "/Users/testuser",
      "Library/Messages/chat.db",
    );
    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockAccess).toHaveBeenCalledWith(expectedPath, 4);

    // The errno reaches the support log. A log line that says only "FAILED"
    // cannot distinguish a refusal from a missing file, which is the whole
    // distinction this item adds.
    expect(mockLog.warn).toHaveBeenCalledWith(
      "Permission check FAILED",
      "PermissionHandlers",
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  /** C12 — granted is not decorated. */
  it("returns a bare success when the database is readable", async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await loadCheckPermissionsHandler()();

    expect(result).toEqual({ hasPermission: true });
    expect(result).not.toHaveProperty("errorCode");
  });
});
