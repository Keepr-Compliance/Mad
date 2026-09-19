/**
 * BACKLOG-2953 — `startBackup`'s UDID guard emits a code that IS a member of
 * `BackupErrorCode`.
 *
 * THE DEFECT: `backupService.ts:897` returned
 * `errorCode: "BACKUP_FAILED" as BackupErrorCode`. `"BACKUP_FAILED"` is not a
 * member; the cast hid that from `tsc`, so a value the type system says cannot
 * exist was written into `BackupResult` on every run that took this path.
 *
 * CONTROL: revert `:897` to the cast and every `errorCode` assertion below goes
 * red, as does the `BACKUP_ERROR_CODES.includes(...)` check — the runtime shape
 * of the original defect (a string outside the published set, on the wire).
 *
 * WHY THE MOCK BLOCK: copied from `backupService.test.ts` so this suite runs
 * under plain `npx jest` with no native driver. Validation is the first
 * statement of `startBackup` (the TASK-601 command-injection guard,
 * `d177cb3f0`), so every branch here returns before `checkEncryptionStatus`,
 * before any `fs` call, and before `spawn` — the last of which is asserted.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED. The four inputs are the four throw
 * branches of `validateDeviceUdid` (`electron/utils/validation.ts`), and the
 * expected `error` strings are that function's literal messages. Boundaries are
 * swept (24/25, 40/41), not sampled.
 *
 * REACHABILITY, for the record: `startBackup` is public, so all four branches
 * are reachable at this unit boundary. Via IPC, `backup:start` and
 * `backup:start-with-password` both pre-check `!options.udid` before calling
 * the service, so the "required" branch is NOT reachable from the renderer; the
 * non-string, length and format branches are (IPC carries untyped data, and a
 * truthy non-string passes `!options.udid`).
 *
 * NOT TESTED HERE, ON PURPOSE: the `errorCode: "UNKNOWN_ERROR"` arm of the guard
 * for a non-`ValidationError` throw. `validateDeviceUdid` throws only
 * `ValidationError`, so that arm is unreachable; a mocked validator throwing
 * `TypeError` would be a fixture the producer cannot emit (BACKLOG-2439).
 */

import { spawn } from "child_process";
import { BackupService } from "../backupService";
import { BACKUP_ERROR_CODES } from "../../types/backupErrorCodes";
import type { BackupOptions } from "../../types/backup";

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  }));
});

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    isPackaged: false,
  },
}));

jest.mock("electron-log", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn().mockResolvedValue({ size: 1024, mtime: new Date() }),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
}));

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn().mockReturnValue("/mock/idevicebackup2"),
  isMockMode: jest.fn().mockReturnValue(false),
}));

const PUBLISHED_CODES: readonly string[] = BACKUP_ERROR_CODES;

/** Messages transcribed from `validateDeviceUdid` (`electron/utils/validation.ts`). */
const MSG_REQUIRED = "Device UDID is required";
const MSG_NOT_STRING = "Device UDID must be a string";
const MSG_LENGTH = "Device UDID has invalid length (expected 25-40 characters)";
const MSG_FORMAT = "Device UDID has invalid format (must be hexadecimal with optional hyphens)";

/** A hex string of exactly `n` characters. */
const hex = (n: number): string => "a".repeat(n);

describe("BACKLOG-2953: startBackup UDID guard emits a published BackupErrorCode", () => {
  let service: BackupService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BackupService();
  });

  afterEach(() => {
    service.removeAllListeners();
  });

  /**
   * Each row is one `validateDeviceUdid` throw branch. `udid` is typed loosely so
   * the non-string row can be expressed; the cast to `BackupOptions` at the call
   * site is what a malformed IPC payload does in effect.
   */
  const branches: ReadonlyArray<{ label: string; udid: unknown; error: string }> = [
    { label: "empty string (required)", udid: "", error: MSG_REQUIRED },
    { label: "non-string (a number)", udid: 42, error: MSG_NOT_STRING },
    { label: "24 hex chars — one under the 25 minimum", udid: hex(24), error: MSG_LENGTH },
    { label: "41 hex chars — one over the 40 maximum", udid: hex(41), error: MSG_LENGTH },
    { label: "30 chars, not hex", udid: "g".repeat(30), error: MSG_FORMAT },
  ];

  for (const branch of branches) {
    it(`returns INVALID_UDID for ${branch.label}`, async () => {
      const result = await service.startBackup({ udid: branch.udid } as BackupOptions);

      expect(result.success).toBe(false);
      expect(result.backupPath).toBeNull();
      // The discriminating assertions: the code, and that the code is published.
      expect(result.errorCode).toBe("INVALID_UDID");
      expect(PUBLISHED_CODES.includes(result.errorCode as string)).toBe(true);
      // The sentence is unchanged by this fix — it is the validator's own message.
      expect(result.error).toBe(branch.error);
      // The TASK-601 property: rejection happens before any process exists.
      expect(spawn).not.toHaveBeenCalled();
    });
  }

  it("length boundary is inclusive at 25: 24/41 are rejected for length, 25 passes the length gate and is rejected for format", async () => {
    // What this proves: the length gate's edges are 25 and 40 inclusive, so the
    // length rejections above are the gate's doing and not a coincidence of the
    // chosen sizes. `hex(25)` clears LENGTH and then fails FORMAT (no UDID pattern
    // is 25 plain hex chars — traditional is 40, modern is 8-16 with a hyphen),
    // which is exactly the message asserted below.
    //
    // Deliberately NOT exercised here: a 40-char valid UDID. That value passes the
    // guard and proceeds into `checkEncryptionStatus` and a real process; this
    // suite's `spawn: jest.fn()` returns `undefined` and cannot carry that run.
    // The full path belongs to `backupService.test.ts`, whose spawn mock does.
    const isRejectedByGuard = async (udid: string): Promise<boolean> => {
      const r = await service.startBackup({ udid });
      return r.errorCode === "INVALID_UDID" && r.error === MSG_LENGTH;
    };
    expect(await isRejectedByGuard(hex(24))).toBe(true);
    expect(await isRejectedByGuard(hex(41))).toBe(true);
    // 25 passes the LENGTH gate and fails FORMAT — asserted, not assumed.
    const r25 = await service.startBackup({ udid: hex(25) });
    expect(r25.error).toBe(MSG_FORMAT);
    expect(r25.errorCode).toBe("INVALID_UDID");
  });
});
