/**
 * BACKLOG-3819 L1 (renderer leg) — a renderer console line relayed over
 * `log:renderer` (sent by electron/preload/settingsBridge.ts) reaches main.log
 * with emails and phone numbers redacted.
 *
 * Drives the REAL listener registered by registerSystemHandlers() into the REAL
 * electron-log file transport (mapped back from the jest mock).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockIpcOn = jest.fn();

jest.mock("electron-log", () => jest.requireActual("electron-log/node"));
jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), on: mockIpcOn },
  app: {
    getPath: jest.fn().mockReturnValue("/tmp/test-user-data"),
    // Packaged: logs are sealed (dev builds write redacted plaintext — see
    // config/__tests__/logRedactionDev-3819.test.ts).
    isPackaged: true,
    getAppPath: jest.fn(),
    quit: jest.fn(),
    on: jest.fn(),
    whenReady: jest.fn().mockResolvedValue(undefined),
  },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn(), openPath: jest.fn() },
  BrowserWindow: jest.fn(),
  dialog: { showErrorBox: jest.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: jest.fn() } } },
  Notification: jest.fn(),
}));
jest.mock("../../services/permissionService", () => ({ default: {} }));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/databaseEncryptionService", () => ({ databaseEncryptionService: {} }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../authHandlers", () => ({ initializeDatabase: jest.fn() }));
jest.mock("../../services/connectionStatusService", () => ({ default: {} }));
jest.mock("../../services/macOSPermissionHelper", () => ({ default: {} }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/initializationBroadcaster", () => ({ initializationBroadcaster: {} }));
jest.mock("../../main", () => ({ getAndClearPendingDeepLinkUser: jest.fn() }));
jest.mock("../../bootstrap/appDataPaths", () => ({
  applyAppDataPaths: () => null,
  buildConsoleNotice: () => "",
  logsSealedAtRest: ({ isPackaged }: { isPackaged: boolean }) => isPackaged,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLog = require("electron-log/node");

// Logs are sealed at rest (BACKLOG-3819 encryption): a fixed test key, read back
// through the decrypting reader. Never the keychain.
const TEST_KEY = { keyId: "cd".repeat(16), key: Buffer.alloc(32, 9) };

describe("BACKLOG-3819: renderer log relay is redacted", () => {
  let dir: string;
  let relay: (event: unknown, level: string, message: string) => void;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-relay-3819-"));
    realLog.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    realLog.transports.file.level = "info";
    realLog.transports.console.level = false;
    require("../../bootstrap/installAppDataPaths");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../services/sealedLogSink").getLogSink().activate(TEST_KEY);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../systemHandlers").registerSystemHandlers();
    const call = mockIpcOn.mock.calls.find(([channel]) => channel === "log:renderer");
    if (!call) throw new Error("log:renderer listener was not registered");
    relay = call[1];
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(["info", "warn", "error"])("level %s", (level) => {
    relay({}, level, `[ContactSearch] picked sam.lee@example.com (555) 555-0123 ${level}`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { openSealedLog } = require("../../services/atRest/sealedLog");
    const raw = fs.readFileSync(path.join(dir, "main.log"));
    expect(raw.includes(Buffer.from("[Renderer] [ContactSearch]"))).toBe(false);
    const read = openSealedLog(raw, (id: string) => (id === TEST_KEY.keyId ? TEST_KEY.key : null));
    expect(read.problems).toEqual([]);
    const text: string = read.text;
    expect(text).toContain(`[Renderer] [ContactSearch] picked s***@example.com ***23 ${level}`);
    expect(text).not.toContain("sam.lee@example.com");
    expect(text).not.toContain("555-0123");
  });
});
