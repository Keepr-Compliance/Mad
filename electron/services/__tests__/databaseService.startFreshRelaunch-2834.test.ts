/**
 * @jest-environment node
 *
 * BACKLOG-2834 — what the next launch does after "Start fresh", on the REAL
 * driver and the REAL key store (databaseEncryptionService over a fake
 * SecretStore, as in databaseService.dbKeyUnavailable-3824.test.ts, whose
 * harness this file reuses).
 *
 * Start fresh = databaseService._moveDatabaseAside("unmigratable") (the
 * production helper) followed by a relaunch. A relaunch is modelled as a
 * fresh initialize({ quitOnUnrecoverableFailure: true }) on the same profile.
 *
 *   R1  the key store is byte-identical after the relaunch (no new key)
 *   R2  the moved file still opens with the key and holds its rows
 *   R3  the relaunch starts on an EMPTY database at the latest version
 *   R4  the saved session's token no longer validates, so
 *       handleGetCurrentUser (sessionHandlers.ts, validateSession -> null ->
 *       clearSession, "Session expired or invalid") asks the user to sign
 *       in: no local user is recreated from a session the new database has
 *       never seen, and nothing on that path writes to the cloud.
 *
 * Run without touching the shared native module:
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/services/__tests__/databaseService.startFreshRelaunch-2834.test.ts
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2834-relaunch-"));
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


describe("BACKLOG-2834 relaunch after Start fresh", () => {
  it("R1-R4 same key, old file intact and readable, empty database, saved session no longer valid", async () => {
    await provisionProfile();
    // A signed-in user: a users_local row and a session row in the old file.
    await service.initialize({ quitOnUnrecoverableFailure: true });
    const user = await service.createUser({
      id: "00000000-0000-0000-0000-000000000000",
      email: "start-fresh@example.invalid",
      display_name: "Start Fresh",
      oauth_provider: "google",
      oauth_id: "oauth-2834",
      subscription_tier: "free",
      subscription_status: "trial",
      is_active: true,
    });
    const token = await service.createSession(user.id);
    // Positive control: the token validates against the old file.
    expect(await service.validateSession(token)).not.toBeNull();
    const key = databaseEncryptionService.getCachedKey() as string;
    resetService();

    const keyStoreBefore = snapshot()["db-key-store.json"];
    expect(keyStoreBefore).toBeDefined();

    // Start fresh, through the production helper.
    service.dbPath = path.join(userDataDir, "mad.db");
    const moved = service._moveDatabaseAside("unmigratable") as string | null;
    service.dbPath = null;
    expect(moved).toMatch(/mad-unmigratable-\d{8}T\d{9}(-\d+)?\.db$/);
    expect(fs.existsSync(path.join(userDataDir, "mad.db"))).toBe(false);

    // The relaunch.
    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();

    // R1
    expect(snapshot()["db-key-store.json"]).toBe(keyStoreBefore);
    expect(databaseEncryptionService.getCachedKey()).toBe(key);

    // R3: empty, current.
    expect(service.db.prepare("SELECT COUNT(*) AS n FROM users_local").get()).toEqual({ n: 0 });
    expect(service.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(
      service.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marker_3824'").get(),
    ).toBeUndefined();
    const version = (service.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number })
      .version;
    expect(version).toBe(service.getLatestSchemaVersion());

    // R4: handleGetCurrentUser's first database check.
    expect(await service.validateSession(token)).toBeNull();
    resetService();

    // R2: the moved file, with the same key.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("../../../node_modules/better-sqlite3-multiple-ciphers");
    const old = new Database(moved as string, { readonly: true });
    try {
      old.pragma(`key = "x'${key}'"`);
      old.pragma("cipher_compatibility = 4");
      expect(old.prepare("SELECT v FROM marker_3824").get()).toEqual({ v: "original" });
      expect(old.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_token = ?").get(token)).toEqual({ n: 1 });
    } finally {
      old.close();
    }
  });
});
