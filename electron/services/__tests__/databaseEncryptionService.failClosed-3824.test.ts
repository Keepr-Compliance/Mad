/**
 * @jest-environment node
 */

/**
 * BACKLOG-3824 — the database key must never be regenerated while an existing
 * key store (or an existing encrypted mad.db) is on disk.
 *
 * Real filesystem in a temp directory; only the OS secret store is faked, with
 * the same three methods the shipped ElectronSecretStore exposes. The key store
 * fixture is written by the service's own save path (a first-run call), not
 * hand-built, so its shape is the shape production writes.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { installAppPaths, resetAppPaths } from "../../capabilities/appPathsProvider";
import type { SecretStore } from "../../capabilities/secretStore";
import {
  DatabaseEncryptionService,
  DbKeyUnavailableError,
} from "../databaseEncryptionService";

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

const KEY_STORE = "db-key-store.json";

/** A reversible fake of the OS secret store with switchable failure modes. */
class FakeSecretStore implements SecretStore {
  available = true;
  decryptFails = false;
  decryptCalls = 0;
  encryptCalls = 0;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plaintext: string): Buffer {
    this.encryptCalls++;
    return Buffer.from("WRAP:" + plaintext, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    this.decryptCalls++;
    if (this.decryptFails) {
      throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    }
    const s = encrypted.toString("utf8");
    if (!s.startsWith("WRAP:")) throw new Error("not wrapped by this store");
    return s.slice(5);
  }
}

let dir: string;
let secrets: FakeSecretStore;

function newService(): DatabaseEncryptionService {
  return new DatabaseEncryptionService(secrets);
}

async function provisionKeyStore(): Promise<string> {
  const svc = newService();
  await svc.initialize();
  return svc.getEncryptionKey();
}

function readStoreBytes(): Buffer {
  return fs.readFileSync(path.join(dir, KEY_STORE));
}

function writeEncryptedDb(): void {
  // Anything that is not the plaintext "SQLite format 3\0" header is what
  // isDatabaseEncrypted() treats as an encrypted database.
  fs.writeFileSync(path.join(dir, "mad.db"), crypto.randomBytes(4096));
}

async function expectRefused(svc: DatabaseEncryptionService, reason: string): Promise<void> {
  let caught: unknown;
  try {
    await svc.getEncryptionKey();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DbKeyUnavailableError);
  expect((caught as DbKeyUnavailableError).code).toBe("DB_KEY_UNAVAILABLE");
  expect((caught as DbKeyUnavailableError).reason).toBe(reason);
  expect(svc.getCachedKey()).toBeNull();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3824-"));
  secrets = new FakeSecretStore();
  installAppPaths({ userData: () => dir } as never);
});

afterEach(() => {
  resetAppPaths();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("BACKLOG-3824 database key: never regenerate over an existing store", () => {
  it("(a) first run — no key store, no mad.db — generates and saves a key", async () => {
    const key = await provisionKeyStore();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(dir, KEY_STORE))).toBe(true);

    // And a second process reads the same key back.
    const again = newService();
    await again.initialize();
    expect(await again.getEncryptionKey()).toBe(key);
  });

  it("(a') no key store + plaintext legacy mad.db still generates (legacy encrypt-migration path)", async () => {
    const header = Buffer.alloc(4096);
    header.write("SQLite format 3\0", 0, "utf8");
    fs.writeFileSync(path.join(dir, "mad.db"), header);
    const key = await provisionKeyStore();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(a'') no key store + empty mad.db generates (nothing sealed under any key)", async () => {
    fs.writeFileSync(path.join(dir, "mad.db"), Buffer.alloc(0));
    const key = await provisionKeyStore();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(b) store present but unwrap throws → refuses, writes nothing, key file byte-identical", async () => {
    await provisionKeyStore();
    const before = readStoreBytes();
    const encryptsBefore = secrets.encryptCalls;

    secrets.decryptFails = true;
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "unwrap_failed");

    expect(readStoreBytes().equals(before)).toBe(true);
    expect(secrets.encryptCalls).toBe(encryptsBefore);
    expect(fs.readdirSync(dir).sort()).toEqual([KEY_STORE]);
  });

  it("(b) unwrap yields a value that is not a 32-byte hex key → refuses", async () => {
    await provisionKeyStore();
    const before = readStoreBytes();
    const store = JSON.parse(before.toString("utf8"));
    store.encryptedKey = Buffer.from("WRAP:", "utf8").toString("base64");
    fs.writeFileSync(path.join(dir, KEY_STORE), JSON.stringify(store));
    const tampered = readStoreBytes();

    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "unwrap_failed");
    expect(readStoreBytes().equals(tampered)).toBe(true);
  });

  it("(b) retry succeeds once unwrap recovers, and returns the ORIGINAL key", async () => {
    const original = await provisionKeyStore();
    const before = readStoreBytes();

    secrets.decryptFails = true;
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "unwrap_failed");

    secrets.decryptFails = false;
    expect(await svc.getEncryptionKey()).toBe(original);
    expect(readStoreBytes().equals(before)).toBe(true);
  });

  it("(c) store present but not valid JSON → refuses, file kept byte-identical", async () => {
    const garbage = Buffer.from("{ this is not json", "utf8");
    fs.writeFileSync(path.join(dir, KEY_STORE), garbage);
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "store_corrupt");
    expect(readStoreBytes().equals(garbage)).toBe(true);
    expect(secrets.decryptCalls).toBe(0);
    expect(secrets.encryptCalls).toBe(0);
  });

  it("(c) store present but has no encryptedKey → refuses, file kept byte-identical", async () => {
    const empty = Buffer.from(JSON.stringify({ metadata: { keyId: "x", version: 1 } }), "utf8");
    fs.writeFileSync(path.join(dir, KEY_STORE), empty);
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "store_corrupt");
    expect(readStoreBytes().equals(empty)).toBe(true);
    expect(secrets.encryptCalls).toBe(0);
  });

  it("(c) zero-byte store → refuses, file kept", async () => {
    fs.writeFileSync(path.join(dir, KEY_STORE), Buffer.alloc(0));
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "store_corrupt");
    expect(readStoreBytes().length).toBe(0);
    expect(secrets.encryptCalls).toBe(0);
  });

  it("(d) secure storage unavailable with an existing store → refuses, file byte-identical", async () => {
    await provisionKeyStore();
    const before = readStoreBytes();
    secrets.available = false;
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "secure_storage_unavailable");
    expect(readStoreBytes().equals(before)).toBe(true);
  });

  it("(d) secure storage unavailable on a true first run → throws, creates nothing", async () => {
    secrets.available = false;
    const svc = newService();
    await svc.initialize();
    await expect(svc.getEncryptionKey()).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, KEY_STORE))).toBe(false);
    expect(secrets.encryptCalls).toBe(0);
  });

  it("(e) encrypted mad.db exists but the key store is missing → refuses, creates no store", async () => {
    writeEncryptedDb();
    const svc = newService();
    await svc.initialize();
    await expectRefused(svc, "store_missing");
    expect(fs.existsSync(path.join(dir, KEY_STORE))).toBe(false);
    expect(secrets.encryptCalls).toBe(0);
  });

  it("first-run creation never replaces a store that appeared concurrently", async () => {
    // Two services racing on the same empty profile: both see no store; the
    // second to write must not replace the first's key.
    const a = newService();
    const b = newService();
    await a.initialize();
    await b.initialize();
    const [ka, kb] = await Promise.allSettled([a.getEncryptionKey(), b.getEncryptionKey()]);
    const stored = JSON.parse(readStoreBytes().toString("utf8"));
    const storedKey = secrets.decryptString(Buffer.from(stored.encryptedKey, "base64"));
    for (const r of [ka, kb]) {
      if (r.status === "fulfilled") expect(r.value).toBe(storedKey);
    }
  });
});
