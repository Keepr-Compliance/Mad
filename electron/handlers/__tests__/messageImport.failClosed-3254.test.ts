/**
 * @jest-environment node
 */
/**
 * BACKLOG-3254 — the macOS import runs only for an id it can confirm.
 *
 * `messages:import-macos` resolves "which user is this import for?" with its
 * own inline copy of the same lookup `getValidUserId` performs. This suite pins
 * that an id which is not in `users_local` ends the call rather than being
 * exchanged for a different id.
 *
 * ===========================================================================
 * WHY THE ASSERTION IS "AND NO IMPORT WAS PLANNED"
 * ===========================================================================
 * `{ success: false }` on its own would pass against code that ran the whole
 * import and then reported a failure — which is the outcome this exists to rule
 * out. `resolveImportPlanForUser` is the first thing the handler reaches once
 * it has settled on a user, so "never called" is the assertion that separates
 * "stopped" from "did the work and complained".
 *
 * The `users_local` table is REAL and seeded, and `getRawDatabase()` hands the
 * handler that same database — so the inline lookup runs the production
 * statement against production DDL rather than a hand-written answer.
 *
 * Fixture values are reserved-for-documentation only (`example.com`).
 */

import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";
import { LOCAL_USER_BY_ID_SQL } from "../../services/db/localUserSql";

let db: TestDb;

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args), on: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getUserById: async (id: string) =>
      (db.prepare(LOCAL_USER_BY_ID_SQL).get(id) as { id: string } | undefined) ?? null,
    getRawDatabase: () => db,
    backfillContactCommunicationDates: jest.fn().mockResolvedValue(0),
  },
}));

const mockImportMessages = jest.fn();
jest.mock("../../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: { importMessages: (...a: unknown[]) => mockImportMessages(...a) },
}));

jest.mock("../../services/db/externalContactDbService", () => ({}));

jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));

const mockResolveImportPlanForUser = jest.fn();
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: (...a: unknown[]) => mockResolveImportPlanForUser(...a),
  loadStoredImportFilters: jest.fn().mockResolvedValue({}),
}));

import { registerMessageImportHandlers } from "../messageImportHandlers";

const USER_A = "3f2a1c60-0000-4000-8000-00000000325a";  // pii-allow-uuid: invented, not from any live row
const USER_B = "3f2a1c60-0000-4000-8000-00000000325b";  // pii-allow-uuid: invented, not from any live row
/** Well-formed, and deliberately not seeded. */
const NOT_A_LOCAL_USER = "3f2a1c60-0000-4000-8000-0000000032ff";  // pii-allow-uuid: invented, not from any live row

const SCHEMA_PATH = path.join(__dirname, "../../database/schema.sql");

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>;

/**
 * Captured at registration time. `registerMessageImportHandlers` guards against
 * a second registration with a module-level flag, so it can only run once per
 * module instance — and `jest.clearAllMocks()` in `beforeEach` would otherwise
 * erase the `ipcMain.handle` calls that carry the handlers.
 */
const registered = new Map<string, Handler>();

function handlerFor(channel: string): Handler {
  const entry = registered.get(channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry;
}

const EVENT = {} as IpcMainInvokeEvent;

beforeAll(() => {
  registerMessageImportHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as never);
  for (const [channel, handler] of mockIpcHandle.mock.calls as Array<[string, Handler]>) {
    registered.set(channel, handler);
  }
});

beforeEach(() => {
  jest.clearAllMocks();

  db = openTestDb();
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));

  const insertUser = db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', ?)`,
  );
  insertUser.run(USER_A, "a@example.com", "oauth-3254-a");
  insertUser.run(USER_B, "b@example.com", "oauth-3254-b");

  mockResolveImportPlanForUser.mockResolvedValue({
    mode: "delta",
    fetchStartISO: "2026-01-01T00:00:00.000Z",
    effectiveCap: 100,
    protectedSpans: [],
    fetchAttachments: false,
    overrides: [],
  });
  mockImportMessages.mockResolvedValue({
    success: true,
    messagesImported: 0,
    messagesSkipped: 0,
    attachmentsImported: 0,
    attachmentsUpdated: 0,
    attachmentsSkipped: 0,
    duration: 1,
  });
});

afterEach(() => {
  db.close();
});

describe("messages:import-macos", () => {
  it("reports an error and starts no import for an id that is not a local user", async () => {
    const result = (await handlerFor("messages:import-macos")(
      EVENT,
      NOT_A_LOCAL_USER as never,
      false as never,
    )) as { success: boolean; error?: string; messagesImported?: number };

    expect(result.success).toBe(false);
    expect(result.error).toBe("No valid user found in database");
    // The half that makes this a control rather than a shape assertion.
    expect(mockResolveImportPlanForUser).not.toHaveBeenCalled();
    expect(mockImportMessages).not.toHaveBeenCalled();
  });

  it("plans the import under the supplied id when it is a local user", async () => {
    const result = (await handlerFor("messages:import-macos")(
      EVENT,
      USER_B as never,
      false as never,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockResolveImportPlanForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_B }),
    );
  });
});
