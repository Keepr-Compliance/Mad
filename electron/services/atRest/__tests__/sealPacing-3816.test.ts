/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 (2.41 PC QA: the app froze during the post-sync seal).
 *  b1 — the seal pool runs 2 workers whatever the core count.
 *  b2 — a file the listing saw at 0 bytes is classified "empty" without being opened, and
 *       never reaches a worker; the reports' empty counts are unchanged.
 */
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { build } from "esbuild";
import plist from "simple-plist";

import { BackupAtRest } from "../backupAtRest";
import { createFileCrypto, type KeyResolver } from "../fileCrypto";
import { createMarkerStore } from "../markers";
import { defaultSealWorkers, runPass, SEAL_WORKER_COUNT } from "../sealPool";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = { currentKey: async () => ({ keyId: KEY_ID, key: KEY }), keyFor: async () => KEY };
const CHUNK = 64;
const files = createFileCrypto(resolver, { chunkSize: CHUNK });
const engineKey = { keyId: KEY_ID, key: KEY };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-pacing-"));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(name: string, data: Buffer): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/** 12 plaintext files and 9 empty ones, interleaved. */
function mixed(): { path: string; size: number }[] {
  return Array.from({ length: 21 }, (_, i) => {
    const data = i % 7 === 0 || i % 3 === 0 ? Buffer.alloc(0) : crypto.randomBytes(20 + i * 11);
    const p = put(`${(i % 4).toString(16).padStart(2, "0")}/f${i}`, data);
    return { path: p, size: data.length };
  });
}

describe("b1: seal workers", () => {
  it("is 2 on an 8-core machine (was max(2, min(8, cpus - 1)) = 7)", () => {
    jest.spyOn(os, "cpus").mockReturnValue(new Array(8).fill(os.cpus()[0]));
    expect(SEAL_WORKER_COUNT).toBe(2);
    expect(defaultSealWorkers()).toBe(2);
  });
});

describe("b2: a 0-byte file is never opened", () => {
  it("in-process: no open of an empty file; empties classified `empty`, the rest sealed", async () => {
    const list = mixed();
    const empty = new Set(list.filter((f) => f.size === 0).map((f) => f.path));
    expect(empty.size).toBe(9);
    const opened: string[] = [];
    const realOpen = fs.openSync;
    jest.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const r = await runPass({ files: list, mode: "seal", key: engineKey, chunkSize: CHUNK, workers: 0, stop });
    expect(opened.length).toBeGreaterThan(0); // the spy sees the engine's opens
    expect(opened.filter((p) => empty.has(p))).toEqual([]);
    list.forEach((f, i) => expect(r.outcomes[i]?.v).toBe(f.size === 0 ? "empty" : "sealed-now"));
  });

  describe("real worker threads", () => {
    let workerScript: string;
    beforeAll(async () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "seal-pacing-worker-"));
      workerScript = path.join(out, "sealWorker.js");
      await build({
        entryPoints: [path.join(__dirname, "..", "sealWorker.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: workerScript,
        logLevel: "silent",
      });
    });

    it("an empty file never reaches a worker: removed after the listing, it still reads `empty` (a worker opening it would say `gone`)", async () => {
      const list = mixed();
      for (const f of list) if (f.size === 0) fs.rmSync(f.path);
      const stop = new Int32Array(new SharedArrayBuffer(4));
      const r = await runPass({ files: list, mode: "seal", key: engineKey, chunkSize: CHUNK, workers: 2, workerScript, stop });
      expect(r.workersUsed).toBeGreaterThan(0); // the plaintext files went to a worker
      list.forEach((f, i) => expect(r.outcomes[i]?.v).toBe(f.size === 0 ? "empty" : "sealed-now"));
      const classify = await runPass({ files: list, mode: "classify", key: engineKey, workers: 2, workerScript, stop });
      list.forEach((f, i) => expect(classify.outcomes[i]?.v).toBe(f.size === 0 ? "empty" : "sealed"));
    });

    it("a pass of only empty files starts no worker and reports every one", async () => {
      const list = mixed().filter((f) => f.size === 0);
      const stop = new Int32Array(new SharedArrayBuffer(4));
      const r = await runPass({ files: list, mode: "seal", key: engineKey, chunkSize: CHUNK, workers: 2, workerScript, stop });
      expect(r.workersUsed).toBe(0);
      expect(r.outcomes.map((o) => o?.v)).toEqual(list.map(() => "empty"));
    });
  });

  it("a stopped pass leaves the empties unreached, like any other file", async () => {
    const list = mixed();
    const stop = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(stop, 0, 1);
    const r = await runPass({ files: list, mode: "seal", key: engineKey, chunkSize: CHUNK, workers: 0, stop });
    expect(r.stopped).toBe(true);
    expect(r.outcomes.filter((o) => o !== undefined)).toEqual([]);
  });

  it("the backup seal: the `sealed` line's empty count is the chain's 0-byte files, and none of them is opened", async () => {
    const UDID = "00008110-000A1B2C3D4E5F60";
    const userData = path.join(dir, "userData");
    const backups = path.join(userData, "Backups");
    const chain = path.join(backups, UDID);
    const w = (rel: string, data: Buffer | string) => {
      const p = path.join(chain, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      return p;
    };
    w("Info.plist", plist.stringify({ "Device Name": "Test" }));
    w("Status.plist", plist.stringify({ SnapshotState: "finished", IsFullBackup: false }));
    w("Manifest.plist", plist.stringify({ IsEncrypted: false }));
    w("Manifest.db", "SQLite format 3\0" + "index rows ".repeat(40));
    const empties = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const rel = `${String(i % 10).padStart(2, "0")}/${"c".repeat(30)}${String(i).padStart(10, "0")}`;
      if (i % 3 === 0) empties.add(w(rel, Buffer.alloc(0)));
      else w(rel, crypto.randomBytes(120));
    }
    const logged: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const s = new BackupAtRest({
      backupsRoot: () => backups,
      files: () => files,
      markers: () => createMarkerStore({ userData: () => userData }),
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      sleep: async () => undefined,
      log: (_level, message, data) => logged.push({ message, data }),
      concurrency: 4,
      chunkSize: CHUNK,
      appVersion: () => "2.41.0",
    });
    const opened: string[] = [];
    const realOpen = fs.openSync;
    jest.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    expect(await s.migrate(UDID)).toBe("encrypted");
    const sealed = logged.filter((l) => l.message === "[BackupAtRest] sealed").pop();
    expect(empties.size).toBe(10);
    expect(sealed?.data).toMatchObject({ empty: 10, failed: 0, plaintextLeft: 0 });
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((p) => empties.has(p))).toEqual([]);
  });
});
