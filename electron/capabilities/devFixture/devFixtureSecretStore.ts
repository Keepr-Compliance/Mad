/**
 * BACKLOG-3785 repro branch ONLY. {@link SecretStore} for dev fixture mode
 * (electron/bootstrap/devFixtureMode.ts): AES-256-GCM under an env-supplied key.
 * Never imports or calls safeStorage, so no Keychain access can happen through it.
 * Wire format: "dfx1" | iv(12) | tag(16) | ciphertext.
 */
import crypto from "crypto";
import type { SecretStore } from "../secretStore";

const MAGIC = Buffer.from("dfx1");

export class DevFixtureSecretStore implements SecretStore {
  private readonly key: Buffer;

  constructor(hexKey: string | undefined) {
    if (!hexKey || !/^[0-9a-f]{64}$/i.test(hexKey.trim())) {
      // Fail closed: dev fixture mode without a key must never fall back to safeStorage.
      throw new Error("KEEPR_DEV_FIXTURE_MODE=1 requires KEEPR_DEV_FIXTURE_KEY (64 hex chars)");
    }
    this.key = Buffer.from(hexKey.trim(), "hex");
  }

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
  }

  decryptString(encrypted: Buffer): string {
    if (!encrypted.subarray(0, 4).equals(MAGIC)) {
      throw new Error("not a dev-fixture ciphertext");
    }
    const iv = encrypted.subarray(4, 16);
    const tag = encrypted.subarray(16, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString("utf8");
  }
}
