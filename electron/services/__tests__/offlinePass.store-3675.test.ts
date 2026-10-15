/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 — offline pass store. Real filesystem in a temp userData dir,
 * a fake OS secret store installed through the real provider seam.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

const mockUserData = { dir: "" };
jest.mock("electron", () => ({
  app: { getPath: () => mockUserData.dir },
}));
jest.mock("../logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});

import { installSecretStore, resetSecretStore } from "../../capabilities/secretStoreProvider";
import type { SecretStore } from "../../capabilities/secretStore";
import {
  readOfflinePass,
  storeOfflinePass,
  deleteOfflinePass,
  OFFLINE_PASS_FILE_NAME,
} from "../offlinePass/offlinePassStore";

const TOKEN = "aGVhZGVy.cGF5bG9hZA.c2ln";
const NOW = 1_790_000_000;

/** Reversible stand-in for the OS store; the prefix marks ciphertext. */
function fakeStore(available = true): SecretStore & { encryptString: jest.Mock } {
  return {
    isEncryptionAvailable: () => available,
    encryptString: jest.fn((plain: string) => Buffer.from(`ENC1:${Buffer.from(plain).toString("base64")}`)),
    decryptString: (buf: Buffer) => {
      const text = buf.toString();
      if (!text.startsWith("ENC1:")) throw new Error("not ciphertext");
      return Buffer.from(text.slice(5), "base64").toString();
    },
  };
}

const passFile = () => path.join(mockUserData.dir, OFFLINE_PASS_FILE_NAME);

beforeEach(() => {
  mockUserData.dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3675-store-"));
  installSecretStore(fakeStore());
});

afterEach(() => {
  rmSync(mockUserData.dir, { recursive: true, force: true });
  resetSecretStore();
});

describe("BACKLOG-3675 offline pass store", () => {
  it("round-trips a pass; the file on disk is ciphertext, not the token", async () => {
    expect(await storeOfflinePass(TOKEN, NOW)).toBe(true);
    const raw = readFileSync(passFile()).toString();
    expect(raw.startsWith("ENC1:")).toBe(true);
    expect(raw).not.toContain(TOKEN);
    expect(await readOfflinePass(NOW)).toEqual({ token: TOKEN, highWaterSec: NOW });
  });

  it("P14 encryption unavailable ⇒ nothing written, read returns null", async () => {
    installSecretStore(fakeStore(false));
    expect(await storeOfflinePass(TOKEN, NOW)).toBe(false);
    expect(existsSync(passFile())).toBe(false);
    expect(await readOfflinePass(NOW)).toBeNull();
  });

  it("P14 no secret store installed ⇒ nothing written, read returns null, nothing thrown", async () => {
    resetSecretStore();
    await expect(storeOfflinePass(TOKEN, NOW)).resolves.toBe(false);
    await expect(readOfflinePass(NOW)).resolves.toBeNull();
    expect(existsSync(passFile())).toBe(false);
  });

  it("P14 corrupt file ⇒ deleted, read returns null", async () => {
    writeFileSync(passFile(), "plaintext that is not ciphertext");
    expect(await readOfflinePass(NOW)).toBeNull();
    expect(existsSync(passFile())).toBe(false);
  });

  it("P14 ciphertext with a malformed record ⇒ deleted, read returns null", async () => {
    writeFileSync(passFile(), `ENC1:${Buffer.from(JSON.stringify({ token: 7 })).toString("base64")}`);
    expect(await readOfflinePass(NOW)).toBeNull();
    expect(existsSync(passFile())).toBe(false);
  });

  it("a read raises the high-water mark to now and persists it", async () => {
    await storeOfflinePass(TOKEN, NOW);
    expect((await readOfflinePass(NOW + 3600))?.highWaterSec).toBe(NOW + 3600);
    // An earlier clock later on still sees the persisted, higher mark.
    expect((await readOfflinePass(NOW + 10))?.highWaterSec).toBe(NOW + 3600);
  });

  it("P13b storing a fresh pass resets a far-future high-water mark to the pass's iat", async () => {
    await storeOfflinePass(TOKEN, NOW);
    const tenYears = NOW + 10 * 365 * 86400;
    expect((await readOfflinePass(tenYears))?.highWaterSec).toBe(tenYears);
    await storeOfflinePass(TOKEN, NOW + 100);
    expect((await readOfflinePass(NOW + 120))?.highWaterSec).toBe(NOW + 120);
  });

  it("delete removes the file; missing file reads as null", async () => {
    await storeOfflinePass(TOKEN, NOW);
    await deleteOfflinePass();
    expect(existsSync(passFile())).toBe(false);
    expect(await readOfflinePass(NOW)).toBeNull();
    await expect(deleteOfflinePass()).resolves.toBeUndefined();
  });
});
