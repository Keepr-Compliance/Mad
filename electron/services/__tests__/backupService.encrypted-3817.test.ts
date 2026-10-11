/**
 * BACKLOG-3817: `startBackup` on a phone that encrypts its backups.
 *
 *  - the phone's setting is read from the com.apple.mobile.backup domain;
 *  - the password is checked against the backup's keybag and NOTHING is decrypted here
 *    (no `decrypted/`, no `Manifest.db.decrypted` beside the backup) — the orchestrator
 *    decrypts once into a parse copy;
 *  - the returned path is the real backup;
 *  - the password never reaches argv or a log line.
 *
 * Real fs, real decryption service, SYNTHETIC ORACLE-VALIDATED fixture
 * (fixtures/encryptedIosBackup.ts). Run under Electron's node for the real SQLite driver.
 */
const actualModulePath = require.resolve("better-sqlite3-multiple-ciphers", {
  paths: [require("path").join(__dirname, "../../../node_modules")],
});
jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(actualModulePath);
});

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => process.env.KEEPR_3817_USERDATA as string), isPackaged: false },
}));
const logged: string[] = [];
const capture = (...args: unknown[]) => {
  logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};
jest.mock("electron-log", () => ({
  default: { info: capture, debug: capture, warn: capture, error: capture },
  info: (...a: unknown[]) => capture(...a),
  debug: (...a: unknown[]) => capture(...a),
  warn: (...a: unknown[]) => capture(...a),
  error: (...a: unknown[]) => capture(...a),
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: (...a: unknown[]) => capture("SENTRY", ...a),
  captureMessage: (...a: unknown[]) => capture("SENTRY", ...a),
  addBreadcrumb: (...a: unknown[]) => capture("SENTRY", ...a),
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => `/mock/${name}`),
  isMockMode: jest.fn().mockReturnValue(false),
}));

import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { BackupService } from "../backupService";
import { buildEncryptedBackup } from "./fixtures/encryptedIosBackup";

const UDID = "00008110-000964C42144801E";
const PASSWORD = "user-chosen backup password 3817";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

let userData: string;

function phone(willEncrypt: "true" | "false") {
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    setTimeout(() => {
      if (cmd.includes("ideviceinfo")) proc.stdout.emit("data", Buffer.from(`${willEncrypt}\n`));
      else proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.emit("close", 0);
    }, 0);
    return proc;
  });
}

beforeAll(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3817-bs-"));
  process.env.KEEPR_3817_USERDATA = userData;
  buildEncryptedBackup({
    backupDir: path.join(userData, "Backups", UDID),
    password: PASSWORD,
    files: [{ domain: "HomeDomain", relativePath: "Library/SMS/sms.db", content: Buffer.from("x".repeat(100)) }],
  });
});
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));
beforeEach(() => {
  mockSpawn.mockReset();
  logged.length = 0;
});

const backupDir = () => path.join(userData, "Backups", UDID);
const listing = () => fs.readdirSync(backupDir()).sort();

describe("BACKLOG-3817 startBackup with an encrypted backup", () => {
  it("queries WillEncrypt in the com.apple.mobile.backup domain", async () => {
    phone("false");
    const status = await new BackupService().checkEncryptionStatus(UDID);
    expect(mockSpawn.mock.calls[0][1]).toEqual(["-u", UDID, "-q", "com.apple.mobile.backup", "-k", "WillEncrypt"]);
    expect(status.status).toBe("off");
  });

  it("a failed WillEncrypt read is 'unknown', never 'off'", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new FakeProcess();
      setTimeout(() => proc.emit("close", 255), 0);
      return proc;
    });
    expect((await new BackupService().checkEncryptionStatus(UDID)).status).toBe("unknown");
  });

  it("BACKLOG-3881: a phone that encrypts is refused before any backup runs, and no password is asked for", async () => {
    phone("true");
    const service = new BackupService();
    const asked = jest.fn();
    service.on("password-required", asked);
    const result = await service.startBackup({ udid: UDID });
    expect(result.errorCode).toBe("PASSWORD_REQUIRED");
    expect(asked).not.toHaveBeenCalled();
    expect(mockSpawn.mock.calls.every((c) => !String(c[0]).includes("idevicebackup2"))).toBe(true);
  });
});

describe("BACKLOG-3816 3598 interplay — a valid encrypted chain is never a leftover", () => {
  it("an encrypted Manifest.db (ciphertext, not SQLite) is 'indexed' and the sweep keeps the chain", async () => {
    const service = new BackupService();
    expect(await service.classifyBackupFolder(UDID)).toBe("indexed");
    const before = listing();
    const sweep = await service.sweepLeftoverBackups();
    expect(sweep.removed).toBe(0);
    expect(listing()).toEqual(before);
    expect(await service.readChainEncryption(UDID)).toBe("encrypted");
  });

  it("a chain moved aside is invisible to the sweep and removed only by removeReplacedChains", async () => {
    const service = new BackupService();
    const other = "00008101-0099887766554433";
    const plain = path.join(userData, "Backups", other);
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "Manifest.db"), "SQLite format 3\u0000");
    const aside = await service.moveChainAside(other);
    expect(path.basename(aside!).startsWith(".keepr-replaced-")).toBe(true);
    await service.sweepLeftoverBackups();
    expect(fs.existsSync(aside!)).toBe(true);
    expect(await service.hasReplacedChain(other)).toBe(true);
    expect(await service.removeReplacedChains(other)).toBe(1);
    expect(fs.existsSync(aside!)).toBe(false);
    // The encrypted chain of the first phone is untouched.
    expect(fs.existsSync(path.join(userData, "Backups", UDID, "Manifest.db"))).toBe(true);
  });
});

describe("BACKLOG-3816 removePlaintextChain", () => {
  it("never removes an encrypted chain; removes a plaintext one", async () => {
    const service = new BackupService();
    expect(await service.removePlaintextChain(UDID)).toBe(false);
    expect(fs.existsSync(path.join(userData, "Backups", UDID, "Manifest.db"))).toBe(true);

    const other = "00008101-00AABBCCDDEEFF00";
    const plain = path.join(userData, "Backups", other);
    fs.mkdirSync(plain, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fs.writeFileSync(path.join(plain, "Manifest.plist"), require("bplist-creator")({ IsEncrypted: false }));
    expect(await service.removePlaintextChain(other)).toBe(true);
    expect(fs.existsSync(plain)).toBe(false);
  });
});
