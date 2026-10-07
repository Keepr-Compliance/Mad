/**
 * @jest-environment node
 */
/**
 * BACKLOG-3663 — per-source text coverage, on the REAL schema (run under
 * Electron's Node locally).
 *
 * Mutation controls (each turns a test red):
 *   V1 sources not told apart (one global floor)                 → "per source"
 *   V2 Google Messages coverage taken from its oldest text        → "Google Messages: recorded only"
 *   V3 covered_since moved LATER by a later run                   → "covered_since only moves earlier"
 *   V4 Mac not using the import depth                             → "Mac: the import depth"
 *   V5 a source the user neither chose nor has texts from warned  → "gaps: only relevant sources"
 *   V6 no tolerance / wrong direction                             → "gaps: only relevant sources"
 *   V7 malformed metadata breaks the read                         → "per source"
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
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../permissionService", () => ({ __esModule: true, default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: false })) } }));

import { setDb } from "../db/core/dbConnection";
import {
  forgetSourceCoverage,
  getSourceCoverage,
  getTransactionTextCoverage,
  recordSourceCoverage,
  sourceCoverageGaps,
} from "../auditCoverageService";
import type { SourceCoverage } from "../../types/auditCoverage";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3663";
let db: DatabaseType;
let n = 0;

function text(source: string | null, sentAt: string, opts: { raw?: string } = {}): void {
  n += 1;
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, sent_at, metadata)
     VALUES (?, ?, 'sms', ?, 'inbound', 'x', ?, ?)`,
  ).run(`m${n}`, USER, `ext-${n}`, sentAt, opts.raw ?? (source ? JSON.stringify({ source }) : null));
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3663@example.test', 'google', 'oauth-3663')").run(USER);
  setDb(db);
});

afterEach(() => db?.close());

const by = (c: SourceCoverage[], s: string) => c.find((x) => x.source === s);

describe("getSourceCoverage", () => {
  it("per source: iPhone and the companion from their oldest text (approximate); malformed metadata is ignored (V1, V7)", () => {
    text("iphone_sync", "2026-03-01T10:00:00.000Z");
    text("iphone_sync", "2026-06-01T10:00:00.000Z");
    text("android_wifi_sync", "2026-08-01T10:00:00.000Z");
    text(null, "2025-01-01T10:00:00.000Z", { raw: "{not json" });
    const c = getSourceCoverage(USER);
    expect(by(c, "iphone")).toMatchObject({ coveredSince: "2026-03-01T10:00:00.000Z", approximate: true, hasRows: true });
    expect(by(c, "android_companion")).toMatchObject({ coveredSince: "2026-08-01T10:00:00.000Z", approximate: true });
    expect(by(c, "mac")).toBeUndefined();
  });

  it("Google Messages: recorded only — its texts alone do not prove coverage (V2)", () => {
    text("gmweb-cache", "2026-01-01T10:00:00.000Z");
    expect(by(getSourceCoverage(USER), "google_messages")).toMatchObject({ coveredSince: null, approximate: false, hasRows: true });
    recordSourceCoverage(USER, "google_messages", "2026-07-01T00:00:00.000Z", "2026-10-01T10:00:00.000Z");
    expect(by(getSourceCoverage(USER), "google_messages")).toMatchObject({
      coveredSince: "2026-07-01T00:00:00.000Z", lastSyncAt: "2026-10-01T10:00:00.000Z",
    });
    forgetSourceCoverage(USER, "google_messages");
    expect(by(getSourceCoverage(USER), "google_messages")?.coveredSince).toBeNull();
  });

  it("covered_since only moves earlier; a run that did not reach its floor (null) keeps it (V3)", () => {
    recordSourceCoverage(USER, "google_messages", "2026-07-01T00:00:00.000Z", "2026-10-01T10:00:00.000Z");
    recordSourceCoverage(USER, "google_messages", "2026-08-01T00:00:00.000Z", "2026-10-02T10:00:00.000Z");
    recordSourceCoverage(USER, "google_messages", null, "2026-10-03T10:00:00.000Z");
    expect(by(getSourceCoverage(USER), "google_messages")).toMatchObject({
      coveredSince: "2026-07-01T00:00:00.000Z", lastSyncAt: "2026-10-03T10:00:00.000Z",
    });
    recordSourceCoverage(USER, "google_messages", "2026-04-01T00:00:00.000Z", "2026-10-04T10:00:00.000Z");
    expect(by(getSourceCoverage(USER), "google_messages")?.coveredSince).toBe("2026-04-01T00:00:00.000Z");
  });

  it("Mac: the import depth (exact), not its oldest text (V4)", () => {
    text("macos_messages", "2026-06-01T10:00:00.000Z");
    expect(by(getSourceCoverage(USER), "mac")).toMatchObject({ coveredSince: "2026-06-01T10:00:00.000Z", approximate: true });
    db.prepare("INSERT INTO message_import_state (user_id, deepest_import_start) VALUES (?, '2025-12-01T00:00:00.000Z')").run(USER);
    expect(by(getSourceCoverage(USER), "mac")).toMatchObject({ coveredSince: "2025-12-01T00:00:00.000Z", approximate: false });
  });
});

describe("gaps for a transaction", () => {
  const cov: SourceCoverage[] = [
    { source: "iphone", coveredSince: "2026-03-01T00:00:00.000Z", lastSyncAt: null, approximate: true, hasRows: true },
    { source: "google_messages", coveredSince: "2026-07-01T00:00:00.000Z", lastSyncAt: null, approximate: false, hasRows: true },
  ];

  it("gaps: only relevant sources (chosen or with texts); a day of tolerance (V5, V6)", () => {
    expect(sourceCoverageGaps(cov, "2026-06-01T00:00:00.000Z", null)).toEqual([
      { source: "google_messages", coveredSince: "2026-07-01T00:00:00.000Z", approximate: false, kind: "later" },
    ]);
    expect(sourceCoverageGaps(cov, "2026-06-30T12:00:00.000Z", null)).toEqual([]); // within a day
    // The chosen source with nothing yet → "never"; an unchosen source with no texts → nothing.
    expect(sourceCoverageGaps(cov, "2026-08-01T00:00:00.000Z", "android_companion")).toEqual([
      { source: "android_companion", coveredSince: null, approximate: false, kind: "never" },
    ]);
    expect(sourceCoverageGaps(cov, null, "mac")).toEqual([]);
  });

  it("getTransactionTextCoverage: the transaction's audit start, live deals only", () => {
    text("android_wifi_sync", "2026-08-01T10:00:00.000Z");
    db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, status) VALUES ('tx-1', ?, '1 Test Street', '2026-05-01', 'active')").run(USER);
    db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, status) VALUES ('tx-2', ?, '2 Test Street', '2026-05-01', 'rejected')").run(USER);
    const r = getTransactionTextCoverage("tx-1", USER, "android_companion");
    expect(r.success).toBe(true);
    expect(r.gaps).toEqual([{ source: "android_companion", coveredSince: "2026-08-01T10:00:00.000Z", approximate: true, kind: "later" }]);
    expect(getTransactionTextCoverage("tx-2", USER, "android_companion").gaps).toEqual([]);
  });
});
