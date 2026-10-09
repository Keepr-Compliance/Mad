/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S3 — migration of files saved before 2.40.
 *
 * Real KEPRENC crypto (createFileCrypto with a test key), real marker store, real
 * temp directories. Only the failure modes (a lock, a kill, a bad verify) are
 * injected, by wrapping the real FileCrypto.
 *
 *   M1  after migration no file under either scope is plaintext, each decrypts to
 *       its original bytes.
 *   M2  a run killed mid-file, then re-run: completes, no file lost, nothing
 *       encrypted twice, the orphaned temp is not counted.
 *   M3  a failed round-trip verify leaves the original byte-identical.
 *   M4  "done" is written only after a scan finds zero plaintext (not for a scope
 *       with a skipped or deferred file, not for an empty scope).
 *   M5  EBUSY is retried, then the file is skipped and recorded; the scope stays
 *       migrating; a transient EBUSY succeeds on retry.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { MAGIC, createFileCrypto, type FileCrypto, type KeyResolver } from "../fileCrypto";
import { createMarkerStore, type MarkerStore } from "../markers";
import {
  DISK_HEADROOM_BYTES,
  RETRY_ATTEMPTS,
  createAtRestMigration,
  type MigrationDeps,
} from "../migration";
import type { AtRestMigrationStatus } from "../../../types/ipc/window-api-at-rest";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");

function resolver(overrides: Partial<KeyResolver> = {}): KeyResolver {
  return {
    currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
    keyFor: async (id) => {
      if (id !== KEY_ID) throw new Error("unknown key");
      return KEY;
    },
    ...overrides,
  };
}

let root: string;
let logs: string[];
let broadcasts: AtRestMigrationStatus[];

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "keepr-s3-migration-"));
  logs = [];
  broadcasts = [];
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Writes a content-addressed plaintext file, the way the pre-2.40 writers did. */
async function seed(dir: string, bytes: Buffer, ext = ".bin"): Promise<string> {
  const full = path.join(root, dir);
  await fs.promises.mkdir(full, { recursive: true });
  const file = path.join(full, `${sha(bytes)}${ext}`);
  await fs.promises.writeFile(file, bytes);
  return file;
}

async function seedMany(dir: string, n: number): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const bytes = crypto.randomBytes(100 + i * 37);
    out.set(await seed(dir, bytes), bytes);
  }
  return out;
}

async function filesUnder(dir: string): Promise<string[]> {
  const full = path.join(root, dir);
  try {
    return (await fs.promises.readdir(full)).map((n) => path.join(full, n));
  } catch {
    return [];
  }
}

async function startsWithMagic(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    await fh.read(buf, 0, MAGIC.length, 0);
    return buf.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

function deps(
  options: Partial<Omit<MigrationDeps, "markers">> & { crypto?: FileCrypto; markers?: MarkerStore } = {},
): MigrationDeps {
  const { crypto: cryptoOverride, markers: markersOverride, ...overrides } = options;
  const files = cryptoOverride ?? createFileCrypto(resolver(), { chunkSize: 64 });
  const markers = markersOverride ?? createMarkerStore({ userData: () => root });
  return {
    files: () => files,
    markers: () => markers,
    userData: () => root,
    ensureKey: async () => undefined,
    freeBytes: async () => 10 * DISK_HEADROOM_BYTES,
    // Every seeded file is older than the run's settle cutoff unless a test says otherwise.
    now: () => Date.now() + 60_000,
    sleep: async () => undefined,
    log: (level, message) => logs.push(`${level} ${message}`),
    broadcast: (s) => broadcasts.push(s),
    setTimer: () => undefined,
    ...overrides,
  };
}

/** Wraps a real FileCrypto so encryptFileInPlace can be made to fail for chosen files. */
function wrap(
  real: FileCrypto,
  onEncrypt: (file: string, call: number) => Promise<void> | void,
): FileCrypto & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    ...real,
    calls,
    async encryptFileInPlace(file: string) {
      const n = (calls.get(file) ?? 0) + 1;
      calls.set(file, n);
      await onEncrypt(file, n);
      return real.encryptFileInPlace(file);
    },
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: resource busy or locked, rename '${root}/secret-name'`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("M1 — after migration, nothing under either scope is plaintext", () => {
  it("encrypts every file in both scopes; each decrypts to its original bytes", async () => {
    const msg = await seedMany("message-attachments", 6);
    const email = await seedMany("attachments", 4);
    const files = createFileCrypto(resolver(), { chunkSize: 64 });
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ crypto: files, markers }));

    const r1 = await m.runScope("message-attachments");
    const r2 = await m.runScope("email-attachments");
    expect([r1.outcome, r2.outcome]).toEqual(["done", "done"]);
    expect(r1.files + r2.files).toBe(10);

    for (const [file, original] of [...msg, ...email]) {
      expect(await startsWithMagic(file)).toBe(true);
      expect((await files.readAllDecrypted(file)).equals(original)).toBe(true);
    }
    for (const dir of ["message-attachments", "attachments"]) {
      for (const f of await filesUnder(dir)) expect(await startsWithMagic(f)).toBe(true);
    }
    expect((await markers.getScope("message-attachments"))?.state).toBe("done");
    expect((await markers.getScope("email-attachments"))?.state).toBe("done");
    expect(m.getStatus()).toMatchObject({ phase: "done", done: 10, total: 10, encryptedThisLaunch: 10 });
  });

  it("at-rest-state.json carries exactly the scope keys the readers look up, both done", async () => {
    await seedMany("message-attachments", 2);
    await seedMany("attachments", 2);
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ crypto: createFileCrypto(resolver(), { chunkSize: 64 }), markers }));
    await m.runScope("message-attachments");
    await m.runScope("email-attachments");
    const onDisk = JSON.parse(await fs.promises.readFile(path.join(root, "at-rest-state.json"), "utf8"));
    const states = Object.fromEntries(Object.entries(onDisk.scopes).map(([k, v]) => [k, (v as { state: string }).state]));
    expect(states).toEqual({ "message-attachments": "done", "email-attachments": "done" });
  });

  it("logs carry counts only — never a directory or file name", async () => {
    const seeded = await seedMany("message-attachments", 3);
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const first = [...seeded.keys()][0];
    const m = createAtRestMigration(
      deps({ crypto: wrap(real, (f) => { if (f === first) throw errno("EBUSY"); }) }),
    );
    await m.runScope("message-attachments");
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(root);
      for (const f of seeded.keys()) expect(line).not.toContain(path.basename(f));
    }
    expect(logs.join("\n")).toMatch(/files=2 bytes=\d+ ms=\d+ skipped=1 deferred=0/);
  });
});

describe("M2 — killed mid-file, then re-run", () => {
  it("completes on the next launch: no file lost, none encrypted twice, orphan temp ignored", async () => {
    const seeded = await seedMany("message-attachments", 5);
    const order = [...seeded.keys()];
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const markers = createMarkerStore({ userData: () => root });

    // Launch 1: the third file "kills" the process — an orphaned ciphertext temp is
    // left beside it and the call never returns.
    let killedAt: string | null = null;
    const killing = wrap(real, async (file) => {
      if (killedAt === null && [...((killing.calls as Map<string, number>).keys())].length === 3) {
        killedAt = file;
        await real.encryptStreamToFile(
          fs.createReadStream(file),
          `${file}.deadbeefcafe.kenc-tmp`,
        );
        await new Promise<never>(() => undefined);
      }
    });
    // A second kill shape: the temp was created ('wx') and nothing written yet.
    const emptyOrphan = `${order[0]}.0123456789ab.kenc-tmp`;
    await fs.promises.writeFile(emptyOrphan, Buffer.alloc(0));
    const launch1 = createAtRestMigration(deps({ crypto: killing, markers }));
    void launch1.runScope("message-attachments");
    await waitFor(() => killedAt !== null);
    // Give launch 1 a moment to have encrypted the files before the kill.
    await new Promise((r) => setTimeout(r, 50));

    const encryptedBeforeKill = (
      await Promise.all(order.map(async (f) => ((await startsWithMagic(f)) ? f : null)))
    ).filter(Boolean);
    expect(encryptedBeforeKill.length).toBeGreaterThan(0);
    expect(encryptedBeforeKill.length).toBeLessThan(order.length);
    expect((await markers.getScope("message-attachments"))?.state).toBe("migrating");

    // Launch 2: a fresh migration over the same directory.
    const launch2 = createAtRestMigration(deps({ crypto: real, markers }));
    const r = await launch2.runScope("message-attachments");
    expect(r.outcome).toBe("done");
    // Only the files launch 1 did not reach were encrypted this time.
    expect(r.files).toBe(order.length - encryptedBeforeKill.length);

    for (const [file, original] of seeded) {
      expect(fs.existsSync(file)).toBe(true);
      // Decrypting ONCE yields the original — a file encrypted twice would yield a KEPRENC blob.
      const once = await real.readAllDecrypted(file);
      expect(once.equals(original)).toBe(true);
    }
    expect((await markers.getScope("message-attachments"))?.state).toBe("done");
    // Orphaned temps are neither candidates nor counted; they are left for S6's sweep untouched.
    const killedFile = killedAt as unknown as string;
    const orphan = `${killedFile}.deadbeefcafe.kenc-tmp`;
    expect(await startsWithMagic(orphan)).toBe(true);
    expect((await real.readAllDecrypted(orphan)).equals(seeded.get(killedFile) as Buffer)).toBe(true);
    expect((await fs.promises.stat(emptyOrphan)).size).toBe(0);
    expect(r.files + encryptedBeforeKill.length).toBe(order.length);
  });
});

describe("M3 — a failed verify leaves the original intact", () => {
  it("source byte-identical, no temp left, scope not done", async () => {
    const original = crypto.randomBytes(500);
    const file = await seed("attachments", original);
    // keyFor hands back the wrong key at verify time, so the round trip fails.
    const bad = createFileCrypto(resolver({ keyFor: async () => crypto.randomBytes(32) }), { chunkSize: 64 });
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ crypto: bad, markers }));

    const r = await m.runScope("email-attachments");
    expect(r.outcome).toBe("incomplete");
    expect(r.skipped).toBe(1);
    expect((await fs.promises.readFile(file)).equals(original)).toBe(true);
    expect(await filesUnder("attachments")).toEqual([file]);
    expect((await markers.getScope("email-attachments"))?.state).toBe("migrating");
  });
});

describe("M4 — done only after a clean scan", () => {
  it("a deferred (recently written) plaintext file keeps the scope migrating", async () => {
    await seedMany("message-attachments", 2);
    const markers = createMarkerStore({ userData: () => root });
    // Real time: files written a moment ago are inside the settle window.
    const m = createAtRestMigration(deps({ markers, now: () => Date.now() }));
    const r = await m.runScope("message-attachments");
    expect(r.deferred).toBe(2);
    expect(r.outcome).toBe("incomplete");
    expect((await markers.getScope("message-attachments"))?.state).toBe("migrating");
  });

  it("a skipped file keeps the scope migrating; the next launch finishes it and writes done", async () => {
    const seeded = await seedMany("message-attachments", 3);
    const locked = [...seeded.keys()][1];
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const markers = createMarkerStore({ userData: () => root });
    const m1 = createAtRestMigration(
      deps({ crypto: wrap(real, (f) => { if (f === locked) throw errno("EPERM"); }), markers }),
    );
    expect((await m1.runScope("message-attachments")).outcome).toBe("incomplete");
    expect((await markers.getScope("message-attachments"))?.state).toBe("migrating");

    const m2 = createAtRestMigration(deps({ crypto: real, markers }));
    expect((await m2.runScope("message-attachments")).outcome).toBe("done");
    expect((await markers.getScope("message-attachments"))?.state).toBe("done");
  });

  it("a file unreadable only during the final scan keeps the scope migrating (no candidates left, still not done)", async () => {
    const seeded = await seedMany("message-attachments", 2);
    const unreadable = [...seeded.keys()][0];
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const base = wrap(real, () => undefined);
    const crypto: FileCrypto = {
      ...base,
      // Readable for the planning walk; once it has been encrypted, the verification scan cannot read it.
      async isEncrypted(file: string) {
        if (file === unreadable && (base.calls.get(file) ?? 0) > 0) throw errno("EACCES");
        return real.isEncrypted(file);
      },
    };
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ crypto, markers }));
    const r = await m.runScope("message-attachments");
    expect(r.outcome).toBe("incomplete");
    expect((await markers.getScope("message-attachments"))?.state).toBe("migrating");
  });

  it("an empty or missing scope directory writes no state at all", async () => {
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ markers }));
    expect((await m.runScope("message-attachments")).outcome).toBe("empty");
    await fs.promises.mkdir(path.join(root, "attachments"));
    expect((await m.runScope("email-attachments")).outcome).toBe("empty");
    expect(await markers.readState()).toEqual({ version: 1, scopes: {} });
    expect(m.getStatus().phase).toBe("idle");
  });

  it("an unavailable data key writes no state and touches no file", async () => {
    const original = crypto.randomBytes(200);
    const file = await seed("message-attachments", original);
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(
      deps({ markers, ensureKey: async () => { throw new Error("DataKeyUnavailableError"); } }),
    );
    expect((await m.runScope("message-attachments")).outcome).toBe("key-unavailable");
    expect((await fs.promises.readFile(file)).equals(original)).toBe(true);
    expect(await markers.readState()).toEqual({ version: 1, scopes: {} });
  });
});

describe("M5 — files in use", () => {
  it("EBUSY every time: retried RETRY_ATTEMPTS times, skipped, recorded, scope stays migrating", async () => {
    const seeded = await seedMany("message-attachments", 4);
    const locked = [...seeded.keys()][2];
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const markers = createMarkerStore({ userData: () => root });
    const wrapped = wrap(real, (f) => { if (f === locked) throw errno("EBUSY"); });
    const m = createAtRestMigration(deps({ crypto: wrapped, markers }));

    const r = await m.runScope("message-attachments");
    expect(wrapped.calls.get(locked)).toBe(RETRY_ATTEMPTS);
    expect(r.skipped).toBe(1);
    expect(r.files).toBe(3);
    expect(await startsWithMagic(locked)).toBe(false);
    expect((await fs.promises.readFile(locked)).equals(seeded.get(locked) as Buffer)).toBe(true);
    expect((await markers.getScope("message-attachments"))?.state).toBe("migrating");
    await m.runScope("email-attachments");
    expect(m.getStatus()).toMatchObject({ phase: "paused", pauseReason: "files-in-use" });
    expect(logs.some((l) => l.includes("skipped a file (EBUSY)"))).toBe(true);
  });

  it("EBUSY once, then free: the retry encrypts it", async () => {
    const seeded = await seedMany("attachments", 2);
    const flaky = [...seeded.keys()][0];
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const wrapped = wrap(real, (f, n) => { if (f === flaky && n === 1) throw errno("EBUSY"); });
    const m = createAtRestMigration(deps({ crypto: wrapped }));
    const r = await m.runScope("email-attachments");
    expect(r).toMatchObject({ outcome: "done", files: 2, skipped: 0 });
    expect(wrapped.calls.get(flaky)).toBe(2);
  });
});

describe("disk space", () => {
  it("pauses before touching anything when free space < largest file + 1 GB, resumes on recheck", async () => {
    const seeded = await seedMany("message-attachments", 3);
    let free = DISK_HEADROOM_BYTES; // below largest + headroom
    let timer: (() => void) | null = null;
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(
      deps({ markers, freeBytes: async () => free, setTimer: (fn) => { timer = fn; } }),
    );
    const r = await m.runScope("message-attachments");
    expect(r.outcome).toBe("paused-disk");
    for (const f of seeded.keys()) expect(await startsWithMagic(f)).toBe(false);
    expect(m.getStatus()).toMatchObject({ phase: "paused", pauseReason: "disk-space", total: 3 });
    expect(timer).not.toBeNull();

    free = 10 * DISK_HEADROOM_BYTES;
    (timer as unknown as () => void)();
    await waitFor(() => logs.some((l) => l.includes("migration message-attachments: outcome=done")));
    await m.runScope("email-attachments");
    expect(m.getStatus().phase).toBe("done");
    for (const f of seeded.keys()) expect(await startsWithMagic(f)).toBe(true);
    expect(m.getStatus()).toMatchObject({ done: 3, total: 3 });
  });
});

describe("status", () => {
  it("broadcasts running with counts, then done; minutes left appears once there is a rate", async () => {
    await seedMany("message-attachments", 3);
    const m = createAtRestMigration(deps());
    await m.runScope("message-attachments");
    // The first scope finishing is not "done" while the second has not run (no flash of the done copy).
    expect(broadcasts.some((s) => s.phase === "done")).toBe(false);
    expect(m.getStatus().phase).toBe("running");
    await m.runScope("email-attachments");
    expect(broadcasts.some((s) => s.phase === "running" && s.total === 3)).toBe(true);
    const last = broadcasts[broadcasts.length - 1];
    expect(last).toMatchObject({ phase: "done", done: 3, total: 3, minutesLeft: 0 });
  });

  it("files already encrypted at start: no work, phase stays idle (no banner)", async () => {
    const real = createFileCrypto(resolver(), { chunkSize: 64 });
    const file = await seed("message-attachments", crypto.randomBytes(80));
    await real.encryptFileInPlace(file);
    const markers = createMarkerStore({ userData: () => root });
    const m = createAtRestMigration(deps({ crypto: real, markers }));
    expect((await m.runScope("message-attachments")).outcome).toBe("done");
    expect(m.getStatus()).toMatchObject({ phase: "idle", total: 0, encryptedThisLaunch: 0 });
    expect((await markers.getScope("message-attachments"))?.state).toBe("done");
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
