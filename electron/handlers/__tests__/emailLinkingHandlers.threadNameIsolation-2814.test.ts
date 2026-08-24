/**
 * @jest-environment node
 *
 * BACKLOG-2814 — the "Show removed" loader must not leak another user's group name.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `transactions:get-removed-messages` LEFT JOINs `message_thread_names` to put
 * the group's name on a removed conversation card. The join key is
 * `(thread_id, user_id)` because the table's PK is `(user_id, thread_id)` and
 * macOS thread ids ("macos-chat-<ROWID>") are only unique PER MACHINE — two
 * users of one database can legitimately hold the same thread_id.
 *
 * I originally reported the untested joins as degrading "silently to the
 * participant fallback". THAT WAS WRONG, and the SR proved it by mutation
 * rather than by reading: with the user half of the predicate replaced by
 * `1=1`, 22 suites and 141 tests stayed GREEN while one user's group chat name
 * rendered on another user's thread. That is not a missing label. It is a data
 * isolation failure, and nothing in the repo noticed.
 *
 * So this drives the REAL registered IPC handler — not a copy of its SQL —
 * against a REAL database, and asserts the negative: the other user's name is
 * never in the output.
 *
 * CONTROL (run, measured): replace `tn.user_id = m.user_id` with `1=1` in
 * emailLinkingHandlers.ts -> the isolation test below goes RED and only it.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Collaborators the module imports but this handler never touches.
jest.mock("../../services/transactionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/emailDbService", () => ({
  createEmail: jest.fn(), getEmailById: jest.fn(),
  getEmailByExternalId: jest.fn(), getCachedEmails: jest.fn(),
}));
jest.mock("../../services/db/communicationDbService", () => ({
  createCommunication: jest.fn(), removeIgnoredCommunication: jest.fn(),
  confirmEmailLinksByEmailIds: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../../services/db/core/dbConnection";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TXN = "33333333-3333-4333-8333-333333333333";
const THREAD = "macos-chat-1";
const MY_NAME = "Closing Team";
const THEIR_NAME = "Their Group";

let db: DatabaseType;

function seed(): void {
  db.exec(SCHEMA);
  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  );
  insertUser.run(USER, "me@example.test", "o-me");
  insertUser.run(OTHER_USER, "them@example.test", "o-them");

  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)",
  ).run(TXN, USER, "1 Test St");

  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text,
                           participants, participants_flat, thread_id, sent_at)
     VALUES ('m-1', ?, 'imessage', 'inbound', 'hello', ?, '15550100', ?, '2026-01-01T10:00:00.000Z')`,
  ).run(
    USER,
    JSON.stringify({
      from: "+15550100",
      to: ["me"],
      chat_members: ["+15550100", "+15550101", "+15550102"],
    }),
    THREAD,
  );

  // The conversation was REMOVED — this is what "Show removed" reads.
  db.prepare(
    `INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, reason, ignored_at)
     VALUES ('ic-1', ?, ?, ?, 'user_removed', '2026-01-02T10:00:00.000Z')`,
  ).run(USER, TXN, THREAD);
}

function addName(userId: string, name: string): void {
  db.prepare(
    "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)",
  ).run(userId, THREAD, name);
}

async function getRemoved(): Promise<Array<{ thread_display_name?: string | null }>> {
  const fn = handlers.get("transactions:get-removed-messages");
  if (!fn) throw new Error("handler not registered");
  const res = (await fn({}, TXN)) as {
    success: boolean;
    removedMessages: Array<{ thread_display_name?: string | null }>;
  };
  expect(res.success).toBe(true);
  return res.removedMessages;
}

beforeEach(() => {
  handlers.clear();
  db = new Database(":memory:") as unknown as DatabaseType;
  seed();
  setDb(db);
  registerEmailLinkingHandlers();
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  db?.close();
});

describe("BACKLOG-2814 — removed-messages loader, group name isolation", () => {
  it("returns THIS user's group name on their removed thread", async () => {
    addName(USER, MY_NAME);

    const rows = await getRemoved();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_display_name).toBe(MY_NAME);
  });

  it("NEVER returns another user's name for the same thread id", async () => {
    // THE ISOLATION TEST. Only the OTHER user has named this thread. The rows
    // belong to USER, so the name must not appear — not as a fallback, not at
    // all. Replace `tn.user_id = m.user_id` with `1=1` and this reds alone.
    addName(OTHER_USER, THEIR_NAME);

    const rows = await getRemoved();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_display_name ?? null).toBeNull();

    // Stated as a negative over the WHOLE payload, so a future column that
    // carries the name by another route is caught too.
    expect(JSON.stringify(rows)).not.toContain(THEIR_NAME);
  });

  it("returns this user's name and not the other's when BOTH exist", async () => {
    addName(USER, MY_NAME);
    addName(OTHER_USER, THEIR_NAME);

    const rows = await getRemoved();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_display_name).toBe(MY_NAME);
    expect(JSON.stringify(rows)).not.toContain(THEIR_NAME);
  });

  it("returns the removed row with no name when nobody has named the thread", async () => {
    const rows = await getRemoved();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_display_name ?? null).toBeNull();
  });
});
