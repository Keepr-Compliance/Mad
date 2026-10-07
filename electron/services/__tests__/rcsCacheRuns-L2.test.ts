/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 L2 — the last cache run and the coverage it records, against
 * the REAL SQL on the production schema (run under Electron's Node).
 *
 * Mutations that turn this red:
 *   R1 the run not stored / not read back                      → "stored and read back"
 *   R2 the not-settled count hidden from the coverage          → "may be incomplete"
 *   R3 Force re-import leaving the run (and its count) behind   → "cleared"
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../permissionService", () => ({ __esModule: true, default: {} }));

import { setDb } from "../db/core/dbConnection";
import { clearRcsCacheRun, getRcsCacheRun, recordRcsCacheRun } from "../db/rcsCacheRunsDbService";
import { getSourceCoverage, recordSourceCoverage, sourceCoverageGaps } from "../auditCoverageService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-l2";
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-l2@example.test', 'google', 'oauth-l2')").run(USER);
  setDb(db);
});
afterEach(() => db?.close());

const RUN = {
  floorISO: "2026-07-01T00:00:00.000Z", fullRead: true, listStop: "stable", reachedFloor: true, notSettledChats: 3,
  finishedAt: "2026-10-02T07:05:00.000Z",
};

describe("the last cache run (L2)", () => {
  it("stored and read back; a second run replaces it (R1)", () => {
    expect(getRcsCacheRun(USER)).toBeNull();
    recordRcsCacheRun(USER, RUN);
    expect(getRcsCacheRun(USER)).toEqual(RUN);
    recordRcsCacheRun(USER, { ...RUN, notSettledChats: 0, listStop: "since" });
    expect(getRcsCacheRun(USER)).toMatchObject({ notSettledChats: 0, listStop: "since" });
  });

  it("coverage carries the not-settled count: \"may be incomplete\" (R2)", () => {
    recordSourceCoverage(USER, "google_messages", RUN.floorISO, RUN.finishedAt);
    recordRcsCacheRun(USER, RUN);
    const gm = getSourceCoverage(USER).find((c) => c.source === "google_messages");
    expect(gm).toMatchObject({ coveredSince: RUN.floorISO, incompleteChats: 3 });
    expect(sourceCoverageGaps(getSourceCoverage(USER), "2026-08-01T00:00:00.000Z", "google_messages")).toEqual([
      { source: "google_messages", coveredSince: RUN.floorISO, approximate: false, kind: "incomplete", incompleteChats: 3 },
    ]);
    // A run that did not reach its floor says nothing about completeness.
    recordRcsCacheRun(USER, { ...RUN, reachedFloor: false });
    expect(getSourceCoverage(USER).find((c) => c.source === "google_messages")?.incompleteChats).toBeUndefined();
  });

  it("cleared with the texts (R3)", () => {
    recordRcsCacheRun(USER, RUN);
    clearRcsCacheRun(USER);
    expect(getRcsCacheRun(USER)).toBeNull();
  });
});
