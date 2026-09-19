/**
 * Pin for `MANIFEST_FILE_BY_ID_SQL` — BACKLOG-2989 PR 1.
 *
 * The statement moved out of `backupDecryptionService.decryptFile`.
 * `backupDecryptionService.test.ts` feeds `prepare` a bare `jest.fn()`
 * (`mockDbPrepare`), so it never sees the SQL and a mutation leaves it green.
 *
 * ## A stated limit of this fixture
 *
 * `Manifest.db` is Apple's, not Keepr's, and there is no real iPhone backup in
 * this repository to transcribe from. So the fixture below is built from the
 * ONE source of truth available — the four columns `decryptFile` names and the
 * types it casts them to (`fileID`, `domain`, `relativePath` as strings, `file`
 * as a Buffer). It therefore pins THE STATEMENT's behaviour: which columns come
 * back, under which names, and that the lookup keys on `fileID`.
 *
 * It does NOT pin that Apple's schema matches this shape — nothing in this
 * repository can, and claiming otherwise would be the invented-fixture error.
 * If Apple changes `Files`, this test stays green and the real path breaks;
 * that failure mode is recorded rather than hidden.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { MANIFEST_FILE_BY_ID_SQL } from "../iosBackupManifestSql";

const WANTED = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";
const OTHER = "ff1cc3f3fcdfdec144b1b2f2b0d1b5c3d1bb1a11";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-manifest-"));
  db = new RealDatabase(path.join(tmpRoot, "Manifest.db"));
  db.exec(`
    CREATE TABLE Files (
      fileID TEXT PRIMARY KEY,
      domain TEXT,
      relativePath TEXT,
      flags INTEGER,
      file BLOB
    )
  `);
  const ins = db.prepare(
    "INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run(
    WANTED,
    "HomeDomain",
    "Library/SMS/sms.db",
    1,
    Buffer.from("plist-for-sms", "utf8"),
  );
  ins.run(
    OTHER,
    "CameraRollDomain",
    "Media/DCIM/100APPLE/IMG_0001.JPG",
    1,
    Buffer.from("plist-for-photo", "utf8"),
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("MANIFEST_FILE_BY_ID_SQL", () => {
  it("returns the four columns decryptFile reads, for the requested fileID only", () => {
    const row = db.prepare(MANIFEST_FILE_BY_ID_SQL).get(WANTED) as {
      fileID: string;
      domain: string;
      relativePath: string;
      file: Buffer;
    };

    // The row READ BACK. `file` carries the plist holding the per-file
    // encryption key, so selecting the wrong row decrypts nothing.
    expect(row.fileID).toBe(WANTED);
    expect(row.domain).toBe("HomeDomain");
    expect(row.relativePath).toBe("Library/SMS/sms.db");
    expect(row.file.toString("utf8")).toBe("plist-for-sms");
  });

  it("selects no other row's data when two files are present", () => {
    const row = db.prepare(MANIFEST_FILE_BY_ID_SQL).get(OTHER) as {
      relativePath: string;
      file: Buffer;
    };
    expect(row.relativePath).toBe("Media/DCIM/100APPLE/IMG_0001.JPG");
    expect(row.file.toString("utf8")).toBe("plist-for-photo");
  });

  it("returns undefined for a fileID that is not in the manifest", () => {
    // `decryptFile` branches on this and logs "File not found in manifest".
    // A statement that returned a row here would decrypt the wrong file.
    expect(db.prepare(MANIFEST_FILE_BY_ID_SQL).get("no-such-hash")).toBeUndefined();
  });

  it("projects exactly the four named columns, not the whole row", () => {
    const row = db.prepare(MANIFEST_FILE_BY_ID_SQL).get(WANTED) as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).sort()).toEqual([
      "domain",
      "file",
      "fileID",
      "relativePath",
    ]);
  });
});
