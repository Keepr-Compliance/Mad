/**
 * BACKLOG-3892 S1 at the orchestrator: SyncOptions.floorPlan drives the parse loop.
 *  - with a plan: a chat older than its floor is not read and is not a conversation
 *    of the run; the others are read with their floor; counts on result.parseFloors;
 *  - without a plan: every chat read exactly as before (one argument), no parseFloors;
 *  - either way the parser's failed-read count is on result.chatReadFailures (D5).
 * Harness transcribed from deviceSyncOrchestrator.appleEncrypted-3881.test.ts.
 */
import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3892_USERDATA as string),
  },
}));

const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  debug: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * 1024 * 1024 * 1024, size: 1000 * 1024 * 1024 * 1024 }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest
    .fn()
    .mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
}));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));

const mockDecryption = {
  isBackupEncrypted: jest.fn(),
  decryptBackup: jest.fn(),
  cleanup: jest.fn(),
  sweepParseCopies: jest.fn(),
  verifyManifestRoundTrip: jest.fn(),
};
jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => mockDecryption),
  backupDecryptionService: mockDecryption,
}));

jest.mock("../deviceDetectionService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  const svc = new Emitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    // BACKLOG-3598 (B2): the second listing that confirms an unplug. Default: the phone
    // is absent on a successful listing. `null` = idevice_id could not answer.
    probeConnectedUdids: jest.fn().mockResolvedValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 11_547 * 1024 * 1024,
    }),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => svc),
    deviceDetectionService: svc,
  };
});

const mockParser = {
  open: jest.fn(),
  close: jest.fn(),
  getConversationsAsync: jest.fn(),
  getMessagesAsync: jest.fn(),
  getMessageCount: jest.fn(),
  getChatSenderHandles: jest.fn(),
  readFailures: 0,
};
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => mockParser),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

import { BackupService } from "../backupService";
import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { APPLE_EPOCH_MS } from "../db/appleSmsDbSql";
import type { ChatFloorPlan } from "../iphoneChatFloors";
import { syncTimeline } from "../syncTimeline";
import type { BackupResult } from "../../types/backup";

let userDataDir: string;
let spies: Record<string, jest.SpyInstance>;

function result(over: Partial<BackupResult> = {}): BackupResult {
  return {
    success: true,
    backupPath: path.join(userDataDir, "Backups", UDID),
    error: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 4096,
    isIncremental: false,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    ...over,
  } as BackupResult;
}

function newOrchestrator(): DeviceSyncOrchestrator {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  return o;
}

/** The ended run's outcome row plus the live context. */
function outcomeRow(): string {
  const rows = logLines.filter((l) => l.includes("sync-outcome"));
  const live = Object.entries(syncTimeline.contextSnapshot())
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `${rows[rows.length - 1] ?? ""} ${live}`;
}

function phone(status: "on" | "off" | "unknown") {
  spies.checkEncryptionStatus.mockResolvedValue({ isEncrypted: status === "on", needsPassword: status === "on", status });
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3892-"));
  process.env.KEEPR_3892_USERDATA = userDataDir;
  fsSync.mkdirSync(path.join(userDataDir, "Backups"), { recursive: true });
});
afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3892_USERDATA;
});

beforeEach(() => {
  jest.restoreAllMocks();
  logLines.length = 0;
  syncTimeline.reset();
  const P = BackupService.prototype;
  spies = {
    startBackup: jest.spyOn(P, "startBackup").mockResolvedValue(result()),
    checkEncryptionStatus: jest.spyOn(P, "checkEncryptionStatus"),
    sweep: jest.spyOn(P, "sweepLeftoverBackups").mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
    classify: jest.spyOn(P, "classifyBackupFolder").mockResolvedValue("absent"),
  };
  jest.spyOn(P, "getStatus").mockReturnValue({ isRunning: false, currentDeviceUdid: null, progress: null });
  mockDecryption.decryptBackup.mockReset();
  mockDecryption.cleanup.mockReset().mockResolvedValue(true);
  mockDecryption.sweepParseCopies.mockReset().mockResolvedValue(0);
  mockDecryption.isBackupEncrypted.mockReset().mockResolvedValue(false);
  phone("off");
});


const DAY = 86_400_000;
const F = Date.UTC(2026, 8, 1);
const ns = (ms: number): bigint => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;

function conv(chatId: number, lastMs: number) {
  return {
    chatId,
    chatIdentifier: `+1202555010${chatId}`,
    participants: [`+1202555010${chatId}`],
    messages: [],
    lastMessage: new Date(lastMs),
    isGroupChat: false,
    lastDateRaw: ns(lastMs),
  };
}
const msg = (id: number) => ({ id, guid: `G-${id}`, text: "t", handle: "", isFromMe: true, date: new Date(F + DAY), dateRead: null, dateDelivered: null, service: "iMessage", attachments: [] });

beforeEach(() => {
  mockParser.getConversationsAsync.mockReset().mockImplementation(async () => [conv(1, F + DAY), conv(2, F - 10 * DAY)]);
  mockParser.getMessagesAsync.mockReset().mockImplementation(async (chatId: number) => [msg(chatId * 10)]);
  mockParser.getMessageCount.mockReset().mockReturnValue(4);
  mockParser.getChatSenderHandles.mockReset().mockReturnValue([]);
  mockParser.readFailures = 3;
});

describe("BACKLOG-3892 S1: the sync's parse loop under SyncOptions.floorPlan", () => {
  it("with a plan: the old chat is skipped and left out, the other is read from its floor", async () => {
    const plan: ChatFloorPlan = { settingsFloorMs: F, handleFloors: new Map(), linkedChatFloors: new Map() };
    const r = await newOrchestrator().sync({ udid: UDID, floorPlan: plan });
    expect(r.success).toBe(true);
    expect(mockParser.getMessagesAsync.mock.calls).toEqual([[1, undefined, undefined, F]]);
    expect(r.conversations.map((c) => c.chatId)).toEqual([1]);
    expect(r.messages.map((m) => m.guid)).toEqual(["G-10"]);
    expect(r.parseFloors).toEqual({ floorSource: "settings", settingsFloorMs: F, chatsSkippedOld: 1, chatsWidened: 0, messagesBelowFloor: 4 + 3 });
    expect(r.chatReadFailures).toBe(3);
  });

  it("without a plan: every chat read in full, as before", async () => {
    const r = await newOrchestrator().sync({ udid: UDID });
    expect(r.success).toBe(true);
    expect(mockParser.getMessagesAsync.mock.calls).toEqual([[1], [2]]);
    expect(r.conversations.map((c) => c.chatId).sort()).toEqual([1, 2]);
    expect(r.parseFloors).toBeUndefined();
    expect(r.chatReadFailures).toBe(3);
  });
});
