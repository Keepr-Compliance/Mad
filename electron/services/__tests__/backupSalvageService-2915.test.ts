/**
 * BACKLOG-2915 (round 4, absorbing BACKLOG-3035) — CONTROLS FOR THE SALVAGE JUDGEMENT.
 *
 * These run against REAL SQLite databases in a real temp directory, because the thing
 * being judged is a real SQLite database in a real directory. A mocked `Manifest.db`
 * would be a fixture describing a state the producer cannot emit — and the first
 * measurement of the founder's backup was wrong for exactly that class of reason.
 *
 * ## Run them with
 *
 *     ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *       electron/services/__tests__/backupSalvageService-2915.test.ts --bail=0
 *
 * Plain `npx jest` cannot load the native module: the shared binary is built for the
 * Electron ABI, and rebuilding it would break the founder's running dev app.
 *
 * ## The measurement rule
 *
 * **Coverage is asserted by IDENTITY of the missing set, never by a count or a ratio.**
 * A ratio cannot tell fourteen irrelevant files from fourteen carrying the messages —
 * which is the entire question. The counts below are checked too, but only alongside the
 * identities that produced them.
 *
 * The real numbers this is modelled on, from the founder's discarded 61.9 GB backup:
 * 506,993 claimed, 506,979 present, 14 missing, `quick_check` ok, `SnapshotState`
 * finished, and BOTH files the sync reads present.
 */

import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * THE REAL DRIVER, ON PURPOSE.
 *
 * `jest.config.js` maps `better-sqlite3-multiple-ciphers` to a stub for every suite, so
 * without this both the fixture builder AND `judgeFailedBackup` would run against a fake
 * that answers `undefined` to `pragma("quick_check")` — and every row here would fail for
 * a reason that has nothing to do with the code under test. (It did, on the first run:
 * "Manifest.db failed its integrity check ()".)
 *
 * The absolute path is what escapes the mapper; it is the same escape
 * `messageImportStateService.test.ts` uses. The production code keeps its ordinary
 * `require`, so nothing about the module under test is bent to suit the test.
 */
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "better-sqlite3-multiple-ciphers",
    ),
  ),
);

jest.mock("electron-log", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  judgeFailedBackup,
  describeSalvagedBackup,
  REQUIRED_BACKUP_FILE_IDS,
  MIN_BLOB_COVERAGE,
} from "../backupSalvageService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3-multiple-ciphers");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const simplePlist = require("simple-plist");

const SMS_ID = REQUIRED_BACKUP_FILE_IDS[0].id;
const ADDRESSBOOK_ID = REQUIRED_BACKUP_FILE_IDS[1].id;

/** A synthetic fileID with the shape iOS uses: 40 lowercase hex characters. */
function fileId(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/**
 * Builds a backup directory the way `idevicebackup2` lays one out: a `Manifest.db` whose
 * `Files` table claims a set of fileIDs, and blobs sharded into two-hex directories.
 *
 * `omit` is the set that is claimed but NOT written — the missing set, chosen by
 * identity so every assertion can name it.
 */
async function makeBackup(opts: {
  claimed: string[];
  omit?: string[];
  snapshotState?: string | null;
  corruptManifest?: boolean;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "salvage-2915-"));
  const omit = new Set(opts.omit ?? []);

  const db = new Database(path.join(dir, "Manifest.db"));
  db.exec(
    "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)",
  );
  const insert = db.prepare(
    "INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)",
  );
  const insertMany = db.transaction((ids: string[]) => {
    for (const id of ids) insert.run(id, "HomeDomain", `Library/${id}`, 1, null);
    // A directory row: `flags = 2`, and it has no blob. Real manifests are full of
    // these, and counting them as missing files is a way to invent a failure.
    // A fixed id outside the numeric range `fileId()` generates, so it can never
    // collide with a claimed file. (It did on the first run: `fileId(0xd1)` is 209.)
    insert.run("d".repeat(40), "HomeDomain", "Library", 2, null);
  });
  insertMany(opts.claimed);
  db.close();

  if (opts.corruptManifest) {
    const p = path.join(dir, "Manifest.db");
    const buf = await fs.readFile(p);
    // Scribble over the middle of the file, past the header, so it opens and then fails
    // its integrity check rather than failing to open at all.
    buf.fill(0x41, Math.floor(buf.length / 2), Math.floor(buf.length / 2) + 512);
    await fs.writeFile(p, buf);
  }

  for (const id of opts.claimed) {
    if (omit.has(id)) continue;
    const shard = path.join(dir, id.slice(0, 2));
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(path.join(shard, id), "blob");
  }

  const state = opts.snapshotState === undefined ? "finished" : opts.snapshotState;
  if (state !== null) {
    simplePlist.writeFileSync(path.join(dir, "Status.plist"), {
      SnapshotState: state,
      IsFullBackup: false,
    });
  }
  return dir;
}

const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function build(opts: Parameters<typeof makeBackup>[0]): Promise<string> {
  const dir = await makeBackup(opts);
  cleanup.push(dir);
  return dir;
}

/** The founder's shape: a large backup, a handful missing, both required files present. */
function founderShape(missingCount: number) {
  const claimed = [SMS_ID, ADDRESSBOOK_ID];
  for (let i = 1; i <= 20_000; i += 1) claimed.push(fileId(i));
  const omit = claimed.slice(2, 2 + missingCount);
  return { claimed, omit };
}

describe("BACKLOG-2915 rows 37-42 — judging a failed backup before discarding it", () => {
  it("ROW 37 — a complete backup has an EMPTY missing set", async () => {
    // The boundary's other end. Asserted as the empty SET, not as `missingCount === 0`,
    // so the same assertion shape carries through every row below.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(true);
    if (!verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage.missingFileIds).toEqual([]);
    expect(verdict.coverage.missingRequired).toEqual([]);
    expect(verdict.coverage.manifestFiles).toBe(claimed.length);
    expect(verdict.coverage.blobsPresent).toBe(claimed.length);
  });

  it("ROW 38 — ONE file short is salvageable, and the missing file is named by identity", async () => {
    // The founder's case in miniature. `missingCount` alone would not distinguish this
    // from ROW 40, where one file is also missing and the answer is the opposite.
    const { claimed, omit } = founderShape(1);
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(true);
    if (!verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage.missingFileIds).toEqual(omit);
    expect(verdict.coverage.missingRequired).toEqual([]);
    expect(verdict.coverage.blobsPresent).toBe(claimed.length - 1);
  });

  it("ROW 39 — the founder's actual shape: 14 short of a large backup, and it is kept", async () => {
    // Modelled on the real measurement — 506,993 claimed, 14 missing, 0.003%. The
    // proportion is what matters here, not the absolute size, so the fixture is 20,002
    // files rather than half a million.
    const { claimed, omit } = founderShape(14);
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(true);
    if (!verdict.salvageable) throw new Error("unreachable");
    // IDENTITY, and the whole set of it.
    expect(new Set(verdict.coverage.missingFileIds)).toEqual(new Set(omit));
    expect(verdict.coverage.missingCount).toBe(14);
    expect(describeSalvagedBackup(verdict.coverage)).toContain("14 files");
  });

  it("ROW 40 — THE ROW A RATIO CANNOT SEE: one file short, and it is the messages database", async () => {
    // Same missingCount as ROW 38. Same ratio. Opposite answer — because the question is
    // WHICH file, and a ratio cannot ask it. This is why the gate is identity-based and
    // why the coverage floor is only belt-and-braces.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, omit: [SMS_ID] });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toContain("messages");
    expect(verdict.coverage?.missingRequired).toEqual(["messages"]);
    expect(verdict.coverage?.missingFileIds).toEqual([SMS_ID]);
  });

  it("ROW 40b — and the same for the contacts database", async () => {
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, omit: [ADDRESSBOOK_ID] });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage?.missingRequired).toEqual(["contacts"]);
  });

  it("ROW 41 — a grossly incomplete backup fails, even with both required files present", async () => {
    // The belt-and-braces floor doing its job: the two files the sync reads are both
    // here, and the directory is still not a backup.
    const { claimed } = founderShape(0);
    const omit = claimed.slice(2, 2 + 5_000); // a quarter of it gone
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage?.missingRequired).toEqual([]);
    expect(verdict.reason).toMatch(/were transferred/);
    // The floor is the thing that rejected it, not the required-file check.
    const ratio =
      (verdict.coverage!.blobsPresent) / verdict.coverage!.manifestFiles;
    expect(ratio).toBeLessThan(MIN_BLOB_COVERAGE);
  });

  it("ROW 41b — THE FLOOR IS 0.999 SPECIFICALLY, not merely 'some floor'", async () => {
    // ROW 41 removes a quarter of the backup, which fails 0.999 AND 0.99 — so it pins
    // that a floor exists and nothing about WHERE it is. The founder chose 0.999 over
    // 0.99 on 2026-08-31, and a choice nothing can detect being changed is not pinned.
    //
    // 100 missing of 20,002 is 0.995 present: BELOW 0.999, ABOVE 0.99. Loosening the
    // constant to 0.99 turns this row green-to-red in the only direction that matters.
    // Both required files are present, so the identity check has nothing to say and the
    // floor is unambiguously what decides it.
    const { claimed } = founderShape(0);
    const omit = claimed.slice(2, 102);
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage?.missingRequired).toEqual([]);
    const ratio = verdict.coverage!.blobsPresent / verdict.coverage!.manifestFiles;
    // The band this row occupies, stated so a later reader can see why 100 and not 5,000.
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(0.999);
    expect(MIN_BLOB_COVERAGE).toBe(0.999);
  });

  it("ROW 42 — the device saying the snapshot did NOT finish outranks everything", async () => {
    // A complete-looking directory whose own `Status.plist` says it was still uploading.
    // BACKLOG-2911 established this reading; nothing measured afterwards may overrule it.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, snapshotState: "uploading" });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toContain("uploading");
    // It short-circuits: no coverage was computed, because none of it could matter.
    expect(verdict.coverage).toBeUndefined();
  });

  it("ROW 42b — an unreadable Status.plist fails closed", async () => {
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, snapshotState: null });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toContain("unreadable");
  });

  it("ROW 43 — a corrupt Manifest.db fails its integrity check", async () => {
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, corruptManifest: true });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/integrity check|could not be examined/);
  });

  it("ROW 44 — directory rows are not counted as missing files", async () => {
    // `makeBackup` writes a `flags = 2` row with no blob, as every real manifest does.
    // Counting those as missing would manufacture a failure out of a healthy backup —
    // the same class of artefact as the 23% sample.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(true);
    if (!verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage.manifestFiles).toBe(claimed.length);
    expect(verdict.coverage.missingFileIds).toEqual([]);
  });
});
