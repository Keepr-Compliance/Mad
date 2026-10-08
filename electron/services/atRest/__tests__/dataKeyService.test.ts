/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S0 — file-data key service.
 *
 *   K1  the store file never contains the raw key, in any encoding.
 *   K2  a store that exists but will not unwrap is NOT replaced: the call throws
 *       DataKeyUnavailableError and the store bytes are unchanged.
 *
 * The fake SecretStore is a real cipher (AES-256-GCM under a fixed test master
 * key), standing in for safeStorage. An identity or base64 fake would make K1 red
 * on correct code (the wrapped blob would BE the key) or vacuous.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { SecretStore } from "../../../capabilities/secretStore";
import {
  DATA_KEY_STORE_FILENAME,
  DataKeyUnavailableError,
  createDataKeyService,
  keyIdFor,
} from "../dataKeyService";
import { createFileCrypto } from "../fileCrypto";
import { Readable } from "stream";

class FakeSafeStorage implements SecretStore {
  available = true;
  failDecrypt = false;
  encryptCalls = 0;
  constructor(private readonly master = crypto.randomBytes(32)) {}
  isEncryptionAvailable() {
    return this.available;
  }
  encryptString(plaintext: string): Buffer {
    this.encryptCalls++;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.master, iv);
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from("v10"), iv, c.getAuthTag(), body]);
  }
  decryptString(sealed: Buffer): string {
    if (this.failDecrypt) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    const iv = sealed.subarray(3, 15);
    const tag = sealed.subarray(15, 31);
    const d = crypto.createDecipheriv("aes-256-gcm", this.master, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(sealed.subarray(31)), d.final()]).toString("utf8");
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-atrest-dk-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const storeFile = () => path.join(dir, DATA_KEY_STORE_FILENAME);

function service(secretStore: SecretStore) {
  return createDataKeyService({ baseDir: () => dir, secretStore });
}

describe("create", () => {
  it("creates a 32-byte key once, 0600, and reuses it across instances", async () => {
    const ss = new FakeSafeStorage();
    const a = await service(ss).currentKey();
    expect(a.key.length).toBe(32);
    expect(a.keyId).toBe(keyIdFor(a.key));
    if (process.platform !== "win32") {
      expect(fs.statSync(storeFile()).mode & 0o777).toBe(0o600);
    }
    const b = await service(ss).currentKey();
    expect(b.key.equals(a.key)).toBe(true);
    expect(ss.encryptCalls).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([DATA_KEY_STORE_FILENAME]);
  });

  it("concurrent first calls create exactly one key", async () => {
    const ss = new FakeSafeStorage();
    const svc = service(ss);
    const [a, b, c] = await Promise.all([svc.currentKey(), svc.currentKey(), svc.currentKey()]);
    expect(b.key.equals(a.key) && c.key.equals(a.key)).toBe(true);
    expect(ss.encryptCalls).toBe(1);
  });

  it("keyFor returns the current key by id and refuses an unknown id", async () => {
    const svc = service(new FakeSafeStorage());
    const { keyId, key } = await svc.currentKey();
    expect((await svc.keyFor(keyId)).equals(key)).toBe(true);
    await expect(svc.keyFor("00".repeat(16))).rejects.toBeInstanceOf(DataKeyUnavailableError);
  });

  it("files written with the service decrypt with a fresh service over the same store", async () => {
    const ss = new FakeSafeStorage();
    const file = path.join(dir, "a.bin");
    await createFileCrypto(service(ss)).encryptStreamToFile(Readable.from([Buffer.from("hello")]), file);
    expect((await createFileCrypto(service(ss)).readAllDecrypted(file)).toString()).toBe("hello");
  });
});

describe("K1 — the raw key never reaches disk", () => {
  it("the store contains the key in no encoding", async () => {
    const { key } = await service(new FakeSafeStorage()).currentKey();
    const raw = fs.readFileSync(storeFile());
    const text = raw.toString("utf8");
    const encodings = {
      binary: key,
      hex: Buffer.from(key.toString("hex")),
      HEX: Buffer.from(key.toString("hex").toUpperCase()),
      base64: Buffer.from(key.toString("base64")),
      base64url: Buffer.from(key.toString("base64url")),
    };
    for (const [name, needle] of Object.entries(encodings)) {
      if (raw.includes(needle)) throw new Error(`store contains the key as ${name}`);
    }
    // Nor any 16-byte window of it (a partial leak is still a leak).
    expect(raw.includes(key.subarray(0, 16))).toBe(false);
    expect(text.includes(key.subarray(8, 24).toString("hex"))).toBe(false);
    expect(text.includes(key.toString("base64").slice(0, 20))).toBe(false);
  });
});

describe("K2 — an existing store is never replaced", () => {
  async function seeded() {
    const ss = new FakeSafeStorage();
    const original = await service(ss).currentKey();
    return { ss, original, bytes: fs.readFileSync(storeFile()) };
  }

  function expectUntouched(bytes: Buffer) {
    expect(fs.readFileSync(storeFile()).equals(bytes)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([DATA_KEY_STORE_FILENAME]);
  }

  it("unwrap failure throws DataKeyUnavailableError and writes nothing", async () => {
    const { ss, bytes } = await seeded();
    ss.failDecrypt = true;
    const before = ss.encryptCalls;
    await expect(service(ss).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expect(ss.encryptCalls).toBe(before);
    expectUntouched(bytes);
  });

  it("a different master key (keychain reset) throws and writes nothing", async () => {
    const { bytes } = await seeded();
    await expect(service(new FakeSafeStorage()).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expectUntouched(bytes);
  });

  it("malformed JSON throws and writes nothing", async () => {
    await seeded();
    fs.writeFileSync(storeFile(), "{not json");
    const bytes = fs.readFileSync(storeFile());
    await expect(service(new FakeSafeStorage()).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expectUntouched(bytes);
  });

  it("a wrapped key of the wrong length throws and writes nothing", async () => {
    const ss = new FakeSafeStorage();
    const short = crypto.randomBytes(16);
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({
        version: 1,
        current: {
          keyId: keyIdFor(short),
          wrapped: ss.encryptString(short.toString("base64")).toString("base64"),
          createdAt: "x",
        },
        previous: [],
      }),
    );
    const bytes = fs.readFileSync(storeFile());
    await expect(service(ss).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expectUntouched(bytes);
  });

  it("secure storage unavailable throws and creates nothing", async () => {
    const ss = new FakeSafeStorage();
    ss.available = false;
    await expect(service(ss).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an unreadable store (EISDIR) throws rather than creating", async () => {
    fs.mkdirSync(storeFile());
    await expect(service(new FakeSafeStorage()).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    expect(fs.statSync(storeFile()).isDirectory()).toBe(true);
  });

  it("after the failure clears, the ORIGINAL key comes back", async () => {
    const { ss, original } = await seeded();
    ss.failDecrypt = true;
    await expect(service(ss).currentKey()).rejects.toBeInstanceOf(DataKeyUnavailableError);
    ss.failDecrypt = false;
    const again = await service(ss).currentKey();
    expect(again.key.equals(original.key)).toBe(true);
  });
});
