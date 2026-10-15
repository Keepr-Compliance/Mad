/**
 * @jest-environment node
 *
 * BACKLOG-3824 — startup when the database key exists but cannot be unwrapped.
 *
 * End to end through the REAL databaseService.initialize() and the REAL
 * databaseEncryptionService, on the REAL better-sqlite3-multiple-ciphers driver
 * (run under Electron's node: `ELECTRON_RUN_AS_NODE=1 npx electron
 * ./node_modules/jest/bin/jest.js <this file>`). Only the OS secret store is
 * faked. The database and its key store are produced by a first real startup,
 * not hand-built.
 *
 * What must hold:
 *   - a blocking dialog with Retry and Quit, and no reset option;
 *   - Retry re-asks secure storage and, once it recovers, opens the SAME data;
 *   - Quit quits and rejects;
 *   - nothing in the profile changes — key store and mad.db byte-identical;
 *   - an encrypted mad.db whose key store is missing is refused, not replaced.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3824";

const showMessageBoxMock = jest.fn();
const quitMock = jest.fn();
const captureExceptionMock = jest.fn();

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: (...args: unknown[]) => quitMock(...args),
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBoxMock(...args),
  },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { installAppPaths } from "../../capabilities/appPathsProvider";
import { installSecretStore } from "../../capabilities/secretStoreProvider";
import type { SecretStore } from "../../capabilities/secretStore";
import { DbKeyUnavailableError } from "../../types";
import { databaseEncryptionService } from "../databaseEncryptionService";

class FakeSecretStore implements SecretStore {
  decryptFails = false;
  encryptCalls = 0;
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(plaintext: string): Buffer {
    this.encryptCalls++;
    return Buffer.from("WRAP:" + plaintext, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    if (this.decryptFails) throw new Error("Error while decrypting the ciphertext");
    return encrypted.toString("utf8").slice(5);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

let service: AnyService;
let secrets: FakeSecretStore;

/** sha256 of every file in the profile, by name. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(userDataDir).sort()) {
    const p = path.join(userDataDir, name);
    if (!fs.statSync(p).isFile()) continue;
    out[name] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  }
  return out;
}

function resetService(): void {
  try {
    service.db?.close();
  } catch {
    /* ignore */
  }
  service.db = null;
  service.dbPath = null;
  service.encryptionKey = null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../db/core/dbConnection").setDb(null);
  databaseEncryptionService.clearCache();
}

/** A first real startup: creates the key store and an encrypted mad.db with a row in it. */
async function provisionProfile(): Promise<string> {
  await service.initialize({ quitOnUnrecoverableFailure: true });
  const key = databaseEncryptionService.getCachedKey() as string;
  service.db.exec("CREATE TABLE marker_3824 (v TEXT); INSERT INTO marker_3824 VALUES ('original');");
  resetService();
  return key;
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3824-startup-"));
  installAppPaths({ userData: () => userDataDir } as never);
  secrets = new FakeSecretStore();
  installSecretStore(secrets);
  showMessageBoxMock.mockReset();
  quitMock.mockReset();
  captureExceptionMock.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  service = require("../databaseService").default;
  resetService();
});

afterEach(() => {
  resetService();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe("BACKLOG-3824 startup with an unavailable database key", () => {
  it("shows Retry/Quit; Retry after recovery opens the ORIGINAL data; profile untouched while refused", async () => {
    const originalKey = await provisionProfile();
    const before = snapshot();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["db-key-store.json", "mad.db"]));

    secrets.decryptFails = true;
    let atDialog: Record<string, string> | null = null;
    showMessageBoxMock.mockImplementation(async () => {
      atDialog = snapshot();
      secrets.decryptFails = false; // the Keychain unlocks while the dialog is up
      return { response: 0 }; // Retry
    });

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    const request = showMessageBoxMock.mock.calls[0][0];
    expect(request.buttons).toEqual(["Retry", "Quit"]);
    expect(request.message).toBe("Keepr can't unlock your data on this computer.");
    expect(request.detail).toBe(
      "Restart your computer and try again. If it keeps happening, contact support.",
    );
    expect(JSON.stringify(request).toLowerCase()).not.toMatch(/reset|delete|start fresh/);

    // While refused, nothing in the profile had changed.
    expect(atDialog).toEqual(before);
    expect(quitMock).not.toHaveBeenCalled();
    expect(databaseEncryptionService.getCachedKey()).toBe(originalKey);
    expect(service.db.prepare("SELECT v FROM marker_3824").get()).toEqual({ v: "original" });

    // Reported once, reason code only.
    const keyEvents = captureExceptionMock.mock.calls.filter(
      ([e]) => e instanceof DbKeyUnavailableError,
    );
    expect(keyEvents).toHaveLength(1);
    expect(keyEvents[0][1]).toEqual({
      tags: { service: "database-service", operation: "initialize", db_key_unavailable: "unwrap_failed" },
    });
    expect((keyEvents[0][0] as Error).message).toBe("Database key unavailable: unwrap_failed");
  });

  it("Quit quits, rejects with DB_KEY_UNAVAILABLE, and leaves key store and mad.db byte-identical", async () => {
    await provisionProfile();
    const before = snapshot();
    const encryptsBefore = secrets.encryptCalls;

    secrets.decryptFails = true;
    showMessageBoxMock.mockResolvedValue({ response: 1 }); // Quit

    let caught: unknown;
    try {
      await service.initialize({ quitOnUnrecoverableFailure: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DbKeyUnavailableError);
    expect((caught as DbKeyUnavailableError).code).toBe("DB_KEY_UNAVAILABLE");
    expect(quitMock).toHaveBeenCalledTimes(1);
    expect(service.isInitialized()).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(secrets.encryptCalls).toBe(encryptsBefore);
  });

  it("Retry while still locked shows the dialog again and still writes nothing", async () => {
    await provisionProfile();
    const before = snapshot();
    secrets.decryptFails = true;
    showMessageBoxMock
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 });

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toBeInstanceOf(
      DbKeyUnavailableError,
    );
    expect(showMessageBoxMock).toHaveBeenCalledTimes(3);
    expect(snapshot()).toEqual(before);
  });

  it("a non-startup caller gets the error with no dialog and no quit", async () => {
    await provisionProfile();
    const before = snapshot();
    secrets.decryptFails = true;
    await expect(service.initialize()).rejects.toBeInstanceOf(DbKeyUnavailableError);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("an encrypted mad.db with its key store missing is refused — no new store, mad.db untouched", async () => {
    await provisionProfile();
    fs.unlinkSync(path.join(userDataDir, "db-key-store.json"));
    const before = snapshot();
    showMessageBoxMock.mockResolvedValue({ response: 1 });

    let caught: unknown;
    try {
      await service.initialize({ quitOnUnrecoverableFailure: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as DbKeyUnavailableError).reason).toBe("store_missing");
    expect(fs.existsSync(path.join(userDataDir, "db-key-store.json"))).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
