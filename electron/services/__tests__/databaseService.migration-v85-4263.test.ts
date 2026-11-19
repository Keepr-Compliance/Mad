/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-11c — migration v85 (who last wrote an item's done and note parts).
 *
 * Runs on the SQLite handle of the Keepr Cloud suites (cloudSync/__tests__/helpers/sqlite.ts): the bundled driver
 * when it loads under jest, else Node's built-in `node:sqlite` (the suite title says which ran).
 *
 * The v84 side is this build's schema.sql with the v85 lines removed; V85-FIXTURE pins that the result is
 * byte-for-byte the schema.sql of int-portal/mcp-write at b5fdc730c (the last v84 build).
 *
 *   V85a  a v84 table gains the eight columns, in schema.sql's order, NULL on every existing row; no row changes
 *   V85b  a fresh install and an upgraded v84 table end with the same columns IN THE SAME ORDER and the same CHECKs
 *   V85c  re-runnable, and a no-op on a fresh install
 *   V85d  the vocabulary CHECKs refuse anything else; NULL passes
 *   V85e  v85 follows v84 and the chain has no gap
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/unset-4263-v85"),
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

import { DRIVER, openTestDb, type TestDb } from "../cloudSync/__tests__/helpers/sqlite";

/** Invented all-zero-pattern ids. */
const fid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const AUTHOR_COLUMNS = [
  "done_by_kind",
  "done_by_app",
  "done_by_at",
  "done_by_stamp",
  "note_by_kind",
  "note_by_app",
  "note_by_at",
  "note_by_digest",
];

/** `git show b5fdc730c:electron/database/schema.sql | shasum -a 256` (the last v84 build). */
const V84_SCHEMA_SHA256 = "a20726453526e70c70756b1a0cad24ce398bd8fd75da2de19ed5094d14fa14bc";

/** This build's schema.sql without the v85 block (two comment lines and the eight columns). */
function v84Schema(): string {
  const lines = SCHEMA.split("\n");
  const start = lines.findIndex((l) => l.includes("BACKLOG-4263 PR-11c (migration v85"));
  if (start < 0) throw new Error("v85 block not found in schema.sql");
  return [...lines.slice(0, start), ...lines.slice(start + 10)].join("\n");
}

interface MigrationEntry {
  version: number;
  migrate: (d: unknown) => void;
}
function migrations(): MigrationEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return (svc.constructor as { MIGRATIONS: MigrationEntry[] }).MIGRATIONS;
}
function v85(): MigrationEntry {
  return migrations().find((m) => m.version === 85)!;
}

const itemColumns = (db: TestDb) =>
  (db.prepare("PRAGMA table_info(transaction_checklist_items)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>).map(
    (c) => `${c.name}:${c.type}:${c.notnull}:${String(c.dflt_value)}`,
  );
const itemDdl = (db: TestDb) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_checklist_items'").get() as { sql: string }).sql;
/** Every column-level CHECK in a table's DDL that names one of the author columns, whitespace-normalised. */
const authorChecks = (ddl: string) =>
  AUTHOR_COLUMNS.map((c) => {
    const m = new RegExp(`\\b${c}\\s+TEXT(\\s+CHECK\\s*\\((?:[^()]|\\([^()]*\\))*\\))?`).exec(ddl);
    return `${c}=${m ? (m[1] ?? "").replace(/\s+/g, " ").trim() : "MISSING"}`;
  });

function seedRows(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title, is_checked, checked_at, note) VALUES (?, ?, ?, 1, '2026-11-01 10:00:00', ?)").run(
    fid(851),
    fid(850),
    "Inspection",
    "Booked",
  );
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES (?, ?, ?)").run(
    fid(852),
    fid(850),
    "Appraisal",
  );
}

describe(`migration v85: item author columns (${DRIVER})`, () => {
  it("V85-FIXTURE: this build's schema.sql without the v85 block is b5fdc730c's schema.sql byte-for-byte", () => {
    expect(crypto.createHash("sha256").update(v84Schema()).digest("hex")).toBe(V84_SCHEMA_SHA256);
  });

  it("V85a a v84 table gains the eight columns at the end, in order, NULL on every row; no existing value changes", () => {
    const db = openTestDb();
    db.exec(v84Schema());
    seedRows(db);
    const before = db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all();
    expect(itemColumns(db).map((c) => c.split(":")[0])).not.toContain("done_by_kind");
    v85().migrate(db);
    const names = itemColumns(db).map((c) => c.split(":")[0]);
    expect(names.slice(-8)).toEqual(AUTHOR_COLUMNS);
    const after = db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !AUTHOR_COLUMNS.includes(k))))).toEqual(before);
    for (const r of after) for (const c of AUTHOR_COLUMNS) expect([c, r[c]]).toEqual([c, null]);
    db.close();
  });

  it("V85b a fresh install and an upgraded v84 table have the same columns in the same order, and the same CHECKs", () => {
    const fresh = openTestDb();
    fresh.exec(SCHEMA);
    v85().migrate(fresh);
    const upgraded = openTestDb();
    upgraded.exec(v84Schema());
    upgraded.exec(SCHEMA); // the real open order: schema.sql on every open, then the chain
    v85().migrate(upgraded);
    expect(itemColumns(upgraded)).toEqual(itemColumns(fresh));
    expect(authorChecks(itemDdl(upgraded))).toEqual(authorChecks(itemDdl(fresh)));
    expect(authorChecks(itemDdl(fresh)).filter((c) => c.endsWith("=MISSING"))).toEqual([]);
    fresh.close();
    upgraded.close();
  });

  it("V85c re-runnable (a second run changes nothing) and a no-op on a fresh install", () => {
    const db = openTestDb();
    db.exec(v84Schema());
    seedRows(db);
    v85().migrate(db);
    const ddl = itemDdl(db);
    const rows = db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all();
    v85().migrate(db);
    expect(itemDdl(db)).toBe(ddl);
    expect(db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all()).toEqual(rows);
    const fresh = openTestDb();
    fresh.exec(SCHEMA);
    const freshDdl = itemDdl(fresh);
    v85().migrate(fresh);
    expect(itemDdl(fresh)).toBe(freshDdl);
    db.close();
    fresh.close();
  });

  it("V85d the vocabulary CHECKs refuse anything else and accept the vocabulary and NULL (both paths)", () => {
    for (const build of ["fresh", "upgraded"] as const) {
      const db = openTestDb();
      db.exec(build === "fresh" ? SCHEMA : v84Schema());
      if (build === "upgraded") v85().migrate(db);
      seedRows(db);
      const id = fid(852);
      const set = (col: string, v: unknown) => () => db.prepare(`UPDATE transaction_checklist_items SET ${col} = ? WHERE id = ?`).run(v, id);
      for (const col of ["done_by_kind", "note_by_kind"]) {
        for (const ok of ["agent", "ai_app", null]) expect(set(col, ok)).not.toThrow();
        for (const bad of ["Agent", "ai", "claude", ""]) expect([build, col, bad, (() => { try { set(col, bad)(); return "accepted"; } catch { return "refused"; } })()]).toEqual([build, col, bad, "refused"]);
      }
      for (const col of ["done_by_app", "note_by_app"]) {
        for (const ok of ["anthropic", "openai", null]) expect(set(col, ok)).not.toThrow();
        for (const bad of ["Claude", "ChatGPT", "google", ""]) expect([build, col, bad, (() => { try { set(col, bad)(); return "accepted"; } catch { return "refused"; } })()]).toEqual([build, col, bad, "refused"]);
      }
      db.close();
    }
  });

  it("V85e v85 follows v84 and the chain has no gap", () => {
    const versions = migrations().map((m) => m.version);
    expect(versions.indexOf(85)).toBe(versions.indexOf(84) + 1);
    expect(Math.max(...versions)).toBe(85);
  });
});
