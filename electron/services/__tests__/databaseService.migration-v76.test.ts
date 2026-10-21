/**
 * @jest-environment node
 *
 * BACKLOG-4018 — migration v76 on the REAL upgrade path: a one-time repair of
 * texts whose `messages.transaction_id` is empty but which still hold a
 * per-message link. SR plan review pm_comments 84417e37 on BACKLOG-4018.
 *
 * Launch 1: the real `initialize()` builds an install at the current version,
 * the 2.42 fixture rows are copied in, `schema_version` is put back to 75.
 * Launch 2: the real `initialize()` runs v76 through the real runner
 * (foreign_keys OFF for the loop, like production).
 *
 * The fixture (fixtures/backlog-4018-v242-texts.json) is the output of the real
 * 2.42 writers (provenance inside it). Cases: F1, F2, F3, F6, F9 broken
 * (empty column, per-message link left); F4 thread-only (empty column BY
 * DESIGN, must stay in the picker); F5, F8 healthy; F7 nothing left.
 *
 * TRANSCRIBED, NOT EXECUTED: ORPHAN_ROW below. No writer can make it with
 * foreign keys on; it is the legacy shape SR probed (F7-1 -> 'tx-GONE', no
 * deal row). Without the dangling-id guard v76 writes 'tx-GONE' into F7-1.
 *
 * Mutations that must turn it red (each run, see the PR's pm_comments):
 * no-op body; broad qualifier (every empty column); earliest link instead of
 * most recent; dropping `m.transaction_id IS NULL`; setter ignoring thread
 * rows; no dangling-id guard; version 77.
 *
 * Run under Electron's node locally (the shared native module is Electron-ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/databaseService.migration-v76.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-4018";
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

type Row = Record<string, unknown>;
type Fixture = Record<"users_local" | "transactions" | "messages" | "communications", Row[]>;
type Chain = Array<{ version: number; migrate: (d: DatabaseType) => void }>;

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "backlog-4018-v242-texts.json"), "utf8"),
) as Fixture;
const TABLES = ["users_local", "transactions", "messages", "communications"] as const;

/** TRANSCRIBED, NOT EXECUTED (see header). Newest link on F7-1, deal row absent. */
const ORPHAN_ROW: Row = {
  id: "c-F7-1-gone",
  user_id: "u-4018",
  transaction_id: "tx-GONE",
  message_id: "F7-1",
  linked_at: "2026-10-20 16:42:30",
};

/** The column as the 2.42 writers left it (the producer dump), asserted, not assumed. */
const BEFORE_ALL: Record<string, string | null> = {
  "F1-1": null, "F1-2": null, "F2-1": null, "F2-2": null, "F3-1": null, "F3-2": null,
  "F4-1": null, "F4-2": null, "F5-1": "tx-A", "F5-2": "tx-A", "F6-1": null, "F6-2": null,
  "F7-1": null, "F7-2": null, "F8-1": "tx-A", "F8-2": "tx-A", "F9-1": null, "F9-2": null,
};
const AFTER_ALL: Record<string, string | null> = {
  ...BEFORE_ALL,
  "F1-1": "tx-A", "F1-2": "tx-A", // remove-conversation from B; A remains
  "F2-1": "tx-C", "F2-2": "tx-C", // A and C remain; C is newer
  "F3-1": "tx-C", "F3-2": "tx-C", // per-message A, newer thread row C: the 3908 rule picks C
  "F6-1": "tx-A", "F6-2": "tx-A", // deal D removed; A remains
  "F9-1": "tx-A", "F9-2": "tx-A", // half-link: junction row A, pointer lost
};
const HEALTHY = /^F(4|5|7|8)-/;

const version = (db: DatabaseType): number =>
  (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version;
const column = (db: DatabaseType): Record<string, string | null> =>
  Object.fromEntries(
    (db.prepare("SELECT id, transaction_id FROM messages ORDER BY id").all() as Array<{
      id: string;
      transaction_id: string | null;
    }>).map((r) => [r.id, r.transaction_id]),
  );
const linkKey = (r: Row): string =>
  [r.id, r.message_id ?? null, r.thread_id ?? null, r.transaction_id ?? null].map(String).join("|");
const links = (db: DatabaseType): string[] =>
  (db.prepare("SELECT id, message_id, thread_id, transaction_id FROM communications").all() as Row[])
    .map(linkKey)
    .sort();
/** Case of a link row: its message (F1-1 -> F1-1) or its thread (th-F4 -> F4-x). */
const caseOf = (r: Row): string => String(r.message_id ?? `${String(r.thread_id).replace("th-", "")}-x`);

function insert(db: DatabaseType, table: string, r: Row): void {
  const k = Object.keys(r);
  db.prepare(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(
    ...k.map((x) => r[x] as never),
  );
}

/** Launch 1 + fixture at v75, then launch 2 (v76 runs). */
async function upgradeFrom75(which: "all" | "healthy") {
  const keep = (id: string) => which === "all" || HEALTHY.test(id);
  const first = loadService();
  await expect(first.initialize()).resolves.toBe(true);
  const firstDb = first.db as DatabaseType;
  for (const t of TABLES) {
    for (const r of FIXTURE[t]) {
      if (t === "messages" && !keep(String(r.id))) continue;
      if (t === "communications" && !keep(caseOf(r))) continue;
      insert(firstDb, t, r);
    }
  }
  firstDb.pragma("foreign_keys = OFF");
  insert(firstDb, "communications", ORPHAN_ROW);
  firstDb.pragma("foreign_keys = ON");
  firstDb.prepare("UPDATE schema_version SET version = 75 WHERE id = 1").run();

  // PRECONDITION: the whole before-state, column and link rows, equal to the dump.
  const dumpColumn = Object.fromEntries(
    FIXTURE.messages.filter((m) => keep(String(m.id))).map((m) => [m.id, m.transaction_id]),
  );
  const dumpLinks = [...FIXTURE.communications.filter((c) => keep(caseOf(c))), ORPHAN_ROW].map(linkKey).sort();
  const before = column(firstDb);
  expect(before).toEqual(dumpColumn);
  expect(links(firstDb)).toEqual(dumpLinks);
  expect(firstDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id = 'tx-GONE'").get()).toEqual({ n: 0 });
  expect(version(firstDb)).toBe(75);
  await first.close();

  const second = loadService();
  await expect(second.initialize()).resolves.toBe(true);
  const db = second.db as DatabaseType;
  return { svc: second, db, before, dumpLinks };
}

const chain = (svc: AnyService): Chain => (svc.constructor as { MIGRATIONS: Chain }).MIGRATIONS;

/** Re-run v76 the way the runner does: foreign_keys OFF, one transaction. */
function rerunV76(svc: AnyService, db: DatabaseType): void {
  const v76 = chain(svc).find((m) => m.version === 76)!;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => v76.migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("migration v76 — BACKLOG-4018, texts with an empty deal column on the real upgrade path", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4018-v76-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is in the chain as v76, the last entry", () => {
    const versions = chain(loadService()).map((m) => m.version);
    expect(versions[versions.length - 1]).toBe(76);
    expect(versions.indexOf(76)).toBe(versions.indexOf(75) + 1);
  });

  it("U0: the v76 setter is the BACKLOG-3908 rule, verbatim", () => {
    // V76_REPOINT_SQL is FROZEN (MIGRATION-GUIDE rule 2: a merged migration never
    // changes). If this goes red because REPOINT_MESSAGE_TRANSACTION_SQL changed,
    // do NOT edit V76_REPOINT_SQL: replace the right-hand side below with the
    // frozen literal (or remove this test).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { V76_REPOINT_SQL } = require("../db/migrationV76Sql");
    // Right-hand side replaced with the frozen literal (BACKLOG-3908 follow-up):
    // the live statement now also skips links to deals with no transactions row.
    const FROZEN_AT_BDC077644 = `UPDATE messages SET transaction_id = (
      SELECT c.transaction_id FROM communications c
      WHERE c.transaction_id IS NOT NULL
        AND (
          c.message_id = messages.id
          OR (
            c.message_id IS NULL
            AND c.email_id IS NULL
            AND c.thread_id IS NOT NULL
            AND c.thread_id = messages.thread_id
            AND +c.user_id = messages.user_id
          )
        )
      ORDER BY c.linked_at DESC, c.rowid DESC
      LIMIT 1
    ) WHERE id = ?`;
    if (V76_REPOINT_SQL !== FROZEN_AT_BDC077644) {
      throw new Error(
        "V76_REPOINT_SQL no longer matches REPOINT_MESSAGE_TRANSACTION_SQL. NEVER edit the frozen copy " +
          "in migrationV76Sql.ts (a merged migration never changes). Replace this test's right-hand side " +
          "with the frozen literal, or remove this test.",
      );
    }
  });

  it("U1: broken texts at v75 are re-pointed at v76; thread-only, healthy and orphan-only rows are not", async () => {
    const { svc, db, before, dumpLinks } = await upgradeFrom75("all");
    expect(before).toEqual(BEFORE_ALL);
    expect(version(db)).toBe(76);
    const after = column(db);
    expect(after).toEqual(AFTER_ALL);
    // The orphan link was the newest on F7-1; no deal row exists, so the column stays empty.
    expect(after["F7-1"]).toBeNull();
    // No link row is added or removed.
    expect(links(db)).toEqual(dumpLinks);
    // BACKLOG-4017 (inverted): the auto-linked thread (F4, thread row in tx-A) is left
    // out of tx-A's attach picker and stays in any other deal's; F1, now in deal A, is
    // in neither.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMessagesByContact } = require("../db/messageDbService");
    expect(getMessagesByContact("u-4018", "+15550114", "tx-A")).toEqual([]);
    expect(getMessagesByContact("u-4018", "+15550114", "tx-B").map((m: { id: string }) => m.id).sort()).toEqual([
      "F4-1",
      "F4-2",
    ]);
    expect(getMessagesByContact("u-4018", "+15550111", "tx-A")).toEqual([]);
    // Idempotent.
    rerunV76(svc, db);
    expect(column(db)).toEqual(AFTER_ALL);
    await svc.close();
  });

  it("U2: no broken texts at v75 -> v76 changes nothing", async () => {
    const { svc, db, before, dumpLinks } = await upgradeFrom75("healthy");
    expect(Object.keys(before).sort()).toEqual(Object.keys(BEFORE_ALL).filter((id) => HEALTHY.test(id)).sort());
    expect(version(db)).toBe(76);
    expect(column(db)).toEqual(before);
    expect(links(db)).toEqual(dumpLinks);
    rerunV76(svc, db);
    expect(column(db)).toEqual(before);
    await svc.close();
  });
});
