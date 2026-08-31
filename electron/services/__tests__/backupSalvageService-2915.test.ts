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

  // BACKLOG-2915 (round 5): built CONCURRENTLY, and the shard directories once each.
  //
  // This loop used to be one serial `await fs.mkdir` + `await fs.writeFile` per file
  // across 20,002 files per row, eleven rows — on the order of 220,000 tiny creates and
  // deletes per suite run. On macOS that is 2-3 s a row; on Windows, where per-file
  // create/close on NTFS with a scanner in the path is roughly an order of magnitude
  // slower, it put every row near or past jest's 30 s limit. **CI went red on
  // windows-latest**: ROW 40, ROW 40b and the `afterAll` hook all timed out, and the
  // margin was effectively zero for all eleven rows rather than just the three that
  // failed.
  //
  // The suite only ever ran under the Electron-ABI runner, which nobody runs on Windows
  // — so the platform where it breaks is the one that was never exercised.
  const wanted = opts.claimed.filter((id) => !omit.has(id));
  const shards = new Set(wanted.map((id) => id.slice(0, 2)));
  await Promise.all(
    [...shards].map((shard) =>
      fs.mkdir(path.join(dir, shard), { recursive: true }),
    ),
  );
  // Batched rather than one giant Promise.all: a few thousand simultaneous open file
  // handles is its own way to be slow, and on Windows a way to hit EMFILE.
  const BATCH = 256;
  for (let i = 0; i < wanted.length; i += BATCH) {
    await Promise.all(
      wanted
        .slice(i, i + BATCH)
        .map((id) => fs.writeFile(path.join(dir, id.slice(0, 2), id), "blob")),
    );
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

/**
 * BACKLOG-2915 (round 5): belt-and-braces AFTER the corpus shrink and the concurrent
 * build, not instead of them. The Windows failure was a real cost problem; a bigger
 * timeout alone would have hidden it rather than fixed it.
 */
jest.setTimeout(60_000);

const cleanup: string[] = [];
afterAll(async () => {
  // Concurrent, and with its own timeout: this hook was one of the three Windows
  // timeouts, because it recursively deleted eleven directories serially.
  await Promise.all(
    cleanup.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
}, 60_000);

async function build(opts: Parameters<typeof makeBackup>[0]): Promise<string> {
  const dir = await makeBackup(opts);
  cleanup.push(dir);
  return dir;
}

/**
 * The founder's shape: a large-ish backup, a handful missing, both required files present.
 *
 * **2,002 files, not 20,002 — shrunk in round 5 to unblock Windows CI.** None of the
 * arguments below needs twenty thousand: what they need is a corpus big enough that
 * ROW 41b lands strictly between 0.99 and 0.999, and 2,002 with 10 missing is 0.995,
 * the same band with the same discrimination. See `makeBackup` for the measurement.
 *
 * The founder's real numbers (506,993 claimed, 14 missing) are a PROPORTION being
 * modelled, not a size to reproduce — reproducing the size is what broke CI.
 */
function founderShape(missingCount: number, total = 2_000) {
  const claimed = [SMS_ID, ADDRESSBOOK_ID];
  for (let i = 1; i <= total; i += 1) claimed.push(fileId(i));
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

  it("ROW 39 — the founder's shape: SEVERAL files short of a sound backup, and it is kept", async () => {
    // THE PROPORTION IS THE FIXTURE, NOT THE COUNT — and round 5 proved it by getting
    // this wrong. This row carried 14 missing to match the founder's real measurement
    // (506,993 claimed, 14 missing, 0.003% gone). When the corpus was shrunk from 20,002
    // to 2,002 to unblock Windows CI, keeping the 14 turned it into 0.7% gone —
    // **250x worse than the case being modelled** — and the row went red against the
    // coverage floor. That red is the fixture-invalidation rule doing its job: a changed
    // fixture invalidates its control, and the control said so.
    //
    // 3 missing of 5,002 is 0.9994 present: a multi-file miss (so it is not a duplicate
    // of ROW 38's single-file case, and `describeSalvagedBackup` has to pluralise) with
    // real margin above the 0.999 floor. The margin is asserted below rather than
    // computed and trusted.
    const { claimed, omit } = founderShape(3, 5_000);
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(true);
    if (!verdict.salvageable) throw new Error("unreachable");
    // IDENTITY, and the whole set of it.
    expect(new Set(verdict.coverage.missingFileIds)).toEqual(new Set(omit));
    expect(verdict.coverage.missingCount).toBe(3);
    expect(describeSalvagedBackup(verdict.coverage)).toContain("3 files");
    // …and it clears the floor by a real margin, not by a rounding accident.
    const ratio = verdict.coverage.blobsPresent / verdict.coverage.manifestFiles;
    expect(ratio).toBeGreaterThan(MIN_BLOB_COVERAGE);
    expect(ratio).toBeGreaterThan(0.9993);
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
    const omit = claimed.slice(2, 2 + 500); // a quarter of it gone
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
    // 10 missing of 2,002 is 0.995 present: BELOW 0.999, ABOVE 0.99. Loosening the
    // constant to 0.99 turns this row green-to-red in the only direction that matters.
    // Both required files are present, so the identity check has nothing to say and the
    // floor is unambiguously what decides it.
    //
    // Round 5 rescaled this from 100-of-20,002 with the corpus. The BAND is what the row
    // asserts, and the assertions below check the band rather than trusting the
    // arithmetic — a rescaled fixture whose ratio silently left the band would be a
    // control that no longer controls anything.
    const { claimed } = founderShape(0);
    const omit = claimed.slice(2, 12);
    const dir = await build({ claimed, omit });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.coverage?.missingRequired).toEqual([]);
    const ratio = verdict.coverage!.blobsPresent / verdict.coverage!.manifestFiles;
    // The band this row occupies, asserted rather than computed and trusted. A rescale
    // that silently moved the ratio out of the band would leave a control that no longer
    // controls anything — which is exactly what happened to ROW 39 in round 5.
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

  it("ROW 43 — a corrupt Manifest.db fails its INTEGRITY CHECK specifically", async () => {
    // THE ASSERTION USED TO BE AN OR — `/integrity check|could not be examined/` — and
    // that is why deleting the `quick_check` gate left this row green in round 5. With
    // the gate gone the code walks on to `SELECT fileID FROM Files`, which throws on a
    // corrupt b-tree and lands in the catch-all; the OR accepted that too. A control
    // that accepts both branches cannot tell which one fired.
    //
    // Verified by probe on this exact fixture: the DB OPENS and `quick_check` returns
    // `*** in database main *** Tree 2 page 34: btreeInitPage() returns error code 11`.
    // So the integrity branch is genuinely reachable and is what must answer here.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed, corruptManifest: true });

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/integrity check/);
    expect(verdict.reason).not.toMatch(/could not be examined/);
  });

  it("ROW 43b — a Manifest.db that will not open at all is reported as unexaminable", async () => {
    // The other branch, pinned separately so ROW 43 above can be exact. Without this the
    // catch-all would have no control of its own.
    const { claimed } = founderShape(0);
    const dir = await build({ claimed });
    // Truncate the header: SQLite cannot open this at all.
    await fs.writeFile(path.join(dir, "Manifest.db"), "not a database");

    const verdict = await judgeFailedBackup(dir);

    expect(verdict.salvageable).toBe(false);
    if (verdict.salvageable) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/could not be examined/);
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
