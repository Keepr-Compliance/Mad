/**
 * @jest-environment node
 */

/**
 * BACKLOG-3824 fix-up — (1) first-run creation on a filesystem without hard
 * links, (3) unreadable store + encrypted mad.db refuses, (4) an unusable store
 * is set aside only when nothing on disk is sealed under it.
 *
 * Real filesystem in a temp directory; only the OS secret store is faked.
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

class FakeSecretStore implements SecretStore {
  available = true;
  decryptFails = false;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plaintext: string): Buffer {
    return Buffer.from("WRAP:" + plaintext, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    if (this.decryptFails) throw new Error("decrypt failed");
    const s = encrypted.toString("utf8");
    if (!s.startsWith("WRAP:")) throw new Error("not wrapped by this store");
    return s.slice(5);
  }
}

let dir: string;
let secrets: FakeSecretStore;

const store = () => path.join(dir, KEY_STORE);
const file = (name: string) => path.join(dir, name);
const asides = () => fs.readdirSync(dir).filter((n) => /^db-key-store\.unreadable-.+\.json$/.test(n));

async function fresh(): Promise<DatabaseEncryptionService> {
  const svc = new DatabaseEncryptionService(secrets);
  await svc.initialize();
  return svc;
}
function writeEncrypted(name: string): void {
  fs.writeFileSync(file(name), crypto.randomBytes(4096));
}
function writePlaintext(name: string): void {
  const b = Buffer.alloc(4096);
  b.write("SQLite format 3\0", 0, "utf8");
  fs.writeFileSync(file(name), b);
}
async function refusedReason(svc: DatabaseEncryptionService): Promise<string> {
  try {
    await svc.getEncryptionKey();
  } catch (e) {
    expect(e).toBeInstanceOf(DbKeyUnavailableError);
    return (e as DbKeyUnavailableError).reason;
  }
  throw new Error("expected a refusal");
}
/** Break the store in one of the three ways that make it yield no key. */
function breakStore(kind: "corrupt" | "unwrap" | "unreadable"): void {
  if (kind === "corrupt") fs.writeFileSync(store(), "{ not json");
  else if (kind === "unreadable") fs.mkdirSync(store()); // EISDIR on read; root-independent
  else {
    fs.writeFileSync(store(), JSON.stringify({ encryptedKey: Buffer.from("junk").toString("base64"), metadata: {} }));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3824b-"));
  secrets = new FakeSecretStore();
  installAppPaths({ userData: () => dir } as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  resetAppPaths();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("(1) first run on a filesystem without hard links", () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"]) {
    it(`link ${code} falls back to an exclusive create at the real path`, async () => {
      jest.spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("links unsupported"), { code });
      });
      const key = await (await fresh()).getEncryptionKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readdirSync(dir)).toEqual([KEY_STORE]); // temp file removed
      if (process.platform !== "win32") expect(fs.statSync(store()).mode & 0o777).toBe(0o600);
      jest.restoreAllMocks();
      expect(await (await fresh()).getEncryptionKey()).toBe(key);
    });
  }

  it("fallback never replaces a store another writer created first", async () => {
    const winnerSvc = await fresh();
    const winnerKey = await winnerSvc.getEncryptionKey();
    const winnerBytes = fs.readFileSync(store());
    fs.unlinkSync(store());
    jest.spyOn(fs, "linkSync").mockImplementation(() => {
      fs.writeFileSync(store(), winnerBytes); // the other writer lands between our read and our create
      throw Object.assign(new Error("links unsupported"), { code: "EPERM" });
    });
    const key = await (await fresh()).getEncryptionKey();
    expect(key).toBe(winnerKey);
    expect(fs.readFileSync(store()).equals(winnerBytes)).toBe(true);
  });

  it("a link error that is not 'links unsupported' still fails (no silent fallback)", async () => {
    jest.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("disk"), { code: "EIO" });
    });
    await expect((await fresh()).getEncryptionKey()).rejects.toThrow("disk");
    expect(fs.existsSync(store())).toBe(false);
  });
});

describe("(3) store exists but is unreadable", () => {
  it("unreadable store + encrypted mad.db -> refuses with store_unreadable, store untouched", async () => {
    breakStore("unreadable");
    writeEncrypted("mad.db");
    const svc = await fresh();
    expect(await refusedReason(svc)).toBe("store_unreadable");
    expect(fs.statSync(store()).isDirectory()).toBe(true);
    expect(asides()).toEqual([]);
  });
});

describe("(4) unusable store: set aside only when nothing depends on it", () => {
  const kinds = ["corrupt", "unwrap", "unreadable"] as const;
  const reasonOf = { corrupt: "store_corrupt", unwrap: "unwrap_failed", unreadable: "store_unreadable" } as const;

  for (const kind of kinds) {
    it(`${kind} store, no mad.db, no backups -> moved aside (not deleted), new key created`, async () => {
      breakStore(kind);
      const key = await (await fresh()).getEncryptionKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(asides()).toHaveLength(1);
      expect(fs.existsSync(file(asides()[0]))).toBe(true);
      expect(fs.statSync(store()).isFile()).toBe(true);
      expect(await (await fresh()).getEncryptionKey()).toBe(key);
    });

    it(`${kind} store + plaintext legacy mad.db + no backups -> moved aside, new key`, async () => {
      breakStore(kind);
      writePlaintext("mad.db");
      expect(await (await fresh()).getEncryptionKey()).toMatch(/^[0-9a-f]{64}$/);
      expect(asides()).toHaveLength(1);
    });

    it(`${kind} store + encrypted mad.db -> refuses ${reasonOf[kind]}, nothing moved`, async () => {
      breakStore(kind);
      writeEncrypted("mad.db");
      expect(await refusedReason(await fresh())).toBe(reasonOf[kind]);
      expect(asides()).toEqual([]);
    });
  }

  it("the moved-aside file keeps the original bytes", async () => {
    fs.writeFileSync(store(), "{ not json");
    await (await fresh()).getEncryptionKey();
    expect(fs.readFileSync(file(asides()[0]), "utf8")).toBe("{ not json");
  });

  for (const name of ["mad-backup-20260217T143022.db", "mad-pre-junction-backfill.db", "mad.db.encrypted"]) {
    it(`corrupt store + no mad.db + encrypted ${name} -> refuses, store kept`, async () => {
      breakStore("corrupt");
      writeEncrypted(name);
      expect(await refusedReason(await fresh())).toBe("store_corrupt");
      expect(asides()).toEqual([]);
      expect(fs.readFileSync(store(), "utf8")).toBe("{ not json");
    });
  }

  it("corrupt store + plaintext backup copy + no mad.db -> still set aside (plaintext protects nothing)", async () => {
    breakStore("corrupt");
    writePlaintext("mad.db.backup");
    writePlaintext("mad-backup-20260217T143022.db");
    await (await fresh()).getEncryptionKey();
    expect(asides()).toHaveLength(1);
  });

  it("an empty backup file is not evidence", async () => {
    breakStore("corrupt");
    fs.writeFileSync(file("mad-backup-20260217T143022.db"), Buffer.alloc(0));
    await (await fresh()).getEncryptionKey();
    expect(asides()).toHaveLength(1);
  });

  it("if the set-aside rename fails the original refusal stands and no key is created", async () => {
    breakStore("corrupt");
    jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(await refusedReason(await fresh())).toBe("store_corrupt");
    expect(fs.readFileSync(store(), "utf8")).toBe("{ not json");
  });

  it("secure storage unavailable with an unusable store is never set aside", async () => {
    breakStore("corrupt");
    secrets.available = false;
    expect(await refusedReason(await fresh())).toBe("secure_storage_unavailable");
    expect(asides()).toEqual([]);
  });
});
