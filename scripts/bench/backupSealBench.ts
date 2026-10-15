/**
 * BACKLOG-3816 — throughput benchmark for sealing the kept iPhone backup.
 *
 * Runs the REAL seal path (BackupAtRest + fileCrypto) against a COPY of a folder.
 * The source folder is only read (copied once); every write happens under <workDir>.
 * No Keepr install, no key store, no network: a random in-memory key is used.
 *
 *   node backup-seal-bench.js <srcDir> <workDir> [--delta 0.5] [--delta-mb 2000] [--workers N] [--profile] [--no-fsync] [--keep]
 *   node backup-seal-bench.js --make-fixture <dir> [--files 50000] [--big-mb 1024] [--seed 1]
 *
 * <srcDir> is laid out like a backup chain (Manifest.db, XX/<fileID>, ...) or any folder.
 * Reports files/s, MB/s, main-thread event-loop utilisation and max block, and with
 * --profile the summed latency of each fs operation (where the wall time goes).
 *
 * --delta N : after the full seal, rewrite N % of the files as new plaintext (what an
 *             incremental sync leaves behind) and time the post-sync seal on its own.
 *
 * Build (one file, plain Node >= 20): node scripts/bench/build-backup-seal-bench.mjs
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { monitorEventLoopDelay, performance } from "perf_hooks";

import { BackupAtRest } from "../../electron/services/atRest/backupAtRest";
import { createFileCrypto, type KeyResolver } from "../../electron/services/atRest/fileCrypto";
import { createMarkerStore } from "../../electron/services/atRest/markers";
import { defaultSealWorkers } from "../../electron/services/atRest/sealPool";

const UDID = "00008110-BENCH0000000000";
/** Inlined by build-backup-seal-bench.mjs (the bundled sealWorker). Absent = run in-process. */
declare const __SEAL_WORKER_SOURCE__: string | undefined;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

// ---------------------------------------------------------------------------
// Fixture: mirrors the founder's mix (sample of 1,000: ~48% empty or < 1 KB)
// ---------------------------------------------------------------------------

function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function makeFixture(dir: string, count: number, bigMb: number, seed: number): void {
  const rnd = makeRng(seed);
  const pool = crypto.randomBytes(8 * 1024 * 1024);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["Info.plist", "Status.plist"]) {
    fs.writeFileSync(path.join(dir, name), `<?xml version="1.0"?><plist version="1.0"><dict/></plist>`);
  }
  fs.writeFileSync(
    path.join(dir, "Manifest.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>IsEncrypted</key><false/></dict></plist>`,
  );
  fs.writeFileSync(path.join(dir, "Manifest.db"), pool.subarray(0, 4 * 1024 * 1024));
  let total = 0;
  const hist: Record<string, number> = { "0": 0, "1B-1K": 0, "1K-64K": 0, "64K-4M": 0, "4M-64M": 0, big: 0 };
  const writeOne = (size: number, i: number) => {
    const id = crypto.createHash("sha1").update(`f${seed}-${i}`).digest("hex");
    const sub = path.join(dir, id.slice(0, 2));
    fs.mkdirSync(sub, { recursive: true });
    const fd = fs.openSync(path.join(sub, id), "w");
    let left = size;
    let off = Math.floor(rnd() * 1024);
    while (left > 0) {
      const n = Math.min(left, pool.length - off);
      fs.writeSync(fd, pool, off, n);
      left -= n;
      off = 0;
    }
    fs.closeSync(fd);
    total += size;
  };
  for (let i = 0; i < count; i++) {
    const r = rnd();
    let size: number;
    if (r < 0.25) {
      size = 0;
      hist["0"]++;
    } else if (r < 0.48) {
      size = 1 + Math.floor(rnd() * 1023);
      hist["1B-1K"]++;
    } else if (r < 0.85) {
      size = 1024 + Math.floor(rnd() * 63 * 1024);
      hist["1K-64K"]++;
    } else if (r < 0.998) {
      size = 64 * 1024 + Math.floor(rnd() * rnd() * rnd() * 4 * 1024 * 1024);
      hist["64K-4M"]++;
    } else {
      size = 4 * 1024 * 1024 + Math.floor(rnd() * rnd() * 60 * 1024 * 1024);
      hist["4M-64M"]++;
    }
    writeOne(size, i);
  }
  if (bigMb > 0) {
    writeOne(bigMb * 1024 * 1024, count);
    hist.big++;
  }
  console.log(JSON.stringify({ fixture: dir, files: count + (bigMb > 0 ? 1 : 0), totalMB: +(total / 1048576).toFixed(1), hist }));
}

// ---------------------------------------------------------------------------
// Profiling: summed latency per fs operation (concurrent ops overlap; this is
// where the wall time is SPENT waiting, not CPU)
// ---------------------------------------------------------------------------

const prof = new Map<string, { n: number; ms: number }>();
function wrapAsync(obj: Record<string, unknown>, name: string, label: string): void {
  const orig = obj[name] as (...a: unknown[]) => Promise<unknown>;
  if (typeof orig !== "function") return;
  obj[name] = function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    const done = () => {
      const e = prof.get(label) ?? { n: 0, ms: 0 };
      e.n++;
      e.ms += performance.now() - t;
      prof.set(label, e);
    };
    const p = orig.apply(this, a);
    return p.then(
      (v) => {
        done();
        return v;
      },
      (err) => {
        done();
        throw err;
      },
    );
  };
}
function wrapSync(obj: Record<string, unknown>, name: string, label: string): void {
  const orig = obj[name] as (...a: unknown[]) => unknown;
  if (typeof orig !== "function") return;
  obj[name] = function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    try {
      return orig.apply(this, a);
    } finally {
      const e = prof.get(label) ?? { n: 0, ms: 0 };
      e.n++;
      e.ms += performance.now() - t;
      prof.set(label, e);
    }
  };
}

async function installProfiling(): Promise<void> {
  const p = fs.promises as unknown as Record<string, unknown>;
  for (const n of ["open", "stat", "lstat", "readdir", "rename", "rm", "mkdir", "unlink", "readFile"]) wrapAsync(p, n, `fs.${n}`);
  const tmp = path.join(os.tmpdir(), `kbench-${process.pid}`);
  fs.writeFileSync(tmp, "x");
  const h = await fs.promises.open(tmp, "r");
  const proto = Object.getPrototypeOf(h) as Record<string, unknown>;
  await h.close();
  fs.rmSync(tmp);
  for (const n of ["read", "write", "sync", "close", "stat", "writeFile"]) wrapAsync(proto, n, `handle.${n}`);
  const c = crypto as unknown as Record<string, unknown>;
  wrapSync(c, "hkdfSync", "crypto.hkdfSync(main)");
  wrapSync(c, "randomBytes", "crypto.randomBytes(main)");
  // Sync fs calls (the worker path uses these; on the main thread they would block it).
  const s = fs as unknown as Record<string, unknown>;
  for (const n of ["openSync", "readSync", "writeSync", "fsyncSync", "closeSync", "renameSync", "fstatSync", "lstatSync"]) {
    wrapSync(s, n, `fs.${n}(main)`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Totals {
  files: number;
  bytes: number;
}
function measureTree(dir: string): Totals {
  const t: Totals = { files: 0, bytes: 0 };
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        t.files++;
        t.bytes += fs.lstatSync(f).size;
      }
    }
  };
  walk(dir);
  return t;
}

async function timed<T>(label: string, work: () => Promise<T>, totals: Totals): Promise<T> {
  prof.clear();
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  // Max block measured directly too: the longest gap between 10 ms ticks.
  let last = performance.now();
  let maxGap = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last - 10);
    last = now;
  }, 10);
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const out = await work();
  const ms = performance.now() - t0;
  const elu = performance.eventLoopUtilization(elu0);
  const cpu = process.cpuUsage(cpu0);
  clearInterval(tick);
  h.disable();
  const s = ms / 1000;
  console.log(
    JSON.stringify(
      {
        run: label,
        seconds: +s.toFixed(2),
        files: totals.files,
        MB: +(totals.bytes / 1048576).toFixed(1),
        filesPerSec: Math.round(totals.files / s),
        MBperSec: +(totals.bytes / 1048576 / s).toFixed(1),
        mainThreadBusyPct: +(elu.utilization * 100).toFixed(1),
        processCpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1),
        eventLoopDelayMaxMs: +(h.max / 1e6).toFixed(1),
        eventLoopDelayP99Ms: +(h.percentile(99) / 1e6).toFixed(1),
        maxTimerGapMs: +maxGap.toFixed(1),
      },
      null,
      0,
    ),
  );
  if (prof.size > 0) {
    const rows = [...prof.entries()].sort((a, b) => b[1].ms - a[1].ms);
    console.log("  op                              calls   per-file   summed-ms   avg-ms");
    for (const [k, v] of rows) {
      console.log(
        `  ${k.padEnd(30)} ${String(v.n).padStart(8)} ${(v.n / Math.max(1, totals.files)).toFixed(2).padStart(9)} ${v.ms.toFixed(0).padStart(11)} ${(v.ms / v.n).toFixed(3).padStart(8)}`,
      );
    }
  }
  return out;
}

async function main(): Promise<void> {
  const fixtureDir = arg("--make-fixture");
  if (fixtureDir) {
    makeFixture(path.resolve(fixtureDir), Number(arg("--files") ?? 50000), Number(arg("--big-mb") ?? 0), Number(arg("--seed") ?? 1));
    return;
  }
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && ["--delta", "--delta-mb", "--concurrency", "--workers"].includes(all[i - 1])));
  const [srcArg, workArg] = positional;
  if (!srcArg || !workArg) {
    console.error("usage: backup-seal-bench <srcDir> <workDir> [--delta N] [--profile] [--keep]\n       backup-seal-bench --make-fixture <dir> [--files N] [--big-mb N]");
    process.exit(2);
  }
  const src = path.resolve(srcArg);
  const work = path.resolve(workArg);
  if (work === src || work.startsWith(src + path.sep) || src.startsWith(work + path.sep)) {
    console.error("workDir must not be inside srcDir (or vice versa): the source is never written");
    process.exit(2);
  }
  const userData = path.join(work, `run-${Date.now()}`);
  const backups = path.join(userData, "Backups");
  const chain = path.join(backups, UDID);
  fs.mkdirSync(backups, { recursive: true });
  console.log(`copying ${src} -> ${chain} (the source is only read)`);
  const c0 = performance.now();
  fs.cpSync(src, chain, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  const totals = measureTree(chain);
  console.log(`copied ${totals.files} files, ${(totals.bytes / 1048576).toFixed(1)} MB in ${((performance.now() - c0) / 1000).toFixed(1)} s`);

  const key = crypto.randomBytes(32);
  const keyId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
  const resolver: KeyResolver = { currentKey: async () => ({ keyId, key }), keyFor: async () => key };
  const files = createFileCrypto(resolver);
  const logs: string[] = [];
  const workersArg = arg("--workers");
  let workerScript: string | undefined = process.env.KEEPR_SEAL_WORKER;
  if (!workerScript && typeof __SEAL_WORKER_SOURCE__ === "string") {
    workerScript = path.join(userData, "seal-worker.js");
    fs.writeFileSync(workerScript, __SEAL_WORKER_SOURCE__);
  }
  console.log(
    JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, workers: workersArg ?? "default" }),
  );
  const svc = new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    ensureKey: async () => undefined,
    log: (level, message, data) => logs.push(`${level} ${message} ${data ? JSON.stringify(data) : ""}`),
    ...(arg("--concurrency") ? { concurrency: Number(arg("--concurrency")) } : {}),
    workers: workersArg !== undefined ? Number(workersArg) : workerScript ? defaultSealWorkers() : 0,
    workerScript,
    sealKey: async () => ({ keyId, key }),
    ...(flag("--no-fsync") ? { sealEngineOptions: { skipDataFsyncForMeasurement: true } } : {}),
  });
  if (flag("--no-fsync")) console.log("MEASUREMENT: --no-fsync — temp data fsync skipped (the app always fsyncs)");
  let progressEvents = 0;
  svc.on("progress", () => progressEvents++);

  if (flag("--profile")) await installProfiling();

  const outcome = await timed("launch-migration (full seal + scan + marker)", () => svc.migrate(UDID), totals);
  console.log(`outcome=${outcome} progressEvents=${progressEvents}`);
  for (const l of logs) console.log(`  log: ${l}`);
  logs.length = 0;

  const deltaPct = Number(arg("--delta") ?? 0);
  // --delta-mb M: also rewrite the LARGEST files until M MB changed. Step 0b on the PC: an
  // incremental changed ~2,500 of 573,726 files but 12–20 GB, i.e. few files, large ones.
  const deltaMb = Number(arg("--delta-mb") ?? 0);
  if (deltaPct > 0 || deltaMb > 0) {
    // What an incremental leaves: a share of files rewritten/added as plaintext.
    const all: string[] = [];
    const walk = (d: string, root: boolean) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f, false);
        else if (e.isFile() && !(root && /\.plist$/.test(e.name)) && e.name !== "Manifest.db") all.push(f);
      }
    };
    walk(chain, true);
    const rnd = makeRng(7);
    const pool = crypto.randomBytes(4 * 1024 * 1024);
    let dBytes = 0;
    let dFiles = 0;
    const bySize = all.map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size);
    const chosen = new Set<string>();
    let bigBytes = 0;
    for (const { f, size } of bySize) {
      if (bigBytes >= deltaMb * 1048576) break;
      chosen.add(f);
      bigBytes += size;
    }
    for (const f of all) if (rnd() * 100 < deltaPct) chosen.add(f);
    for (const f of chosen) {
      const size = fs.statSync(f).size;
      const plainSize = Math.max(1, size - 76); // roughly its plaintext size
      const fd = fs.openSync(f, "w");
      let left = plainSize;
      while (left > 0) {
        const n = Math.min(left, pool.length);
        fs.writeSync(fd, pool, 0, n);
        left -= n;
      }
      fs.closeSync(fd);
      dBytes += plainSize;
      dFiles++;
    }
    fs.writeFileSync(path.join(chain, "Manifest.db"), pool.subarray(0, 4 * 1024 * 1024));
    dFiles++;
    dBytes += 4 * 1024 * 1024;
    // The post-sync seal (finishSync of a delta session).
    await fs.promises.mkdir(path.join(backups, ".keepr-at-rest"), { recursive: true });
    progressEvents = 0;
    await timed(
      `post-sync seal after an incremental (${dFiles} changed files, ${(dBytes / 1048576).toFixed(0)} MB)`,
      () => svc.finishSync({ kind: "keepr", udid: UDID, strategy: "delta" }),
      { files: totals.files, bytes: dBytes },
    );
    console.log(`  (files/s above = whole chain walked; MB/s = changed bytes) progressEvents=${progressEvents}`);
    for (const l of logs) console.log(`  log: ${l}`);
  }

  if (!flag("--keep")) fs.rmSync(userData, { recursive: true, force: true });
  await (svc as unknown as { shutdown?: () => Promise<void> }).shutdown?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
