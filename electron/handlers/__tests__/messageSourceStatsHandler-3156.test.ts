/**
 * @jest-environment node
 */
/**
 * BACKLOG-3156 stage G — `messages:get-source-stats` runs on the contact query
 * worker, never on the main connection (~250 ms at 100k texts on main, measured
 * in messageSourceStatsDb-3156), and reports a worker failure as a failure.
 *
 * Mutation: read through `databaseService.getRawDatabase()` in the handler →
 * "never on main" red.
 */
import type { IpcMainInvokeEvent } from "electron";

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args), on: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
const mockGetRawDatabase = jest.fn(() => {
  throw new Error("main connection touched");
});
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    getUserById: async () => ({ id: "u" }),
    getRawDatabase: () => mockGetRawDatabase(),
  },
}));
jest.mock("../../services/macOSMessagesImportService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/externalContactDbService", () => ({}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(),
  expandAttachedThreadsForUser: jest.fn(),
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: jest.fn(),
  loadStoredImportFilters: jest.fn(),
}));
jest.mock("../../services/macImportMarker", () => ({ recordMacImportRun: jest.fn() }));
const mockQueryContacts = jest.fn();
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: (...a: unknown[]) => mockQueryContacts(...a),
}));

import { registerMessageImportHandlers } from "../messageImportHandlers";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
let handler: Handler;
const STATS = {
  macos: { texts: 3, chats: 1, oldest: "2016-03-01T00:00:00.000Z" },
  iphone: { texts: 0, chats: 0, oldest: null },
  google: { texts: 2, chats: 2, oldest: "2024-08-01T00:00:00.000Z" },
};

beforeAll(() => {
  registerMessageImportHandlers({ isDestroyed: () => false, webContents: { send: jest.fn() } } as never);
  const entry = (mockIpcHandle.mock.calls as Array<[string, Handler]>).find(([c]) => c === "messages:get-source-stats");
  if (!entry) throw new Error("messages:get-source-stats not registered");
  handler = entry[1];
});

beforeEach(() => {
  mockQueryContacts.mockReset();
  mockGetRawDatabase.mockClear();
});

it("never on main: the read goes to the worker with the user id, and returns its answer", async () => {
  mockQueryContacts.mockResolvedValue([STATS]);
  await expect(handler({} as IpcMainInvokeEvent, "user-1")).resolves.toEqual({ success: true, stats: STATS });
  expect(mockQueryContacts).toHaveBeenCalledWith("messageSourceStats", "user-1", expect.any(Number));
  expect(mockGetRawDatabase).not.toHaveBeenCalled();
});

it("a worker failure is a failure (the panel shows dashes), not zeros", async () => {
  mockQueryContacts.mockRejectedValue(new Error("Worker pool not initialized"));
  const r = (await handler({} as IpcMainInvokeEvent, "user-1")) as { success: boolean; stats?: unknown };
  expect(r.success).toBe(false);
  expect(r.stats).toBeUndefined();
  expect(mockGetRawDatabase).not.toHaveBeenCalled();
});

it("no user id: refused before any read", async () => {
  const r = (await handler({} as IpcMainInvokeEvent, "")) as { success: boolean };
  expect(r.success).toBe(false);
  expect(mockQueryContacts).not.toHaveBeenCalled();
});
