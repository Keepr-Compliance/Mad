/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S4 / BACKLOG-3817 — saved iPhone backup passwords.
 *
 *   P1  the store file never contains the password, in any encoding.
 *   P2  an entry that exists but will not unwrap is NEVER replaced or regenerated:
 *       get/put/replaceVerified throw BackupPasswordUnavailableError and the file bytes
 *       are unchanged.
 *   P3  put never overwrites an existing entry; replaceVerified replaces only a
 *       READABLE one.
 *
 * The fake SecretStore is a real cipher (as in dataKeyService.test.ts) so P1 cannot be
 * vacuous.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { SecretStore } from "../../../capabilities/secretStore";
import {
  BACKUP_PASSWORD_STORE_FILENAME,
  BackupPasswordUnavailableError,
  createBackupPasswordStore,
  generateBackupPassword,
} from "../backupPassword";

class FakeSafeStorage implements SecretStore {
  available = true;
  failDecrypt = false;
  constructor(private readonly master = crypto.randomBytes(32)) {}
  isEncryptionAvailable() {
    return this.available;
  }
  encryptString(plaintext: string): Buffer {
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

const UDID = "00008110-000964C42144801E";
let dir: string;
let ss: FakeSafeStorage;
const storeFile = () => path.join(dir, BACKUP_PASSWORD_STORE_FILENAME);
const store = () => createBackupPasswordStore({ baseDir: () => dir, secretStore: ss });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-bpw-"));
  ss = new FakeSafeStorage();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("generateBackupPassword", () => {
  it("is 32+ characters and different every time", () => {
    const a = generateBackupPassword();
    const b = generateBackupPassword();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });
});

describe("put / get", () => {
  it("absent before anything is saved, found after; P1 the file holds no form of the password", async () => {
    expect(await store().get(UDID)).toEqual({ kind: "absent" });
    const password = generateBackupPassword();
    await store().put(UDID, password, "generated");
    expect(await store().get(UDID)).toEqual({ kind: "found", password, origin: "generated" });

    const raw = fs.readFileSync(storeFile());
    for (const form of [password, Buffer.from(password).toString("base64"), Buffer.from(password).toString("hex")]) {
      expect(raw.includes(form)).toBe(false);
    }
  });

  it("P3 put never overwrites an existing entry", async () => {
    await store().put(UDID, "first-password", "user");
    const before = fs.readFileSync(storeFile());
    await expect(store().put(UDID, "second-password", "generated")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);
    expect(await store().get(UDID)).toEqual({ kind: "found", password: "first-password", origin: "user" });
  });

  it("refuses when secure storage is unavailable, writing nothing", async () => {
    ss.available = false;
    await expect(store().put(UDID, "pw", "user")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    expect(fs.existsSync(storeFile())).toBe(false);
  });
});

describe("P2 fail closed — an entry that will not unwrap", () => {
  beforeEach(async () => {
    await store().put(UDID, "the-real-password", "generated");
    ss.failDecrypt = true;
  });

  it("get throws, put and replaceVerified refuse, and the file bytes are unchanged", async () => {
    const before = fs.readFileSync(storeFile());
    await expect(store().get(UDID)).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    await expect(store().put(UDID, generateBackupPassword(), "generated")).rejects.toBeInstanceOf(
      BackupPasswordUnavailableError,
    );
    await expect(store().replaceVerified(UDID, "typed")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);
  });

  it("a malformed store file is reported, not replaced", async () => {
    ss.failDecrypt = false;
    fs.writeFileSync(storeFile(), "{ not json");
    await expect(store().get(UDID)).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    await expect(store().put("OTHER-UDID", "pw", "user")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
    expect(fs.readFileSync(storeFile(), "utf8")).toBe("{ not json");
  });
});

describe("replaceVerified", () => {
  it("replaces a readable entry and keeps other phones' entries", async () => {
    await store().put(UDID, "old", "user");
    await store().put("OTHER-UDID", "other", "generated");
    await store().replaceVerified(UDID, "new");
    expect(await store().get(UDID)).toEqual({ kind: "found", password: "new", origin: "user" });
    expect(await store().get("OTHER-UDID")).toEqual({ kind: "found", password: "other", origin: "generated" });
  });

  it("refuses when there is nothing to replace", async () => {
    await expect(store().replaceVerified(UDID, "new")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
  });
});

describe("round trip before anyone relies on a saved password", () => {
  it("put fails when the saved entry does not read back as the same password", async () => {
    const lying: SecretStore = {
      isEncryptionAvailable: () => true,
      encryptString: (p: string) => ss.encryptString(p),
      decryptString: (b: Buffer) => `${ss.decryptString(b)}-altered`,
    };
    const s2 = createBackupPasswordStore({ baseDir: () => dir, secretStore: lying });
    await expect(s2.put(UDID, "the-password", "generated")).rejects.toBeInstanceOf(BackupPasswordUnavailableError);
  });
});
