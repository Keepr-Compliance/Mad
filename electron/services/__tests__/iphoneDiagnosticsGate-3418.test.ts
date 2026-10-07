/**
 * BACKLOG-3418 Q2 (founder 2026-10-07, pm_comments 1b736c4f): support-ticket
 * diagnostics run the iPhone helper (`idevice_id --version`, `idevice_id -l`)
 * only when iPhone checking is on for the account.
 *
 * The gate lives in MAIN, in `DeviceDetectionService.collectIphoneSyncDiagnostics`
 * (SR ruling 3433cf56, condition C-2):
 *   - SupportWidget is mounted OUTSIDE IPhoneSyncProvider (App.tsx), so a
 *     renderer-side gate would read the provider default (off) and drop iPhone
 *     diagnostics for every iPhone user.
 *   - There are two callers of `collectDiagnostics()`: the IPC handler
 *     `support:collect-diagnostics` (supportTicketHandlers.ts) and the
 *     support-access report queue (supportAccess/index.ts wires
 *     `collectDiagnostics: () => collectDiagnostics()` into SupportReportQueue).
 *     A gate in the IPC handler would miss the queue.
 *
 * "Checking on" = the renderer asked main to detect (`start()`), and has not
 * stopped it. The renderer provider starts detection only for an account with
 * iPhone checking on, so main needs no copy of the renderer's rule.
 *
 * The real DeviceDetectionService singleton and the real supportTicketService
 * run here; child_process is the seam (as in iphoneSyncDiagnostics.test.ts).
 */

import { EventEmitter } from "events";

const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// libimobiledevice usable, so "nothing spawned" can only come from the gate.
jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn().mockReturnValue(true),
  getCommand: jest.fn((name: string) => `/usr/bin/${name}`),
}));

// Captured IPC handlers, so the real `support:collect-diagnostics` handler runs.
const mockIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn().mockReturnValue("2.40.0"),
    runningUnderARM64Translation: false,
  },
  BrowserWindow: { getFocusedWindow: jest.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mockIpcHandlers.set(channel, fn);
    },
  },
}));

// supportTicketService's other diagnostics sources — as in supportTicketService.test.ts.
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { isInitialized: jest.fn().mockReturnValue(false) },
}));
jest.mock("../databaseEncryptionService", () => ({
  __esModule: true,
  default: { isEncryptionAvailable: jest.fn().mockReturnValue(true) },
}));
jest.mock("../syncStatusService", () => ({
  syncStatusService: {
    getStatus: jest.fn().mockReturnValue({ isAnyOperationRunning: false, currentOperation: null }),
  },
}));
jest.mock("../deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("device-abc-123"),
}));
jest.mock("../failureLogService", () => ({
  __esModule: true,
  default: { getRecentFailures: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn().mockResolvedValue({ user: { id: "user-3418" } }) },
}));
jest.mock("../connectionStatusService", () => ({
  __esModule: true,
  default: {
    checkAllConnections: jest.fn().mockResolvedValue({
      google: { connected: false, lastCheck: 0, error: null },
      microsoft: { connected: false, lastCheck: 0, error: null },
      allConnected: false,
      anyConnected: false,
    }),
  },
}));
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({
    isInstalled: false,
    version: null,
    serviceRunning: false,
    error: null,
  }),
}));
jest.mock("../pairingService", () => ({
  pairingService: { getStatus: jest.fn().mockReturnValue({ isPaired: false, devices: [] }) },
}));
jest.mock("../localSyncService", () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn().mockReturnValue({
      running: false,
      port: null,
      address: null,
      totalMessagesReceived: 0,
      lastSyncTimestamp: null,
    }),
  },
}));
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn().mockResolvedValue({}) },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { deviceDetectionService } from "../deviceDetectionService";
import { collectDiagnostics } from "../supportTicketService";
import { registerSupportTicketHandlers } from "../../handlers/supportTicketHandlers";

/** Every child-process command line that ran the iPhone helper. */
function ideviceCalls(): string[] {
  const execCmds = mockExec.mock.calls.map((c) => String(c[0]));
  const spawnCmds = mockSpawn.mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1] ?? [])}`);
  return [...execCmds, ...spawnCmds].filter((cmd) => cmd.includes("idevice"));
}

/** exec(): `--version` succeeds; everything else succeeds empty. spawn(): `-l` lists nothing. */
function serveHelper() {
  mockExec.mockImplementation((cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
      e: Error | null,
      r?: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout: cmd.includes("--version") ? "1.3.0" : "", stderr: "" });
  });
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      proc.stdout.emit("data", "");
      proc.emit("close", 0);
    }, 0);
    return proc;
  });
}

const svc = deviceDetectionService as unknown as { pollDevices: () => Promise<void> };
let originalPlatform: PropertyDescriptor | undefined;
let originalArch: PropertyDescriptor | undefined;

beforeAll(() => {
  // The poll itself is not under test: stub it so start() spawns nothing on
  // its own and the only idevice calls left are the diagnostics'.
  jest.spyOn(svc, "pollDevices").mockResolvedValue(undefined);
  registerSupportTicketHandlers();
});

beforeEach(() => {
  mockExec.mockReset();
  mockSpawn.mockReset();
  serveHelper();
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "x64" });
});

afterEach(() => {
  deviceDetectionService.stop();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalArch) Object.defineProperty(process, "arch", originalArch);
});

describe("BACKLOG-3418 Q2: the iPhone helper runs in diagnostics only while iPhone checking is on", () => {
  describe("DeviceDetectionService.collectIphoneSyncDiagnostics", () => {
    it("macOS, checking off (never started): spawns nothing and says it did not check", async () => {
      const result = await deviceDetectionService.collectIphoneSyncDiagnostics();

      expect(ideviceCalls()).toEqual([]);
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(result.iphoneCheckingOn).toBe(false);
      expect(result.libimobiledeviceAvailable).toBe(false);
    });

    it("Windows, checking off: no iPhone helper; the USB/PnP probe (not the helper) still runs", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const result = await deviceDetectionService.collectIphoneSyncDiagnostics();

      expect(ideviceCalls()).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
      // Anti-vacuity: the probe ran, so "no idevice call" is not "nothing ran".
      expect(mockExec).toHaveBeenCalled();
      expect(result.windows).not.toBeNull();
      expect(result.iphoneCheckingOn).toBe(false);
      expect(result.libimobiledeviceAvailable).toBe(false);
      // No helper asked → never a "driver missing" verdict.
      expect(result.driverMissingSuspected).toBe(false);
    });

    it("checking on (started): runs `idevice_id --version` and `idevice_id -l`", async () => {
      deviceDetectionService.start();

      const result = await deviceDetectionService.collectIphoneSyncDiagnostics();

      expect(result.iphoneCheckingOn).toBe(true);
      expect(result.libimobiledeviceAvailable).toBe(true);
      const calls = ideviceCalls();
      expect(calls.some((c) => c.includes("idevice_id") && c.includes("--version"))).toBe(true);
      expect(calls.some((c) => c.includes("idevice_id") && c.includes("-l"))).toBe(true);
    });

    it("checking turned off again (stopped): spawns nothing", async () => {
      deviceDetectionService.start();
      deviceDetectionService.stop();

      const result = await deviceDetectionService.collectIphoneSyncDiagnostics();

      expect(result.iphoneCheckingOn).toBe(false);
      expect(ideviceCalls()).toEqual([]);
    });

    it("Windows on ARM: start() refuses (BACKLOG-3363), so diagnostics spawn nothing either", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process, "arch", { value: "arm64" });

      deviceDetectionService.start();
      const result = await deviceDetectionService.collectIphoneSyncDiagnostics();

      expect(result.iphoneCheckingOn).toBe(false);
      expect(ideviceCalls()).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // `collectDiagnostics()` is what BOTH callers run: the IPC handler and the
  // support-access report queue (supportAccess/index.ts). Calling it directly
  // is the queue's path; the handler case below is the ticket's path.
  describe("collectDiagnostics() — the support-access report queue's path", () => {
    it("checking off: no iPhone helper, and the ticket says it did not check", async () => {
      const diagnostics = await collectDiagnostics();

      expect(ideviceCalls()).toEqual([]);
      expect(diagnostics.iphone_sync.iphone_checking_on).toBe(false);
    });

    it("checking on: the iPhone helper runs and the ticket says it checked", async () => {
      deviceDetectionService.start();

      const diagnostics = await collectDiagnostics();

      expect(ideviceCalls().length).toBeGreaterThan(0);
      expect(diagnostics.iphone_sync.iphone_checking_on).toBe(true);
      expect(diagnostics.iphone_sync.libimobiledevice_available).toBe(true);
    });
  });

  describe("support:collect-diagnostics — the support ticket's path", () => {
    const invoke = async () => {
      const handler = mockIpcHandlers.get("support:collect-diagnostics");
      expect(handler).toBeInstanceOf(Function);
      return (await handler!({})) as {
        success: boolean;
        diagnostics: { iphone_sync: { iphone_checking_on: boolean } };
      };
    };

    it("checking off: no iPhone helper", async () => {
      const res = await invoke();

      expect(res.success).toBe(true);
      expect(ideviceCalls()).toEqual([]);
      expect(res.diagnostics.iphone_sync.iphone_checking_on).toBe(false);
    });

    it("checking on: the iPhone helper runs", async () => {
      deviceDetectionService.start();

      const res = await invoke();

      expect(res.success).toBe(true);
      expect(ideviceCalls().length).toBeGreaterThan(0);
      expect(res.diagnostics.iphone_sync.iphone_checking_on).toBe(true);
    });
  });
});
