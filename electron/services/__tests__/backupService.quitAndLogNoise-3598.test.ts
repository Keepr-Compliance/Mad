/**
 * BACKLOG-3598 follow-up (beta.2 Windows test 5):
 *  - a backup stopped by an app quit classifies as BACKUP_CANCELLED, not UNKNOWN_ERROR
 *  - iPhone backup copy says "this computer", never "this Mac" (shown on Windows too)
 *  - the failure stderr log drops the -d per-read trace lines and keeps the last 50 lines
 *
 * Fixture lines: `SSL_read 32768, received 32768` is the shape the founder's Windows
 * main.log carried (BACKLOG-3598 FOUNDER QA 2026-10-09).
 */
import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const mockSpawn = jest.fn();

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

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
}));

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => `/mock/${name}`),
  isMockMode: jest.fn().mockReturnValue(false),
}));

jest.mock("../backupDecryptionService", () => ({
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  },
}));

import log from "electron-log";
import {
  BACKUP_HOST_DISK_FULL_MESSAGE,
  BACKUP_CONNECTION_LOST_MESSAGE,
  BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE,
  BACKUP_FILE_MISSING_MESSAGE,
  BACKUP_STOPPED_FOR_QUIT_MESSAGE,
  FAILURE_STDERR_LOG_MAX_LINES,
  classifyBackupFailure,
  redactIdeviceOutputForLog,
  BackupService,
} from "../backupService";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
}

function startWith(
  service: BackupService,
  script: (proc: FakeProcess) => void,
): Promise<BackupResult> {
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });
  return service.startBackup({ udid: TEST_UDID });
}


describe("BACKLOG-3598: iPhone backup copy is platform-neutral", () => {
  const messages: Record<string, string> = {
    diskFull: BACKUP_HOST_DISK_FULL_MESSAGE,
    connectionLost: BACKUP_CONNECTION_LOST_MESSAGE,
    connectionLostMid: BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE,
    fileMissing: BACKUP_FILE_MISSING_MESSAGE,
    unknown: classifyBackupFailure(1, "", "", false).message,
  };
  it.each(Object.keys(messages))("%s does not say Mac", (k) => {
    expect(messages[k]).not.toMatch(/\bmacos?\b/i);
  });
});

describe("BACKLOG-3598: failure stderr log", () => {
  const noise = Array.from({ length: 500 }, () => "SSL_read 32768, received 32768").join("\n");

  it("drops SSL_read trace lines", () => {
    const out = redactIdeviceOutputForLog(noise, { dropTraceNoise: true });
    expect(out.text).toBe("");
  });

  it("keeps a real error line among the noise", () => {
    const text = `${noise}\nERROR: Could not start backup service: Device is locked\n${noise}`;
    const out = redactIdeviceOutputForLog(text, { dropTraceNoise: true });
    expect(out.text).toContain("Device is locked");
  });

  it("keeps only the last N non-noise lines", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `real line ${i}`).join("\n");
    const out = redactIdeviceOutputForLog(lines, {
      dropTraceNoise: true,
      maxLines: FAILURE_STDERR_LOG_MAX_LINES,
    });
    const kept = out.text.split("\n");
    expect(kept).toHaveLength(FAILURE_STDERR_LOG_MAX_LINES);
    expect(kept[kept.length - 1]).toBe("real line 119");
  });
});

describe("BACKLOG-3598: quit message", () => {
  it("is a stop, not a fault", () => {
    expect(BACKUP_STOPPED_FOR_QUIT_MESSAGE).toMatch(/closed/i);
    expect(BACKUP_STOPPED_FOR_QUIT_MESSAGE).not.toMatch(/reason|error|failed/i);
  });
});

describe("BACKLOG-3598: service-level", () => {
  beforeEach(() => jest.clearAllMocks());
  const noiseChunk = Array.from({ length: 300 }, () => "SSL_read 32768, received 32768").join("\n") + "\n";

  it("a backup killed by an app quit resolves BACKUP_CANCELLED and logs no failure", async () => {
    const service = new BackupService();
    const result = await startWith(service, (proc) => {
      void service.stopForQuit(50);
      proc.stderr.emit("data", Buffer.from(noiseChunk));
      proc.emit("close", null);
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("BACKUP_CANCELLED");
    expect(result.error).toBe(BACKUP_STOPPED_FOR_QUIT_MESSAGE);
    expect((log.error as jest.Mock).mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
      "Backup failed",
    );
  });

  it("a genuine failure is still UNKNOWN_ERROR and its stderr log has no SSL_read lines", async () => {
    const service = new BackupService();
    const result = await startWith(service, (proc) => {
      proc.stderr.emit("data", Buffer.from(noiseChunk + "ERROR: something odd happened\n"));
      proc.emit("close", 1);
    });
    expect(result.errorCode).toBe("UNKNOWN_ERROR");
    const stderrLog = (log.error as jest.Mock).mock.calls
      .filter((c) => c[0] === "[BackupService] stderr:")
      .map((c) => String(c[1]))
      .join("\n");
    expect(stderrLog).toContain("something odd happened");
    expect(stderrLog).not.toContain("SSL_read");
  });
});
