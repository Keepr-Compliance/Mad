/**
 * @jest-environment node
 *
 * BACKLOG-2403 — a failed SQLite open must REJECT, not kill the process.
 *
 * `new sqlite3.Database(path, mode)` with no open callback reports a failed open
 * by emitting an `error` event. Unhandled, that is an uncaught exception, and in
 * the Electron main process it is a dead app with no dialog and no log line.
 * Six call sites had that shape, all of them reading `~/Library/Messages/chat.db`
 * — a file behind Full Disk Access, so "unreadable" is a normal step in
 * onboarding rather than an edge case.
 *
 * ─── WHY THIS SUITE BYPASSES THE STANDARD sqlite3 MOCK ───────────────────────
 *
 * `jest.config.js` maps `^sqlite3$` to `tests/__mocks__/sqlite3.js`. That stub
 * CANNOT REPRODUCE THIS BUG: its `Database` always calls back `callback(null)`
 * and its `on` is a bare `jest.fn()`, so it can neither fail an open nor emit an
 * error. A suite running against the stub would pass just as happily against the
 * BROKEN code — it would prove nothing at all. So these tests drive the real
 * driver against real files on disk, following the pattern established by
 * `contactsService.addressBooks.test.ts` (BACKLOG-2392). CI builds the real
 * binding: `sqlite3` is listed under `NAPI_MODULES` in `scripts/rebuild-native.js`.
 *
 * Negative control performed before commit: restoring the two-argument shape at
 * one call site turned this suite red. Recorded on BACKLOG-2403.
 */

import path from "path";
import fs from "fs";
import os from "os";

// The real driver, resolved by absolute path so jest's `^sqlite3$`
// moduleNameMapper (which points at a hand-written stub) does not intercept it.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

const mockLogError = jest.fn();
jest.mock("../../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
    debug: jest.fn(),
  },
}));

import { openSqliteReadOnly } from "../readOnlySqlite";

// POSIX permission bits are meaningless on Windows: `chmod 000` there leaves the
// file readable, so those cases would silently assert nothing. Gated rather than
// deleted — the failure they cover (FDA revoked) is macOS-only anyway.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

let tmpDir: string;
let readableDb: string;

/** Write a real, queryable SQLite file using the real driver. */
async function writeRealDb(dbPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite3 = require("sqlite3");
  await new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(
      dbPath,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        db.run("CREATE TABLE message (guid TEXT)", (runErr: Error | null) => {
          if (runErr) {
            reject(runErr);
            return;
          }
          db.run(
            "INSERT INTO message (guid) VALUES ('abc')",
            (insErr: Error | null) => {
              if (insErr) {
                reject(insErr);
                return;
              }
              db.close(() => resolve());
            },
          );
        });
      },
    );
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2403-"));
  readableDb = path.join(tmpDir, "readable.db");
  await writeRealDb(readableDb);
});

afterAll(() => {
  // Restore permissions first or the cleanup itself fails.
  for (const entry of ["unreadable.db", "lockeddir"]) {
    const p = path.join(tmpDir, entry);
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {
        /* best effort */
      }
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockLogError.mockClear();
});

// ---------------------------------------------------------------------------
// PROCESS SURVIVAL
//
// The whole point of the fix. An uncaught exception is what killed the app, so
// the suite watches for one directly instead of inferring survival from the fact
// that the assertions ran.
// ---------------------------------------------------------------------------

const uncaught: unknown[] = [];
const recordUncaught = (err: unknown) => uncaught.push(err);

beforeAll(() => {
  process.on("uncaughtException", recordUncaught);
});

afterAll(() => {
  process.off("uncaughtException", recordUncaught);
});

describe("openSqliteReadOnly — failed opens reject instead of crashing", () => {
  it("rejects for a database that does not exist", async () => {
    const missing = path.join(tmpDir, "no-such-file.db");
    expect(fs.existsSync(missing)).toBe(false);

    await expect(openSqliteReadOnly(missing)).rejects.toMatchObject({
      code: "SQLITE_CANTOPEN",
    });
  });

  it("rejects for a path that is a directory, not a database", async () => {
    // Cross-platform stand-in for "unopenable file" — no chmod involved, so this
    // case still runs on the Windows leg of the CI matrix.
    //
    // The driver reports a directory as SQLITE_IOERR rather than SQLITE_CANTOPEN
    // (verified, not assumed). Which code comes back is the driver's business;
    // what this fix guarantees is that it arrives as a rejection at all.
    const err = await openSqliteReadOnly(tmpDir).then(
      (handle) => {
        void handle.close();
        return null;
      },
      (e: NodeJS.ErrnoException) => e,
    );

    // Asserted by shape, not `instanceof Error`: the driver is a native addon,
    // so it builds the error in the outer realm and the identity check fails
    // against the test context's `Error` even though it is one.
    expect(err).not.toBeNull();
    expect(typeof (err as NodeJS.ErrnoException).message).toBe("string");
    expect(String((err as NodeJS.ErrnoException).code)).toMatch(/^SQLITE_/);
  });

  it("does not raise an uncaught exception on any failed open", () => {
    // If the two-argument shape came back, the driver's `error` event would have
    // no listener and land here — the exact thing that killed the main process.
    expect(uncaught).toEqual([]);
  });
});

posixOnly("openSqliteReadOnly — permission failures (POSIX)", () => {
  it("rejects for a file the process cannot read", async () => {
    const unreadable = path.join(tmpDir, "unreadable.db");
    fs.copyFileSync(readableDb, unreadable);
    fs.chmodSync(unreadable, 0o000);

    await expect(openSqliteReadOnly(unreadable)).rejects.toMatchObject({
      code: "SQLITE_CANTOPEN",
    });
    expect(uncaught).toEqual([]);
  });

  it("rejects for a readable file inside a permission-denied directory", async () => {
    // This is the shape of a revoked Full Disk Access grant: the file is fine,
    // the process just cannot traverse to it.
    const lockedDir = path.join(tmpDir, "lockeddir");
    fs.mkdirSync(lockedDir, { recursive: true });
    const inside = path.join(lockedDir, "inside.db");
    fs.copyFileSync(readableDb, inside);
    fs.chmodSync(lockedDir, 0o000);

    try {
      await expect(openSqliteReadOnly(inside)).rejects.toMatchObject({
        code: "SQLITE_CANTOPEN",
      });
      expect(uncaught).toEqual([]);
    } finally {
      fs.chmodSync(lockedDir, 0o755);
    }
  });

  it("keeps working after a failed open — one bad path does not poison the process", async () => {
    // Ordering matters: this runs AFTER the failures above. If a failed open had
    // taken the process down, we would never get here at all.
    const db = await openSqliteReadOnly(readableDb);
    const rows = await db.all<{ guid: string }>("SELECT guid FROM message");
    expect(rows).toEqual([{ guid: "abc" }]);
    await db.close();
  });
});

describe("openSqliteReadOnly — successful opens still work", () => {
  it("returns rows through all()", async () => {
    const db = await openSqliteReadOnly(readableDb);
    const rows = await db.all<{ guid: string }>("SELECT guid FROM message");
    expect(rows).toEqual([{ guid: "abc" }]);
    await db.close();
  });

  it("returns a single row through get(), and undefined when there is none", async () => {
    const db = await openSqliteReadOnly(readableDb);
    const row = await db.get<{ guid: string }>("SELECT guid FROM message");
    expect(row).toEqual({ guid: "abc" });

    const none = await db.get<{ guid: string }>(
      "SELECT guid FROM message WHERE guid = 'nope'",
    );
    expect(none).toBeUndefined();
    await db.close();
  });

  it("passes bound parameters through all()", async () => {
    const db = await openSqliteReadOnly(readableDb);
    const hit = await db.all<{ guid: string }>(
      "SELECT guid FROM message WHERE guid = ?",
      ["abc"],
    );
    expect(hit).toEqual([{ guid: "abc" }]);

    const miss = await db.all<{ guid: string }>(
      "SELECT guid FROM message WHERE guid = ?",
      ["zzz"],
    );
    expect(miss).toEqual([]);
    await db.close();
  });

  it("opens READ-ONLY — a write is refused rather than silently accepted", async () => {
    const db = await openSqliteReadOnly(readableDb);
    await expect(
      db.all("INSERT INTO message (guid) VALUES ('should-not-persist')"),
    ).rejects.toMatchObject({ code: "SQLITE_READONLY" });
    await db.close();

    // And the file really is untouched.
    const verify = await openSqliteReadOnly(readableDb);
    expect(await verify.all("SELECT guid FROM message")).toEqual([
      { guid: "abc" },
    ]);
    await verify.close();
  });

  it("surfaces query errors as rejections, not crashes", async () => {
    const db = await openSqliteReadOnly(readableDb);
    await expect(db.all("SELECT * FROM no_such_table")).rejects.toThrow(
      /no such table/i,
    );
    await db.close();
    expect(uncaught).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE DRIVER BEHAVIOUR THE HELPER EXISTS TO CONTAIN
//
// Documents the root cause against the real driver: a failed open is delivered
// as an EVENT, not a throw and not a callback error. This is the mechanism that
// made the old shape fatal.
// ---------------------------------------------------------------------------

describe("node-sqlite3 open-failure mechanics (root cause)", () => {
  it("delivers a failed open as an `error` EVENT when no open callback is given", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite3 = require("sqlite3");
    const missing = path.join(tmpDir, "also-missing.db");

    const emitted = await new Promise<{ code?: string }>((resolve) => {
      // The old, fatal shape — two arguments. Safe HERE only because a listener
      // is attached on the very next line; in production nothing listened, so
      // Node promoted this to an uncaught exception and the app died.
      // eslint-disable-next-line no-restricted-syntax
      const db = new sqlite3.Database(missing, sqlite3.OPEN_READONLY);
      db.on("error", (err: { code?: string }) => resolve(err));
    });

    expect(emitted.code).toBe("SQLITE_CANTOPEN");
  });

  it("does NOT throw synchronously — which is why try/catch around the queries never fired", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite3 = require("sqlite3");
    const missing = path.join(tmpDir, "still-missing.db");

    let db: { on: (e: string, cb: (err: unknown) => void) => void } | undefined;
    expect(() => {
      // eslint-disable-next-line no-restricted-syntax
      db = new sqlite3.Database(missing, sqlite3.OPEN_READONLY);
    }).not.toThrow();

    // Attach a listener so the pending failure has somewhere to go and does not
    // land on the process as an uncaught exception mid-suite.
    db?.on("error", () => {});
  });
});
