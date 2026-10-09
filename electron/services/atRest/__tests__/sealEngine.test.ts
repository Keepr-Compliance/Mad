/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 seal throughput — the worker-thread seal engine.
 *
 *  E1  every container it writes is read back exactly by fileCrypto (boundary sweep)
 *  E2  classification matches fileCrypto's structural probe (empty / plaintext / sealed / damaged)
 *  E3  in-memory verify: a sealed chunk that does not open to the source is never renamed in
 *  E4  the temp's data is fsynced BEFORE the rename replaces the plaintext
 *  E5  a source that changes while it is sealed is not replaced with the old bytes
 *  E6  a failure leaves the source byte-identical and no temp behind
 *  E7  stop flag: the batch stops at a file boundary
 *  E8  real worker threads (compiled sealWorker) seal, pause, and fall back in-process
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { build } from "esbuild";

import * as fileCryptoModule from "../fileCrypto";
import { createFileCrypto, KENC_TMP_SUFFIX, probeHeader, type KeyResolver } from "../fileCrypto";
import { createSealEngine, type FileOutcome } from "../sealEngine";
import { runPass } from "../sealPool";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = { currentKey: async () => ({ keyId: KEY_ID, key: KEY }), keyFor: async () => KEY };
const CHUNK = 64;
const files = createFileCrypto(resolver, { chunkSize: CHUNK });
const engineKey = { keyId: KEY_ID, key: KEY };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-engine-"));
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
const tempsIn = (d: string) => fs.readdirSync(d).filter((n) => n.endsWith(KENC_TMP_SUFFIX));

describe("E1 — containers read back exactly (sizes swept across chunk boundaries)", () => {
  const sizes = [1, 2, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 2 * CHUNK + 1, 3 * CHUNK, 1000];
  it.each(sizes)("size %i", async (size) => {
    const plain = crypto.randomBytes(size);
    const p = put(`f${size}`, plain);
    const engine = createSealEngine(engineKey, { chunkSize: CHUNK });
    const r = engine.runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "sealed-now" }]);
    expect(r.touchedDirs).toEqual([dir]);
    expect((await probeHeader(p)).encrypted).toBe(true);
    expect((await files.readAllDecrypted(p)).equals(plain)).toBe(true);
    // Windows has no POSIX modes (it reports 666 for a writable file): the 0600 check is POSIX-only.
    if (process.platform !== "win32") expect((fs.statSync(p).mode & 0o777).toString(8)).toBe("600");
    // Idempotent: a second pass leaves it alone.
    expect(engine.runBatch([p], "seal").outcomes).toEqual([{ v: "sealed" }]);
  });
});

describe("E2 — classification", () => {
  it("empty / plaintext / sealed / damaged / gone, in classify mode nothing is written", async () => {
    const empty = put("empty", Buffer.alloc(0));
    const plain = put("plain", Buffer.from("hello"));
    const sealed = put("sealed", Buffer.from("x".repeat(200)));
    await files.encryptFileInPlace(sealed);
    const damaged = put("damaged", Buffer.concat([Buffer.from("KEPRENC"), Buffer.alloc(100, 9)]));
    const shortMagic = put("short", Buffer.from("KEPRENC"));
    const engine = createSealEngine(engineKey, { chunkSize: CHUNK });
    const before = fs.readFileSync(plain);
    const r = engine.runBatch([empty, plain, sealed, damaged, shortMagic, path.join(dir, "missing")], "classify");
    expect(r.outcomes.map((o) => o.v)).toEqual(["empty", "plaintext", "sealed", "damaged", "damaged", "gone"]);
    expect(fs.readFileSync(plain).equals(before)).toBe(true);
    expect(r.touchedDirs).toEqual([]);
  });
});

describe("E3/E6 — in-memory verify gates the rename", () => {
  it("a sealed chunk that does not open to the source bytes fails INTEGRITY; source untouched, no temp", () => {
    const plain = crypto.randomBytes(3 * CHUNK + 5);
    const p = put("v", plain);
    const real = fileCryptoModule.sealChunk;
    jest.spyOn(fileCryptoModule, "sealChunk").mockImplementation((...args) => {
      const out = real(...args);
      out[0] ^= 0x01; // a wrong ciphertext byte: its tag no longer verifies
      return out;
    });
    const engine = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 });
    const r = engine.runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "failed", code: "INTEGRITY" }]);
    expect(fs.readFileSync(p).equals(plain)).toBe(true);
    expect(tempsIn(dir)).toEqual([]);
  });

  it("an I/O error while writing leaves the source byte-identical and removes the temp", () => {
    const plain = crypto.randomBytes(500);
    const p = put("w", plain);
    jest.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("io"), { code: "EIO" });
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 }).runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "failed", code: "EIO" }]);
    expect(fs.readFileSync(p).equals(plain)).toBe(true);
    expect(tempsIn(dir)).toEqual([]);
  });
});

describe("E9 — a READ-ONLY file (Windows refuses to rename over it)", () => {
  it("is made writable and sealed, instead of failing on every pass forever", async () => {
    const plain = crypto.randomBytes(200);
    const p = put("ro", plain);
    fs.chmodSync(p, 0o444);
    const realRename = fs.renameSync;
    // What Windows does: MoveFileEx cannot replace a read-only target.
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if ((fs.statSync(to).mode & 0o200) === 0) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return realRename(from, to);
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 }).runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "sealed-now" }]);
    expect((await files.readAllDecrypted(p)).equals(plain)).toBe(true);
    expect(tempsIn(dir)).toEqual([]);
  });

  it("a read-only file whose second rename also fails keeps its original mode (not left writable)", () => {
    const plain = crypto.randomBytes(50);
    const p = put("ro2", plain);
    fs.chmodSync(p, 0o444);
    const renames = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 }).runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "failed", code: "EPERM" }]);
    expect(renames.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fs.statSync(p).mode & 0o777).toBe(0o444);
    expect(fs.readFileSync(p).equals(plain)).toBe(true);
    expect(tempsIn(dir)).toEqual([]);
  });

  it("a WRITABLE file that refuses (an antivirus lock) is not chmod'ed; it fails after the retries", () => {
    const p = put("locked", crypto.randomBytes(20));
    const chmod = jest.spyOn(fs, "chmodSync");
    jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("busy"), { code: "EPERM" });
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 }).runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "failed", code: "EPERM" }]);
    expect(chmod).not.toHaveBeenCalled();
    expect(tempsIn(dir)).toEqual([]);
  });
});

describe("E4 — durability order", () => {
  it("the temp's data is fsynced before the rename, every time", () => {
    const ps = [put("a/1", crypto.randomBytes(100)), put("a/2", crypto.randomBytes(5)), put("b/3", crypto.randomBytes(300))];
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    jest.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      order.push("fsync");
      return realFsync(fd);
    });
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename");
      return realRename(from, to);
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK }).runBatch(ps, "seal");
    expect(r.outcomes.every((o) => o.v === "sealed-now")).toBe(true);
    expect(order).toEqual(["fsync", "rename", "fsync", "rename", "fsync", "rename"]);
    expect(new Set(r.touchedDirs)).toEqual(new Set([path.join(dir, "a"), path.join(dir, "b")]));
  });
});

describe("E5 — a source that changes while it is sealed", () => {
  it("grows once: retried, and the container holds the NEW bytes", async () => {
    const p = put("g", Buffer.from("a".repeat(100)));
    let n = 0;
    const engine = createSealEngine(engineKey, {
      chunkSize: CHUNK,
      retryDelayMs: 0,
      beforeSeal: () => {
        // The sealer has fstat'ed 100 bytes; the writer appends before the chunks are read.
        if (++n === 1) fs.appendFileSync(p, "b".repeat(50));
      },
    });
    expect(engine.runBatch([p], "seal").outcomes).toEqual([{ v: "sealed-now" }]);
    expect(n).toBe(2);
    expect((await files.readAllDecrypted(p)).toString()).toBe("a".repeat(100) + "b".repeat(50));
  });

  it("rewritten in place (same size) AFTER it was read: the old bytes are not renamed over the new ones; retried with the new bytes", async () => {
    const p = put("r", Buffer.from("a".repeat(100)));
    const realFsync = fs.fsyncSync;
    let n = 0;
    jest.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      // Every chunk has been read and sealed; a writer now replaces the content.
      if (++n === 1) {
        fs.writeFileSync(p, "b".repeat(100));
        const t = new Date(Date.now() + 5_000);
        fs.utimesSync(p, t, t);
      }
      return realFsync(fd);
    });
    const r = createSealEngine(engineKey, { chunkSize: CHUNK, retryDelayMs: 0 }).runBatch([p], "seal");
    expect(r.outcomes).toEqual([{ v: "sealed-now" }]);
    expect((await files.readAllDecrypted(p)).toString()).toBe("b".repeat(100));
  });

  it("keeps changing: gives up, the latest plaintext is left in place, no temp", () => {
    const p = put("c", Buffer.from("a".repeat(100)));
    const engine = createSealEngine(engineKey, {
      chunkSize: CHUNK,
      retryDelayMs: 0,
      beforeSeal: () => fs.appendFileSync(p, "z"),
    });
    expect(engine.runBatch([p], "seal").outcomes).toEqual([{ v: "failed", code: "INTEGRITY" }]);
    expect(fs.readFileSync(p).toString()).toBe("a".repeat(100) + "zzz");
    expect(tempsIn(dir)).toEqual([]);
  });
});

describe("E7 — stop at a file boundary", () => {
  it("stops before the next file and reports what it did", () => {
    const ps = [1, 2, 3, 4].map((i) => put(`s${i}`, crypto.randomBytes(10)));
    let calls = 0;
    const r = createSealEngine(engineKey, { chunkSize: CHUNK }).runBatch(ps, "seal", () => ++calls > 2);
    expect(r.stopped).toBe(true);
    expect(r.outcomes).toEqual([{ v: "sealed-now" }, { v: "sealed-now" }]);
  });
});

describe("E8 — real worker threads", () => {
  let workerScript: string;
  beforeAll(async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "seal-worker-build-"));
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

  function chainOf(n: number): { path: string; size: number; plain: Buffer }[] {
    return Array.from({ length: n }, (_, i) => {
      const plain = crypto.randomBytes(i % 7 === 0 ? 0 : 1 + ((i * 37) % 400));
      const p = put(`${(i % 16).toString(16).padStart(2, "0")}/${i}`, plain);
      return { path: p, size: plain.length, plain };
    });
  }

  it("seals every file off the main thread; every container reads back", async () => {
    const chain = chainOf(300);
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const r = await runPass({ files: chain, mode: "seal", key: engineKey, chunkSize: CHUNK, workers: 3, workerScript, stop });
    expect(r.workersUsed).toBe(3);
    expect(r.stopped).toBe(false);
    for (const [i, f] of chain.entries()) {
      expect(r.outcomes[i]?.v).toBe(f.size === 0 ? "empty" : "sealed-now");
      if (f.size > 0) expect((await files.readAllDecrypted(f.path)).equals(f.plain)).toBe(true);
    }
    const classify = await runPass({ files: chain, mode: "classify", key: engineKey, workers: 2, workerScript, stop });
    expect(classify.outcomes.filter((o) => o?.v === "plaintext")).toEqual([]);
  });

  it("pauses at a file boundary when the flag is set; what it did not reach stays plaintext and is reported as not reached", async () => {
    const chain = chainOf(400);
    const stop = new Int32Array(new SharedArrayBuffer(4));
    let batches = 0;
    const r = await runPass({
      files: chain,
      mode: "seal",
      key: engineKey,
      chunkSize: CHUNK,
      workers: 2,
      workerScript,
      stop,
      onBatch: () => {
        if (++batches === 1) Atomics.store(stop, 0, 1);
      },
    });
    expect(r.stopped).toBe(true);
    const reached = r.outcomes.filter((o): o is FileOutcome => o !== undefined);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.length).toBeLessThan(chain.length);
    // Every file not reached is still exactly its plaintext (never half-written).
    for (const [i, f] of chain.entries()) {
      if (r.outcomes[i] === undefined) expect(fs.readFileSync(f.path).equals(f.plain)).toBe(true);
    }
    expect(fs.readdirSync(dir, { recursive: true }).filter((n) => String(n).endsWith(KENC_TMP_SUFFIX))).toEqual([]);
  });

  it("a worker stops before the first file of a batch when the flag is already set", async () => {
    const { Worker } = await import("worker_threads");
    const p = put("x", crypto.randomBytes(10));
    const stop = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(stop, 0, 1);
    const w = new Worker(workerScript, { workerData: { key: new Uint8Array(KEY), keyId: KEY_ID, chunkSize: CHUNK, stop: stop.buffer } });
    try {
      const msg = await new Promise<{ outcomes: unknown[]; stopped: boolean }>((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
        w.postMessage({ type: "batch", id: 0, mode: "seal", files: [p] });
      });
      expect(msg).toMatchObject({ outcomes: [], stopped: true });
      expect((await probeHeader(p)).encrypted).toBe(false);
    } finally {
      await w.terminate();
    }
  });

  it("a worker that cannot start: the pass runs in-process and still seals everything", async () => {
    const chain = chainOf(20);
    const logs: string[] = [];
    const r = await runPass({
      files: chain,
      mode: "seal",
      key: engineKey,
      chunkSize: CHUNK,
      workers: 2,
      workerScript: path.join(dir, "no-such-worker.js"),
      stop: new Int32Array(new SharedArrayBuffer(4)),
      log: (_l, m) => logs.push(m),
    });
    expect(r.stopped).toBe(false);
    expect(chain.every((f, i) => r.outcomes[i]?.v === (f.size === 0 ? "empty" : "sealed-now"))).toBe(true);
    expect(logs.some((m) => /seal worker/.test(m))).toBe(true);
  });
});
