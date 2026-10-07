/**
 * @jest-environment node
 */
/**
 * SR M — Google Messages media options, REAL SQL (run under Electron's Node).
 *
 * Mutations that turn this red:
 *   M1 the defaults not photos ON / videos OFF            → "defaults"
 *   M2 a toggle switched ON not marking the media read    → "switched ON"
 *   M3 switching OFF (or re-saving ON) marking it         → "switched ON"
 *   M4 the last-seen counts not kept apart from the toggles → "counts"
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

import { setDb } from "../db/core/dbConnection";
import {
  clearPendingMediaRead,
  getRcsMediaOptions,
  hasPendingMediaRead,
  recordRcsMediaSeen,
  setRcsMediaOptions,
} from "../db/rcsMediaDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-media";
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-media@example.test', 'google', 'oauth-media')").run(USER);
  setDb(db);
});
afterEach(() => db?.close());

describe("Google Messages media options (SR M)", () => {
  it("defaults: photos from all chats ON, videos OFF, nothing pending (M1)", () => {
    expect(getRcsMediaOptions(USER)).toEqual({ photosAllChats: true, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null });
    expect(hasPendingMediaRead(USER)).toBe(false);
  });

  it("a toggle switched ON marks the next Sync's media read; OFF and re-saving do not; the commit clears it (M2, M3)", () => {
    setRcsMediaOptions(USER, { photosAllChats: true }); // already on (the default): no read
    expect(hasPendingMediaRead(USER)).toBe(false);
    setRcsMediaOptions(USER, { photosAllChats: false });
    expect(hasPendingMediaRead(USER)).toBe(false);
    setRcsMediaOptions(USER, { photosAllChats: true });
    expect(hasPendingMediaRead(USER)).toBe(true);
    clearPendingMediaRead(USER);
    setRcsMediaOptions(USER, { videosAllChats: true });
    expect(hasPendingMediaRead(USER)).toBe(true);
    expect(getRcsMediaOptions(USER)).toMatchObject({ photosAllChats: true, videosAllChats: true });
  });

  // SR (G1): the toggles and the pending media read in one transaction.
  // Mutation: no dbTransaction → red (the toggle saved without its read).
  it("a failed pending-read write leaves the toggles as they were", () => {
    db.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON rcs_pending_media BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    expect(() => setRcsMediaOptions(USER, { videosAllChats: true })).toThrow("disk I/O error");
    expect(getRcsMediaOptions(USER).videosAllChats).toBe(false);
    expect(hasPendingMediaRead(USER)).toBe(false);
  });

  it("the last Sync's counts are kept apart from the toggles (M4)", () => {
    setRcsMediaOptions(USER, { videosAllChats: true });
    recordRcsMediaSeen(USER, 40, 6);
    expect(getRcsMediaOptions(USER)).toEqual({ photosAllChats: true, videosAllChats: true, lastPhotosSeen: 40, lastVideosSeen: 6 });
  });
});
