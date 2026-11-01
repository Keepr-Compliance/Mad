/**
 * BACKLOG-3343 — the launch sweep of interrupted iPhone syncs runs inside
 * `initializeDatabase()`: after the database opened (migrations done), awaited, and
 * before initialization resolves. A sweep failure is reported and never blocks startup.
 *
 * MUTATIONS: sweep not awaited (`void`) -> O1 red; sweep's own try/catch removed ->
 * O2 red; Sentry.captureException removed -> O2 red.
 */
describe("initializeDatabase runs the interrupted iPhone sync sweep (BACKLOG-3343)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function setup(sweep: () => Promise<unknown>) {
    const order: string[] = [];
    const mockInitialize = jest.fn(async () => {
      order.push("db-open");
      return true;
    });
    const mockAuditInitialize = jest.fn(() => order.push("audit-init"));
    jest.doMock("electron", () => ({
      ipcMain: { handle: jest.fn(), on: jest.fn() },
      shell: { openExternal: jest.fn() },
      BrowserWindow: jest.fn(),
    }));
    jest.doMock("../../services/databaseService", () => ({ __esModule: true, default: { initialize: mockInitialize } }));
    jest.doMock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
    jest.doMock("../../services/auditService", () => ({
      __esModule: true,
      default: { initialize: mockAuditInitialize, setSupportAccessGate: jest.fn() },
    }));
    jest.doMock("../../services/supportAccess", () => ({ getSupportAccess: jest.fn() }));
    jest.doMock("../../services/logService", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    jest.doMock("../googleAuthHandlers", () => ({ registerGoogleAuthHandlers: jest.fn() }));
    jest.doMock("../microsoftAuthHandlers", () => ({ registerMicrosoftAuthHandlers: jest.fn() }));
    jest.doMock("../sessionHandlers", () => ({ registerSessionHandlers: jest.fn() }));
    jest.doMock("../sharedAuthHandlers", () => ({ registerSharedAuthHandlers: jest.fn() }));
    jest.doMock("../../services/iPhoneSyncStorageService", () => ({
      iPhoneSyncStorageService: {
        recoverInterruptedSessions: jest.fn(async () => {
          await new Promise((r) => setTimeout(r, 20));
          try {
            return await sweep();
          } finally {
            order.push("sweep-done");
          }
        }),
      },
    }));
    let initializeDatabase!: () => Promise<void>;
    let sentry!: { captureException: jest.Mock };
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      initializeDatabase = require("../authHandlers").initializeDatabase;
      sentry = require("@sentry/electron/main");
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
    return { initializeDatabase, order, sentry, mockAuditInitialize };
  }

  it("O1 the sweep finishes after the database opened and before initialization resolves", async () => {
    const { initializeDatabase, order } = setup(async () => ({ found: 0, recovered: 0, durationMs: 0 }));
    await initializeDatabase();
    order.push("init-resolved");
    expect(order).toEqual(["db-open", "sweep-done", "audit-init", "init-resolved"]);
  });

  it("O2 a sweep that throws is reported to Sentry and initialization still completes", async () => {
    const { initializeDatabase, order, sentry, mockAuditInitialize } = setup(async () => {
      throw new Error("injected marker read failure");
    });
    sentry.captureException.mockClear();
    await expect(initializeDatabase()).resolves.toBeUndefined();
    expect(mockAuditInitialize).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["db-open", "sweep-done", "audit-init"]);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "injected marker read failure" }),
      expect.objectContaining({ tags: { area: "iphone-sync-recovery" } }),
    );
  });
});
