/**
 * @jest-environment node
 *
 * BACKLOG-2814 — the review surfaces must not leak another user's group name.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `threadDisplay` builds the per-message rows the review card renders, and it
 * LEFT JOINs `message_thread_names` for the group's name. The join key is
 * `(thread_id, user_id)`: the table's PK is `(user_id, thread_id)`, and macOS
 * thread ids ("macos-chat-<ROWID>") are unique only PER MACHINE, so two users
 * of one database can hold the same thread_id.
 *
 * I originally reported this join as untested-but-harmless, degrading "silently
 * to the participant fallback". THAT WAS WRONG. The SR mutated instead of
 * reading: with the user half replaced by `1=1`, 12 suites and 68 tests stayed
 * GREEN while one user's group chat name rendered on another user's review
 * card. Not a missing label — a data isolation failure with no detector.
 *
 * So this drives the REAL `getReviewState` — not a copy of the SQL — against a
 * REAL database, and asserts the negative.
 *
 * WHY A PENDING TEXT ROW IS INSERTED DIRECTLY: after the founder's 2026-08-22
 * ruling texts ALWAYS auto-link and never queue, so a discovery sweep cannot
 * produce one. The isolation rule still has to hold for any pending text that
 * exists — rows queued by an earlier build, and anything a future change
 * queues — so it is tested on the row itself, exactly as the 2791 text
 * side-door suite does.
 *
 * CONTROL (run, measured): replace `tn.user_id = m.user_id` with `1=1` in
 * reviewStateService.ts -> the isolation test below goes RED and only it.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn(),
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
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(), isPoolReady: jest.fn(() => false),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { getReviewState } from "../reviewStateService";

const USER = "u-2814";
const OTHER_USER = "u-2814-other";
const TXN = "t-2814";
const THREAD = "macos-chat-1";
const MY_NAME = "Closing Team";
const THEIR_NAME = "Their Group";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");
const V64_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;`;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V64_INDEXES);
  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google',?)",
  );
  insertUser.run(USER, "me@example.test", "o-me");
  insertUser.run(OTHER_USER, "them@example.test", "o-them");

  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)",
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text,
                           participants, participants_flat, thread_id, sent_at, created_at)
     VALUES ('m-1', ?, 'imessage', 'inbound', 'hello', ?, '15550100', ?,
             '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(
    USER,
    JSON.stringify({
      from: "+15550100",
      to: ["me"],
      chat_members: ["+15550100", "+15550101", "+15550102"],
    }),
    THREAD,
  );

  db.prepare(
    `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id, thread_id)
     VALUES ('p-text', ?, ?, NULL, ?)`,
  ).run(USER, TXN, THREAD);
}

function addName(db: DatabaseType, userId: string, name: string): void {
  db.prepare(
    "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)",
  ).run(userId, THREAD, name);
}

function threadNames(db: DatabaseType): Array<string | null> {
  const item = getReviewState(TXN).items[0];
  expect(item.kind).toBe("text");
  return item.display.threadMessages.map((m) => m.thread_display_name);
}

describe("BACKLOG-2814 — review surfaces, group name isolation", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* already cleaned */
    }
  });

  it("carries THIS user's group name onto the review card", async () => {
    addName(db, USER, MY_NAME);
    expect(threadNames(db)).toEqual([MY_NAME]);
  });

  it("NEVER carries another user's name for the same thread id", async () => {
    // THE ISOLATION TEST. Only the OTHER user has named this thread; the
    // messages belong to USER. Replace `tn.user_id = m.user_id` with `1=1` and
    // this reds alone.
    addName(db, OTHER_USER, THEIR_NAME);

    expect(threadNames(db)).toEqual([null]);

    // Negative over the whole rendered item, so a future field carrying the
    // name by another route is caught too.
    expect(JSON.stringify(getReviewState(TXN).items[0])).not.toContain(THEIR_NAME);
  });

  it("carries this user's name and not the other's when BOTH exist", async () => {
    addName(db, USER, MY_NAME);
    addName(db, OTHER_USER, THEIR_NAME);

    expect(threadNames(db)).toEqual([MY_NAME]);
    expect(JSON.stringify(getReviewState(TXN).items[0])).not.toContain(THEIR_NAME);
  });

  it("renders the card with no name when nobody has named the thread", async () => {
    expect(threadNames(db)).toEqual([null]);
  });

  it("still carries the participants JSON the card needs to detect a group", async () => {
    // The name is only reachable on a card that renders as a GROUP, and group
    // detection reads `participants` (not participants_flat). That column was
    // absent from this projection before BACKLOG-2814, which is why the name
    // would have been joined in and then never displayed.
    addName(db, USER, MY_NAME);
    const msg = getReviewState(TXN).items[0].display.threadMessages[0];
    expect(msg.participants).toBeTruthy();
    expect(JSON.parse(msg.participants as string).chat_members).toHaveLength(3);
  });
});
