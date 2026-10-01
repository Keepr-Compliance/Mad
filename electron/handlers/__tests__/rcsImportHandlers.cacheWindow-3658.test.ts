/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — `rcs-import:start-cache-job` takes its window from the user's
 * message import settings (the import plan), and honours the DEV-ONLY
 * `{ sinceDays }` override only when the build is NOT packaged.
 *
 * Mutation controls (each turns a test red):
 *   H1 the override honoured in a packaged build (isPackaged not passed)  → "packaged: ignored"
 *   H2 the override dropped in a dev build (args not passed through)      → "dev build: honoured"
 *   H3 the window not taken from the import plan (fixed 60 days)          → "the months setting"
 */

const DAY = 24 * 60 * 60 * 1000;
const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
const created: Array<{ userId: string; since: string }> = [];
const electronApp = { isPackaged: true, getPath: () => "/tmp/keepr-test" };
let planStart: string | null = "2026-07-01T00:00:00.000Z";

jest.mock("electron", () => ({
  app: electronApp,
  ipcMain: { handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
  shell: { openExternal: jest.fn(async () => undefined) },
}));
jest.mock("../../services/rcsExtensionBridge", () => ({
  RcsExtensionBridge: class {
    writesArePaused = false;
    getStatus() {
      return { bridge: "listening", port: 1 };
    }
    activeJob() {
      return null;
    }
    activeJobUserId() {
      return null;
    }
    createCacheJob(userId: string, options: { since: string }) {
      created.push({ userId, since: options.since });
      return { jobId: `job-${created.length}`, kind: "cache", state: "created" };
    }
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRcsCacheState: () => ({ optedInAt: "2026-09-01T00:00:00.000Z", lastCacheFinishedAt: null, ownNumber: null }),
    rcsStagingDbOps: () => ({ deleteAll: () => undefined, journalRows: () => [] }),
  },
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: async () => ({ fetchStartISO: planStart, effectiveCap: 50000, protectedSpans: [] }),
}));
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: async () => ({ user: { id: "user-1" } }) },
}));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/messageMatchingService", () => ({ createCommunicationReference: jest.fn() }));
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../services/db/core/dbConnection", () => ({ dbTransaction: (fn: () => unknown) => fn() }));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: (event: unknown, args?: unknown) => Promise<unknown>) => fn,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerRcsImportHandlers } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");

beforeAll(() => registerRcsImportHandlers());
beforeEach(() => {
  created.length = 0;
  planStart = "2026-07-01T00:00:00.000Z";
});

const start = (args?: unknown) => handlers.get("rcs-import:start-cache-job")!({}, args) as Promise<{ success: boolean }>;

describe("rcs-import:start-cache-job window (BACKLOG-3658)", () => {
  it("the months setting: since = the import plan's start (H3)", async () => {
    electronApp.isPackaged = true;
    expect((await start()).success).toBe(true);
    expect(created[0]).toEqual({ userId: "user-1", since: "2026-07-01T00:00:00.000Z" });
  });

  it("packaged: { sinceDays } is ignored (H1)", async () => {
    electronApp.isPackaged = true;
    expect((await start({ sinceDays: 400 })).success).toBe(true);
    expect(created[0].since).toBe("2026-07-01T00:00:00.000Z");
  });

  it("dev build: { sinceDays } is honoured, clamped to 1..3650 (H2)", async () => {
    electronApp.isPackaged = false;
    const before = Date.now();
    expect((await start({ sinceDays: 99999 })).success).toBe(true);
    const since = Date.parse(created[0].since);
    expect(since).toBeLessThanOrEqual(before - 3650 * DAY + 1000);
    expect(since).toBeGreaterThanOrEqual(before - 3650 * DAY - 60_000);
    electronApp.isPackaged = true;
  });
});
