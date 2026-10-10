/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 — founder decision 2026-10-10: after a NORMAL successful C-DELTA sync of a
 * chain proven fully sealed, seal only what the sync wrote (files with an mtime at or after
 * the unseal time, plus the index files) and skip the verification walk over the rest.
 * Every abnormal end still walks.
 *
 * Real fileCrypto and real files in a temp Backups root. The discriminator throughout is a
 * PLANTED plaintext file with an OLD mtime, outside the delta: only the full walk reaches
 * it. Left plaintext = the walk was skipped; sealed = the walk ran. (The backup tool cannot
 * produce such a file — see sealDeltaOnly — it exists here only to observe the walk.)
 */
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import plist from "simple-plist";

import { BackupAtRest, type BackupAtRestProgress } from "../backupAtRest";
import { createFileCrypto, MAGIC, type KeyResolver } from "../fileCrypto";
import { createMarkerStore } from "../markers";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async () => KEY,
};
const files = createFileCrypto(resolver, { chunkSize: 64 });

const UDID = "00008110-000A1B2C3D4E5F60";
const VERSION = "2.40.0";

let userData: string;
let backups: string;
let chain: string;

type Logged = { level: string; message: string; data?: Record<string, unknown> };

function service(overrides: Partial<ConstructorParameters<typeof BackupAtRest>[0]> = {}, logged: Logged[] = []): BackupAtRest {
  return new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    ensureKey: async () => undefined,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    sleep: async () => undefined,
    log: (level, message, data) => logged.push({ level, message, data }),
    concurrency: 4,
    chunkSize: 64,
    appVersion: () => VERSION,
    ...overrides,
  });
}

const markers = () => createMarkerStore({ userData: () => userData });

function write(rel: string, data: Buffer | string): string {
  const p = path.join(chain, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function isSealed(file: string): boolean {
  return fs.readFileSync(file).subarray(0, MAGIC.length).equals(Buffer.from(MAGIC));
}

function allFiles(dir = chain): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(f);
    }
  };
  walk(dir);
  return out;
}

function plaintextLeft(): string[] {
  return allFiles().filter((f) => fs.statSync(f).size > 0 && !isSealed(f));
}

function age(paths: string[], hours = 2): void {
  const old = new Date(Date.now() - hours * 3600_000);
  for (const f of paths) fs.utimesSync(f, old, old);
}

/** Root plists + Manifest.db + 60 content files, as idevicebackup2 lays a chain out. */
function makeChain(): void {
  fs.mkdirSync(chain, { recursive: true });
  write("Info.plist", plist.stringify({ "Device Name": "Test" }));
  write("Status.plist", plist.stringify({ SnapshotState: "finished", IsFullBackup: false }));
  write("Manifest.plist", plist.stringify({ IsEncrypted: false }));
  write("Manifest.db", "SQLite format 3\0" + "index rows ".repeat(40));
  for (let i = 0; i < 60; i++) {
    write(`${String(i % 20).padStart(2, "0")}/${"a".repeat(30)}${String(i).padStart(10, "0")}`, crypto.randomBytes(150));
  }
}

/**
 * A chain PROVEN sealed by a full walk under this version (marker `encrypted` +
 * verifiedBy), every file aged, plus the planted old-mtime plaintext file.
 */
async function provenChain(s: BackupAtRest): Promise<string> {
  makeChain();
  expect(await s.migrate(UDID)).toBe("encrypted");
  expect((await markers().readBackupMarker(UDID))?.verifiedBy).toBe(VERSION);
  const planted = write(`7f/${"7".repeat(40)}`, "plaintext with an old mtime: only the walk reaches it");
  age(allFiles());
  return planted;
}

const NEW_FILE = `ee/${"e".repeat(40)}`;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-skipwalk-"));
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("normal sync: the verification walk is skipped", () => {
  it("seals this sync's file and the index, writes `encrypted` + verifiedBy at once, leaves the planted old file alone (no walk); banner and quit prompt off", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    const session = await s.beginSync(UDID, { strategy: "delta" });
    const fresh = write(NEW_FILE, crypto.randomBytes(400));
    const ticks: BackupAtRestProgress[] = [];
    await s.finishSync(session, (p) => ticks.push(p), { toolOk: true, cleanEnd: true });

    expect(isSealed(fresh)).toBe(true);
    for (const name of ["Manifest.db", "Info.plist", "Status.plist", "Manifest.plist"]) {
      expect(isSealed(path.join(chain, name))).toBe(true);
    }
    expect(isSealed(planted)).toBe(false); // the walk did not run
    expect(plaintextLeft()).toEqual([planted]);
    const marker = await markers().readBackupMarker(UDID);
    expect(marker).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
    const sealedLine = logged.filter((l) => l.message === "[BackupAtRest] sealed").pop();
    expect(sealedLine?.data).toMatchObject({ mode: "delta", files: expect.any(Number), failed: 0 });
    expect(sealedLine?.data?.files as number).toBeLessThan(10); // the delta, not the 65-file chain
    expect(logged.some((l) => l.message.includes("checking the whole backup"))).toBe(false);
    // Banner: the last tick is not sealing; quit prompt: no percent, nothing left for the quit seal.
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1].sealing).toBe(false);
    expect(s.sealPassPercent()).toBeNull();
    expect(s.sealIndexForQuit()).toBeNull();
  });

  it("the next normal sync skips again (verifiedBy survives a clean delta seal)", async () => {
    const s = service();
    const planted = await provenChain(s);
    for (let round = 0; round < 2; round++) {
      const session = await s.beginSync(UDID, { strategy: "delta" });
      write(`e${round}/${"e".repeat(40)}`, crypto.randomBytes(100));
      await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
      age(allFiles());
    }
    expect(isSealed(planted)).toBe(false);
    expect(await markers().readBackupMarker(UDID)).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
  });

  it("the backup tool renames files during the sync (MoveItems keeps the source's mtime): an unsealed index file moved to a content name is in the delta and sealed; a sealed file moved keeps its old mtime and stays ciphertext", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    makeChain();
    expect(await s.migrate(UDID)).toBe("encrypted");
    age(allFiles());
    const oldSealed = allFiles().find((f) => path.dirname(f) !== chain) as string;
    const session = await s.beginSync(UDID, { strategy: "delta" });
    // The unseal rewrote the index files: fresh mtime, plaintext.
    expect(isSealed(path.join(chain, "Status.plist"))).toBe(false);
    const movedIndex = path.join(chain, "cc", "c".repeat(40));
    fs.mkdirSync(path.dirname(movedIndex), { recursive: true });
    fs.renameSync(path.join(chain, "Status.plist"), movedIndex);
    const movedSealed = path.join(chain, "dd", "d".repeat(40));
    fs.mkdirSync(path.dirname(movedSealed), { recursive: true });
    const oldMtime = fs.statSync(oldSealed).mtimeMs;
    fs.renameSync(oldSealed, movedSealed);
    expect(fs.statSync(movedSealed).mtimeMs).toBe(oldMtime); // rename keeps the mtime
    write("Status.plist", plist.stringify({ SnapshotState: "finished" })); // the tool writes a new one
    await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    expect(logged.filter((l) => l.message === "[BackupAtRest] sealed").pop()?.data).toMatchObject({ mode: "delta" });
    expect(isSealed(movedIndex)).toBe(true);
    expect(isSealed(movedSealed)).toBe(true);
    expect(plaintextLeft()).toEqual([]);
    expect(await markers().readBackupMarker(UDID)).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
  });
});

describe("every abnormal condition still walks (the planted old file gets sealed)", () => {
  async function expectWalk(
    s: BackupAtRest,
    planted: string,
    logged: Logged[],
    end: (session: Awaited<ReturnType<BackupAtRest["beginSync"]>>) => Promise<void>,
    beginOpts: Parameters<BackupAtRest["beginSync"]>[1] = { strategy: "delta" },
  ): Promise<void> {
    const session = await s.beginSync(UDID, beginOpts);
    write(NEW_FILE, crypto.randomBytes(200));
    await end(session);
    expect(isSealed(planted)).toBe(true);
    expect(logged.some((l) => l.message === "[BackupAtRest] sealed" && l.data?.mode === "delta")).toBe(false);
  }

  it("unplug / error / cancel end (finishSync from the orchestrator's finally: no cleanEnd)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true }));
    expect(await markers().readBackupMarker(UDID)).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
  });

  it("a tool failure end (forceFullNext) even if cleanEnd were passed", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, (session) =>
      s.finishSync(session, undefined, { forceFullNext: "DELTA_TOOL_FAILED", cleanEnd: true }),
    );
  });

  it("first sync after an update: the marker was verified by another version", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await markers().writeBackupMarker(UDID, "encrypted", { verifiedBy: "2.39.0" });
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
    expect((await markers().readBackupMarker(UDID))?.verifiedBy).toBe(VERSION); // proven again by this version
  });

  it("first sync after updating from a build that wrote no verifiedBy (marker `encrypted` from the 2.40 betas)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await markers().writeBackupMarker(UDID, "encrypted");
    expect((await markers().readBackupMarker(UDID))?.verifiedBy).toBeUndefined();
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
  });

  it("a pending tool failure on the marker (toolFailures)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await markers().setToolFailures(UDID, 1);
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
  });

  it("a forced C-FULL sync (marker nextStrategy)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await markers().setNextStrategy(UDID, "DELTA_DAMAGED");
    await expectWalk(
      s,
      planted,
      logged,
      async (session) => {
        expect(session).toMatchObject({ kind: "keepr", strategy: "full" });
        await s.finishSync(session, undefined, { toolOk: true, succeeded: true });
      },
      {},
    );
  });

  it("a C-FULL sync even with cleanEnd", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }), { strategy: "full" });
  });

  it("the chain was not fully sealed when the sync started (marker `sealing`: a cut-off seal or a quit)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await markers().writeBackupMarker(UDID, "sealing");
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
  });

  it("crash during the sync: the relaunch (a new process) recovers with the full walk", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await s.beginSync(UDID, { strategy: "delta" });
    write(NEW_FILE, crypto.randomBytes(200));
    expect(await s.readMarker(UDID)).toBe("syncing");
    const relaunched = service({}, logged);
    expect(await relaunched.migrate(UDID)).toBe("encrypted");
    expect(isSealed(planted)).toBe(true);
    expect(plaintextLeft()).toEqual([]);
  });

  it("an index file could not be sealed", async () => {
    const logged: Logged[] = [];
    let armed = false;
    const s = service(
      {
        sealEngineOptions: {
          retryDelayMs: 0,
          beforeSeal: (p) => {
            if (armed && path.basename(p) === "Manifest.db") throw Object.assign(new Error("locked"), { code: "EBUSY" });
          },
        },
      },
      logged,
    );
    const planted = await provenChain(s);
    armed = true;
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
    expect(logged.some((l) => l.data?.reasonCode === "INDEX_SEAL_FAILED")).toBe(true);
    expect(await s.readMarker(UDID)).toBe("sealing"); // never `encrypted` with Manifest.db plaintext
  });

  it("one of this sync's files could not be sealed", async () => {
    const logged: Logged[] = [];
    let failures = 0;
    const s = service(
      {
        sealEngineOptions: {
          retryDelayMs: 0,
          beforeSeal: (p) => {
            if (p.endsWith(NEW_FILE.split("/")[1]) && failures++ < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
          },
        },
      },
      logged,
    );
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, (session) => s.finishSync(session, undefined, { toolOk: true, cleanEnd: true }));
    expect(logged.some((l) => l.data?.reasonCode === "DELTA_SEAL_FAILED")).toBe(true);
    expect(plaintextLeft()).toEqual([]); // the walk sealed it on its own try
    expect(await markers().readBackupMarker(UDID)).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
  });

  it("a damaged file in this sync's delta", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, async (session) => {
      write(`dd/${"d".repeat(40)}`, Buffer.concat([MAGIC, Buffer.from("not a valid header")]));
      await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    });
    expect(logged.some((l) => l.data?.reasonCode === "DELTA_DAMAGED")).toBe(true);
  });

  it("the wall clock was set back during the sync (new files could carry an mtime before the unseal time)", async () => {
    const logged: Logged[] = [];
    let mono = 0;
    const s = service({ monotonicNow: () => mono }, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, async (session) => {
      mono += 60 * 60_000; // an hour passed on the monotonic clock; the wall clock says seconds
      await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    });
    expect(logged.some((l) => l.data?.reasonCode === "CLOCK_CHANGED")).toBe(true);
  });

  it("an index file carries an mtime older than the unseal (the mtime basis is not trustworthy)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, async (session) => {
      age([path.join(chain, "Status.plist")]);
      await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    });
    expect(logged.some((l) => l.data?.reasonCode === "INDEX_MTIME_OLD")).toBe(true);
  });

  it("Manifest.db is gone after the sync: no delta seal; the full path removes the marker (unindexed)", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    await expectWalk(s, planted, logged, async (session) => {
      fs.rmSync(path.join(chain, "Manifest.db"));
      await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    });
    expect(logged.some((l) => l.data?.reasonCode === "NO_INDEX")).toBe(true);
    expect(await s.readMarker(UDID)).toBe("absent");
  });

  it("a quit during the delta seal: the seal pauses, the marker stays `sealing`, the next launch walks", async () => {
    const logged: Logged[] = [];
    const s = service({}, logged);
    const planted = await provenChain(s);
    const session = await s.beginSync(UDID, { strategy: "delta" });
    write(NEW_FILE, crypto.randomBytes(200));
    // The quit's pause lands as the delta pass starts listing.
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    let quit: Promise<void> | null = null;
    jest.spyOn(fs.promises, "readdir").mockImplementation(((...args: Parameters<typeof fs.promises.readdir>) => {
      if (!quit && args[0] === chain) quit = s.sealIndexForQuit(5_000) ?? Promise.resolve();
      return (realReaddir as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof fs.promises.readdir);
    await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });
    await quit;
    jest.restoreAllMocks();
    expect(quit).not.toBeNull();
    expect(await s.readMarker(UDID)).toBe("sealing");
    expect(await service({}, logged).migrate(UDID)).toBe("encrypted");
    expect(isSealed(planted)).toBe(true);
  });
});

describe("marker: verifiedBy is written only with `encrypted` and never carried across another state", () => {
  it("syncing drops it; a later `encrypted` without proof has none", async () => {
    fs.mkdirSync(chain, { recursive: true });
    const m = markers();
    await m.writeBackupMarker(UDID, "encrypted", { verifiedBy: VERSION });
    expect((await m.readBackupMarker(UDID))?.verifiedBy).toBe(VERSION);
    await m.writeBackupMarker(UDID, "syncing", { verifiedBy: VERSION });
    expect((await m.readBackupMarker(UDID))?.verifiedBy).toBeUndefined();
    await m.writeBackupMarker(UDID, "encrypted");
    expect((await m.readBackupMarker(UDID))?.verifiedBy).toBeUndefined();
  });
});
