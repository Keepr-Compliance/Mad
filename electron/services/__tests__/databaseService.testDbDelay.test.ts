/**
 * @jest-environment node
 */

/**
 * Tests for the KEEPR_TEST_DB_DELAY test seam (BACKLOG-1842 resume-at-step
 * fix round).
 *
 * Founder request: a way to reproduce the "relaunch reaches auth/onboarding
 * reads before the local DB is ready" race on demand, rather than only under
 * real memory pressure. databaseService.initialize() now sleeps for
 * KEEPR_TEST_DB_DELAY milliseconds before proceeding, but ONLY when
 * !app.isPackaged AND the env var is set to a positive integer -- double
 * gated the same way permissionHandlers.ts gates KEEPR_E2E, so it is dead
 * code in any packaged/shipped build.
 */

import { jest } from "@jest/globals";

let mockIsPackaged = false;

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
    get isPackaged() {
      return mockIsPackaged;
    },
  },
  dialog: {
    showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => []),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

const mockPrepareGet = jest.fn().mockReturnValue({ version: 9999 });
const mockPrepareRun = jest.fn();
const mockDb = {
  pragma: jest.fn(),
  exec: jest.fn(),
  prepare: jest.fn(() => ({
    get: mockPrepareGet,
    all: jest.fn().mockReturnValue([]),
    run: mockPrepareRun,
  })),
  close: jest.fn(),
  transaction: jest.fn((callback: () => void) => {
    return () => callback();
  }),
};

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn(() => mockDb);
});

jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue("-- schema SQL"),
  readdirSync: jest.fn(() => []),
  copyFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 1024 })),
}));

jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "test-uuid-1234"),
  randomBytes: jest.fn(() => Buffer.from("random-bytes-for-testing")),
}));

jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
  },
}));

const mockLogWarn = jest.fn().mockResolvedValue(undefined);
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: mockLogWarn,
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("electron-log", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../initializationBroadcaster", () => ({
  initializationBroadcaster: {
    broadcast: jest.fn(),
    getCurrentStage: jest.fn().mockReturnValue({ stage: "idle" }),
    reset: jest.fn(),
  },
}));

jest.mock("../db/core/dbConnection", () => ({
  setDb: jest.fn(),
  setDbPath: jest.fn(),
  setEncryptionKey: jest.fn(),
  closeDb: jest.fn(),
  vacuumDb: jest.fn(),
}));

jest.mock("../db/userDbService", () => ({}));
jest.mock("../db/sessionDbService", () => ({}));
jest.mock("../db/oauthTokenDbService", () => ({}));
jest.mock("../db/transactionDbService", () => ({}));
jest.mock("../db/contactDbService", () => ({}));
jest.mock("../db/transactionContactDbService", () => ({}));
jest.mock("../db/communicationDbService", () => ({}));
jest.mock("../db/feedbackDbService", () => ({}));
jest.mock("../db/auditLogDbService", () => ({}));
jest.mock("../db/messageDbService", () => ({}));
jest.mock("../db/diagnosticDbService", () => ({}));
jest.mock("../db/attachmentDbService", () => ({}));
jest.mock("../db/submissionDbService", () => ({}));
jest.mock("../db/syncDbService", () => ({}));
jest.mock("../db/maintenanceDbService", () => ({}));

import databaseService from "../databaseService";

describe("DatabaseService — KEEPR_TEST_DB_DELAY test seam (BACKLOG-1842)", () => {
  const ORIGINAL_ENV = process.env.KEEPR_TEST_DB_DELAY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPackaged = false;
    delete process.env.KEEPR_TEST_DB_DELAY;
    try {
      databaseService.close();
    } catch {
      // May not be initialized
    }
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.KEEPR_TEST_DB_DELAY;
    else process.env.KEEPR_TEST_DB_DELAY = ORIGINAL_ENV;
  });

  it("delays initialize() by the configured ms when unpackaged and the env var is set", async () => {
    process.env.KEEPR_TEST_DB_DELAY = "50";

    const start = Date.now();
    await databaseService.initialize();
    const elapsed = Date.now() - start;

    // Real timers (not faked) — allow scheduling slack, just confirm the
    // delay was actually applied, not skipped.
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("KEEPR_TEST_DB_DELAY"),
      "DatabaseService",
    );
  });

  it("does NOT delay when the env var is unset (default dev/test behavior unchanged)", async () => {
    delete process.env.KEEPR_TEST_DB_DELAY;

    const start = Date.now();
    await databaseService.initialize();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(45);
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("KEEPR_TEST_DB_DELAY"),
      "DatabaseService",
    );
  });

  it("is DEAD CODE when packaged, even if the env var is set (never delays a shipped build)", async () => {
    mockIsPackaged = true;
    process.env.KEEPR_TEST_DB_DELAY = "5000";

    const start = Date.now();
    await databaseService.initialize();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(45);
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("KEEPR_TEST_DB_DELAY"),
      "DatabaseService",
    );
  });

  it("ignores a non-numeric or non-positive value (fails safe, no delay)", async () => {
    process.env.KEEPR_TEST_DB_DELAY = "not-a-number";

    const start = Date.now();
    await databaseService.initialize();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(45);
  });
});
