/**
 * BACKLOG-3927 (SR R2): the pre-sync Apple driver check in the Microsoft Store
 * build must not tell the user to "Install Sync Tools" or "repair" — the Store
 * build has neither button. The website build's texts are unchanged.
 */

import { EventEmitter } from "events";

const mockCheckDiskSpace = jest.fn();
const mockStartBackup = jest.fn();
const mockCancelBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockDeleteBackup = jest.fn();
const mockRemoveLeftoverBackup = jest.fn();
const mockDecryptionCleanup = jest.fn();
const mockGetDeviceStorageInfo = jest.fn();

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()),
  },
}));

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
const mockLogDebug = jest.fn();

jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => mockLogInfo(...a),
  error: (...a: unknown[]) => mockLogError(...a),
  warn: (...a: unknown[]) => mockLogWarn(...a),
  debug: (...a: unknown[]) => mockLogDebug(...a),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
  })),
);

jest.mock("check-disk-space", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCheckDiskSpace(...args),
}));

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
    checkBackupStatus: (...args: unknown[]) => mockCheckBackupStatus(...args),
    startBackup: (...args: unknown[]) => mockStartBackup(...args),
    cancelBackup: (...args: unknown[]) => mockCancelBackup(...args),
    // BACKLOG-3598: leftover cleanup. The removal itself is proven in
    // deviceSyncOrchestrator.failedSyncCleanup-3598.test.ts against a real folder;
    // here only whether the guard's exit asks for it.
    sweepLeftoverBackups: jest.fn().mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
    classifyBackupFolder: jest.fn().mockResolvedValue("leftover"),
    removeLeftoverBackup: (...args: unknown[]) => mockRemoveLeftoverBackup(...args),
    deleteBackup: (...args: unknown[]) => mockDeleteBackup(...args),
  })),
}));

// BACKLOG-3817: the orchestrator reads the saved backup password before the backup starts.
// The real store does file I/O, which fake timers do not drive, so the monitor's first
// reading landed outside the first 60s window on some runs.

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: (...args: unknown[]) => mockDecryptionCleanup(...args),
  })),
}));

jest.mock("../deviceDetectionService", () => {
  const mockService = new EventEmitter();
  Object.assign(mockService, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: (...args: unknown[]) => mockGetDeviceStorageInfo(...args),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => mockService),
    deviceDetectionService: mockService,
  };
});

jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getConversationsAsync: jest.fn().mockResolvedValue([]),
    getMessagesAsync: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

const mockCheckAppleDrivers = jest.fn();
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: (...a: unknown[]) => mockCheckAppleDrivers(...a),
}));

let mockStore = false;
jest.mock("../distributionChannelService", () => ({ isStoreBuild: () => mockStore }));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn().mockReturnValue(true),
  getCommand: jest.fn().mockReturnValue("/mock/idevicebackup2"),
  isMockMode: jest.fn().mockReturnValue(false),
}));

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import {
  formatMissingDriversError,
  formatDriverServiceStoppedError,
  formatStoreAppleDevicesMissingError,
  formatStoreAppleDevicesNotRunningError,
} from "../diagnostics/userFacingErrors";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const GB = 1024 * 1024 * 1024;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  mockCheckDiskSpace.mockResolvedValue({ diskPath: "C:", free: 400 * GB, size: 512 * GB });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
});

async function runPreflight(driver: { isInstalled: boolean; serviceRunning: boolean }) {
  mockCheckAppleDrivers.mockResolvedValue({ version: null, error: null, ...driver });
  const orchestrator = new DeviceSyncOrchestrator();
  const errors: Array<{ userError: { title: string; description: string; actionSuggestion: string } }> = [];
  orchestrator.on("error", (e) => errors.push(e));
  const result = await orchestrator.sync({ udid: TEST_UDID });
  expect(mockStartBackup).not.toHaveBeenCalled();
  expect(errors).toHaveLength(1);
  return { result, userError: errors[0].userError };
}

const allText = (e: { title: string; description: string; actionSuggestion: string }) =>
  `${e.title} ${e.description} ${e.actionSuggestion}`;

describe("Store build", () => {
  beforeEach(() => {
    mockStore = true;
  });

  it("Apple Devices missing: Store text, no Install Sync Tools", async () => {
    const { result, userError } = await runPreflight({ isInstalled: false, serviceRunning: false });
    expect(userError).toEqual(formatStoreAppleDevicesMissingError());
    expect(result.success).toBe(false);
    expect(allText(userError)).not.toMatch(/Install Sync Tools|repair/i);
  });

  it("Apple Devices not running: Store text, no repair", async () => {
    const { userError } = await runPreflight({ isInstalled: true, serviceRunning: false });
    expect(userError).toEqual(formatStoreAppleDevicesNotRunningError());
    expect(allText(userError)).not.toMatch(/Install Sync Tools|repair/i);
  });
});

describe("website build unchanged", () => {
  beforeEach(() => {
    mockStore = false;
  });

  it("drivers missing: Install Sync Tools text", async () => {
    const { userError } = await runPreflight({ isInstalled: false, serviceRunning: false });
    expect(userError).toEqual(formatMissingDriversError());
  });

  it("service stopped: repair text", async () => {
    const { userError } = await runPreflight({ isInstalled: true, serviceRunning: false });
    expect(userError).toEqual(formatDriverServiceStoppedError());
  });
});
