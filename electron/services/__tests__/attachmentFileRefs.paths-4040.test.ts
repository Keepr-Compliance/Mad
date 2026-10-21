/**
 * @jest-environment node
 */

/**
 * BACKLOG-4040 S1 — every existing path that deletes an attachment FILE keeps a
 * file that another attachments row still uses, whatever the case of its
 * extension and whether that row stores the path absolute or relative; and it
 * never deletes a file outside the app's attachment folders.
 *
 * Real driver, real schema.sql, the REAL delete paths (RCS clear, RCS
 * auto-delete, RCS staging crash recovery, iPhone rollback, email re-cache
 * cleanup) and REAL files in a temp folder. Every test asserts the CORRECT
 * result, so a red test means the hole is present. Values are invented.
 *
 * Files are named <sha256><ext> by every writer; the same bytes stored by two
 * sources can produce `h.png` and `h.PNG` rows. On a case-insensitive volume
 * (APFS default, NTFS) both rows open ONE file.
 *
 *   P1   RCS clear: removed h.png, kept h.PNG (absolute)             -> file kept
 *   P1r  RCS clear: removed h.PNG, kept h.png                        -> file kept
 *   P1x  RCS clear: kept row RELATIVE and upper-case                 -> file kept
 *   P2   iPhone rollback: session h.heic, kept h.HEIC                -> file kept
 *   P2b  iPhone rollback: kept row relative                          -> file kept
 *   P2c  iPhone rollback: session row outside message-attachments    -> NOT deleted
 *   P3   RCS auto-delete (dormant), P1 / P1r shapes                  -> file kept
 *   P4   RCS staging crash recovery, P1 / P1r shapes                 -> file kept
 *   P5b  email re-cache cleanup: kept row relative                   -> file kept
 *   plus an unshared-file control on every path (still deleted).
 *
 * This file runs against the code before AND after the fix (it only uses
 * entry points that exist in both), so its red-at-head counts are measurable.
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

let mockUserData = "/unset";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => mockUserData), isPackaged: false },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
// The rollback reaches the database through databaseService, whose two methods
// used here are pass-throughs to the real db/ functions (databaseService.ts:3195).
jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  return {
    __esModule: true,
    default: {
      deleteAttachmentsBySessionId: (sessionId: string) => sync.deleteAttachmentsBySessionId(sessionId),
      deleteMessagesBySessionId: () => 0,
    },
  };
});
jest.mock("../db/externalContactDbService", () => ({ deleteBySessionId: jest.fn(() => 0) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../db/core/dbConnection";
import { rcsAutoDeleteDbOps, rcsClearDbOps, rcsStagingDbOps } from "../db/syncDbService";
import { clearGoogleMessagesWebData, clearUnlinkedOldChats, type RcsClearFs } from "../rcsClearService";
import { RcsCacheStaging, type RcsStagingFs } from "../rcsCacheStaging";
import { removeOrphanedAttachmentFiles } from "../emailForceOrphanFiles";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-4040-a";
const OTHER = "user-4040-b";
const HASH = "4040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LONE = "4040bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SESSION = "sync-session-4040";
const GM_THREAD = "gmweb2-chat4040";

let db: DatabaseType;
let tmp: string;
let msgDir: string;
let emailDir: string;
let outsideDir: string;
let seq = 0;

function msg(user: string, externalId: string, thread: string): string {
  const id = `m-${++seq}`;
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
     VALUES (?, ?, 'sms', ?, 'inbound', 'x', '{"from":"Test Contact","to":["me"]}', ?, '2026-01-05T10:00:00.000Z')`,
  ).run(id, user, externalId, thread);
  return id;
}

function att(messageId: string, storagePath: string, sessionId: string | null = null): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, storage_path, sync_session_id) VALUES (?, ?, 'IMG.bin', ?, ?)`,
  ).run(`a-${++seq}`, messageId, storagePath, sessionId);
}

/** An email of OTHER that keeps an attachment row on `storagePath`. */
function emailRow(storagePath: string): void {
  const id = `e-${++seq}`;
  db.prepare("INSERT INTO emails (id, user_id, source, direction) VALUES (?, ?, 'gmail', 'inbound')").run(id, OTHER);
  db.prepare("INSERT INTO attachments (id, email_id, filename, storage_path) VALUES (?, ?, 'doc.pdf', ?)").run(
    `a-${++seq}`, id, storagePath,
  );
}

/** The iPhone text this sync session inserted, with its attachment on `storagePath`. */
function sessionRow(storagePath: string): void {
  att(msg(USER, `ios-guid-${++seq}`, "ios-thread"), storagePath, SESSION);
}

/** A Mac (or another user's) text that keeps an attachment row on `storagePath`. */
function keptRow(storagePath: string, user = OTHER): void {
  att(msg(user, `mac-guid-${++seq}`, "mac-thread"), storagePath);
}

/** A file on disk; returns its absolute path. */
function file(dir: string, name: string): string {
  const p = nodePath.join(dir, name);
  fs.writeFileSync(p, "bytes");
  return p;
}

const exists = (p: string): boolean => fs.existsSync(p);

function clearFs(): RcsClearFs {
  return {
    attachmentsRoot: msgDir,
    resolve: (p) => (nodePath.isAbsolute(p) ? p : nodePath.join(tmp, p)),
    deleteFile: (abs) => {
      try {
        fs.unlinkSync(abs);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function stagingFs(): RcsStagingFs {
  return {
    stagingRoot: nodePath.join(tmp, "rcs-cache-staging"),
    attachmentsDir: msgDir,
    mkdir: async (d) => {
      await fs.promises.mkdir(d, { recursive: true });
    },
    writeSealed: async (p, data) => {
      await fs.promises.writeFile(p, data);
    },
    exists: async (p) => fs.existsSync(p),
    move: async (from, to) => {
      await fs.promises.rename(from, to);
    },
    unlink: async (p) => {
      await fs.promises.unlink(p).catch(() => undefined);
    },
    removeDir: async (d) => {
      await fs.promises.rm(d, { recursive: true, force: true }).catch(() => undefined);
    },
    listDir: async (d) => fs.promises.readdir(d).catch(() => [] as string[]),
  };
}

beforeEach(() => {
  seq = 0;
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4040-"));
  mockUserData = tmp;
  msgDir = nodePath.join(tmp, "message-attachments");
  emailDir = nodePath.join(tmp, "attachments");
  outsideDir = nodePath.join(tmp, "elsewhere");
  for (const d of [msgDir, emailDir, outsideDir]) fs.mkdirSync(d);

  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-4040-${n}@example.test`, `oauth-4040-${n}`,
    );
  }
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Probe of the volume (P0). The controls hold on either kind of volume; this
// only records which kind the run had.
it("P0: records whether the temp volume folds case", () => {
  const p = file(msgDir, "p0.png");
  const folds = exists(nodePath.join(msgDir, "p0.PNG"));
  fs.unlinkSync(p);
  expect(typeof folds).toBe("boolean");
});

// ---------------------------------------------------------------------------
// Path 1: RCS clear (Settings > Android Messages > Force re-import)
// ---------------------------------------------------------------------------

describe("path 1: RCS clear", () => {
  /** The gmweb text to clear, with an attachment on `candidate`. */
  function gmwebRow(candidate: string): void {
    att(msg(USER, "gmweb2:chat4040:1", GM_THREAD), candidate);
  }

  it("P1: removed h.png, kept Mac row h.PNG (absolute) -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.png`);
    gmwebRow(shared);
    keptRow(nodePath.join(msgDir, `${HASH}.PNG`));
    const result = await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(shared)).toBe(true);
    expect(result.filesDeleted).toBe(0);
  });

  it("P1r: removed h.PNG, kept h.png -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.PNG`);
    gmwebRow(shared);
    keptRow(nodePath.join(msgDir, `${HASH}.png`));
    const result = await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(shared)).toBe(true);
    expect(result.filesDeleted).toBe(0);
  });

  it("P1x: kept row stored RELATIVE and upper-case -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.png`);
    gmwebRow(shared);
    keptRow(`message-attachments/${HASH}.PNG`);
    const result = await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(shared)).toBe(true);
    expect(result.filesDeleted).toBe(0);
  });

  it("P1x\\: kept row stored relative with \\ and upper-case -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.png`);
    gmwebRow(shared);
    keptRow(`message-attachments\\${HASH}.PNG`);
    await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(shared)).toBe(true);
  });

  it("control: an unshared file is still deleted", async () => {
    const lone = file(msgDir, `${HASH}.png`);
    gmwebRow(lone);
    keptRow(nodePath.join(msgDir, `${LONE}.png`));
    const result = await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(lone)).toBe(false);
    expect(result.filesDeleted).toBe(1);
  });

  it("a gmweb row pointing outside message-attachments: file NOT deleted", async () => {
    const outside = file(outsideDir, `${LONE}.png`);
    gmwebRow(outside);
    await clearGoogleMessagesWebData(USER, rcsClearDbOps(), clearFs());
    expect(exists(outside)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path 2: RCS auto-delete (DORMANT: same check, fixed with it)
// ---------------------------------------------------------------------------

describe("path 2: RCS auto-delete", () => {
  /** The selection SQL is not under test here: the chat to delete is named. */
  const ops = () => ({ ...rcsAutoDeleteDbOps(), unlinkedOldThreads: () => [GM_THREAD] });
  const run = () => clearUnlinkedOldChats(USER, "2026-06-01T00:00:00.000Z", ops(), clearFs());

  it.each([
    ["P3 (P1 shape)", ".png", ".PNG"],
    ["P3r (P1r shape)", ".PNG", ".png"],
  ])("%s: the shared file is kept", async (_l, removedExt, keptExt) => {
    const shared = file(msgDir, `${HASH}${removedExt}`);
    att(msg(USER, "gmweb2:chat4040:1", GM_THREAD), shared);
    keptRow(`message-attachments/${HASH}${keptExt}`);
    await run();
    expect(exists(shared)).toBe(true);
  });

  it("control: an unshared file is still deleted", async () => {
    const lone = file(msgDir, `${HASH}.png`);
    att(msg(USER, "gmweb2:chat4040:1", GM_THREAD), lone);
    const result = await run();
    expect(exists(lone)).toBe(false);
    expect(result.filesDeleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Paths 3 and 4: RCS staging — crash recovery of journaled files
// (the per-chat failure branch uses the same check)
// ---------------------------------------------------------------------------

describe("path 3: RCS staging crash recovery", () => {
  function journal(p: string): void {
    rcsStagingDbOps().journalPlaced("job-4040-crashed", p);
  }

  it.each([
    ["P4 (P1 shape)", ".png", ".PNG"],
    ["P4r (P1r shape)", ".PNG", ".png"],
  ])("%s: the shared file is kept, its journal row goes", async (_l, placedExt, keptExt) => {
    const placed = file(msgDir, `${HASH}${placedExt}`);
    journal(placed);
    keptRow(nodePath.join(msgDir, `${HASH}${keptExt}`));
    const removed = await new RcsCacheStaging(rcsStagingDbOps(), stagingFs()).recoverPlacedFiles();
    expect(exists(placed)).toBe(true);
    expect(removed).toBe(0);
    expect(rcsStagingDbOps().journalRows()).toEqual([]);
  });

  it("control: an unreferenced journaled file is still deleted", async () => {
    const placed = file(msgDir, `${HASH}.png`);
    journal(placed);
    const removed = await new RcsCacheStaging(rcsStagingDbOps(), stagingFs()).recoverPlacedFiles();
    expect(exists(placed)).toBe(false);
    expect(removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Path 5: iPhone sync rollback (a cancelled sync), through the real
// rollbackSession that cancel reaches (iPhoneSyncStorageService.ts:338/:360/:389)
// ---------------------------------------------------------------------------

describe("path 5: iPhone rollback", () => {
  const rollback = (): Promise<void> =>
    (iPhoneSyncStorageService as unknown as { rollbackSession(u: string, s: string): Promise<void> }).rollbackSession(
      USER,
      SESSION,
    );
  const sessionRows = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE sync_session_id = ?").get(SESSION) as { n: number }).n;

  it("P2: session row h.heic, kept Mac row h.HEIC -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.heic`);
    sessionRow(shared);
    keptRow(nodePath.join(msgDir, `${HASH}.HEIC`), USER);
    await rollback();
    expect(sessionRows()).toBe(0);
    expect(exists(shared)).toBe(true);
  });

  it("P2r: session row h.HEIC, kept h.heic -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.HEIC`);
    sessionRow(shared);
    keptRow(nodePath.join(msgDir, `${HASH}.heic`), USER);
    await rollback();
    expect(exists(shared)).toBe(true);
  });

  it("P2b: kept row stored relative, same name -> the shared file is kept", async () => {
    const shared = file(msgDir, `${HASH}.heic`);
    sessionRow(shared);
    keptRow(`message-attachments/${HASH}.heic`, USER);
    await rollback();
    expect(exists(shared)).toBe(true);
  });

  it("P2c: a session row pointing OUTSIDE message-attachments is never deleted", async () => {
    const outside = file(outsideDir, `${LONE}.heic`);
    sessionRow(outside);
    await rollback();
    expect(sessionRows()).toBe(0);
    expect(exists(outside)).toBe(true);
  });

  it("P2c: nor a file in the email attachments folder", async () => {
    const email = file(emailDir, `${LONE}.heic`);
    sessionRow(email);
    await rollback();
    expect(exists(email)).toBe(true);
  });

  it("control: kept row with the exact same path -> file kept", async () => {
    const shared = file(msgDir, `${HASH}.heic`);
    sessionRow(shared);
    keptRow(shared, USER);
    await rollback();
    expect(exists(shared)).toBe(true);
  });

  it("control: an unshared session file is still deleted", async () => {
    const lone = file(msgDir, `${HASH}.heic`);
    sessionRow(lone);
    await rollback();
    expect(sessionRows()).toBe(0);
    expect(exists(lone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path 6: email Force Re-cache cleanup (3913)
// ---------------------------------------------------------------------------

describe("path 6: email re-cache cleanup", () => {
  it.each([
    ["P5b: kept row relative, same case", "attachments/H.pdf"],
    ["P5b\\: kept row relative with \\", "attachments\\H.pdf"],
    ["P5r: kept row relative, other case", "attachments/H.PDF"],
    ["P5: kept row absolute, other case", "ABS"],
  ])("%s -> the file is kept", async (_l, kept) => {
    const candidate = file(emailDir, `${HASH}.pdf`);
    const keptPath = kept === "ABS" ? nodePath.join(emailDir, `${HASH}.PDF`) : kept.replace("H", HASH);
    emailRow(keptPath);
    const result = await removeOrphanedAttachmentFiles(db, [candidate], tmp);
    expect(exists(candidate)).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.stillReferenced).toBe(1);
  });

  it("control: an unshared file is still deleted", async () => {
    const candidate = file(emailDir, `${HASH}.pdf`);
    emailRow(nodePath.join(emailDir, `${LONE}.pdf`));
    const result = await removeOrphanedAttachmentFiles(db, [candidate], tmp);
    expect(exists(candidate)).toBe(false);
    expect(result.removed).toBe(1);
  });

  it("control: a path outside the attachment folders is refused", async () => {
    const outside = file(outsideDir, `${HASH}.pdf`);
    const result = await removeOrphanedAttachmentFiles(db, [outside], tmp);
    expect(exists(outside)).toBe(true);
    expect(result.refused).toBe(1);
  });
});
