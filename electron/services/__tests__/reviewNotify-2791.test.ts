/**
 * @jest-environment node
 *
 * BACKLOG-2791 item 1 (service half) — every review MUTATION announces itself.
 *
 * The discovery sweep broadcast; approve, reject and restore wrote to the
 * database silently. So a reject-then-restore rewrote review state and left the
 * badge, the tab sections and the review screen showing mount-time data until
 * the transaction was reopened.
 *
 * These assert the broadcast at the seam that actually matters — the Electron
 * webContents send — rather than trusting that a function was called.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: Record<string, unknown>) =>
            sent.push({ channel, payload }),
        },
      },
    ],
  },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined) };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = { initialize: jest.fn().mockResolvedValue(undefined), getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false), getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}) };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  getReviewState,
  rejectReviewItems,
  approveReviewItems,
  restoreRejectedToQueue,
} from "../reviewStateService";

const USER = "u-n", TXN = "t-n";
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
             ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;`);
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')")
    .run(USER, "me@a.com");
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?,?,?)")
    .run(TXN, USER, "1 Test St");
  db.prepare("INSERT INTO emails (id, user_id, subject) VALUES ('e1', ?, 's')").run(USER);
  db.prepare(
    `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id)
     VALUES ('p1', ?, ?, 'e1')`,
  ).run(USER, TXN);
}

const changes = () => sent.filter((s) => s.channel === "review:queue-changed");

describe("every review mutation announces itself", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    sent.length = 0;
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });
  afterEach(async () => {
    try { await harness.cleanup(); } catch { /* already cleaned */ }
  });

  it("REJECT broadcasts, carrying the new outstanding total", async () => {
    const id = getReviewState(TXN).items[0].id;
    await rejectReviewItems([id]);

    const c = changes();
    expect(c).toHaveLength(1);
    expect(c[0].payload).toMatchObject({ transactionId: TXN, outstanding: 0, added: 0 });
  });

  it("RESTORE broadcasts — the founder's repro, where nothing used to move", async () => {
    const id = getReviewState(TXN).items[0].id;
    await rejectReviewItems([id]);
    sent.length = 0;

    const ignored = db
      .prepare("SELECT id FROM ignored_communications WHERE transaction_id = ?")
      .get(TXN) as { id: string };
    expect(await restoreRejectedToQueue(ignored.id)).toBe(true);

    const c = changes();
    expect(c).toHaveLength(1);
    // Back on the queue, and the surfaces are told the real number.
    expect(c[0].payload).toMatchObject({ outstanding: 1, added: 0 });
    expect(getReviewState(TXN).count).toBe(1);
  });

  it("APPROVE broadcasts", async () => {
    const id = getReviewState(TXN).items[0].id;
    await approveReviewItems([id]);

    expect(changes()).toHaveLength(1);
    expect(changes()[0].payload).toMatchObject({ outstanding: 0 });
  });

  it("a mutation never reports `added`, so it cannot re-fire the popup", async () => {
    const id = getReviewState(TXN).items[0].id;
    await rejectReviewItems([id]);
    for (const c of changes()) {
      expect(c.payload.added).toBe(0);
      expect(c.payload.linked).toBe(0);
    }
  });
});
