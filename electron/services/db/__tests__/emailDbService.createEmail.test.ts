/**
 * @jest-environment node
 *
 * Integration test for emailDbService.createEmail with the BACKLOG-1722
 * `participants` parameter.
 *
 * Verifies:
 *   1. createEmail without participants writes the email row and emits a
 *      Sentry breadcrumb (no junction rows written).
 *   2. createEmail with participants writes email + N junction rows atomically.
 *   3. The participant write preserves order (position) and role.
 *
 * Uses a real in-memory better-sqlite3 driver via the same shim used in
 * phoneNormalizedJoin.test.ts (jest moduleNameMapper bypass).
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Mocks must come before importing the SUT.
const breadcrumbSpy = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: (...args: unknown[]) => breadcrumbSpy(...args),
  captureException: jest.fn(),
}));

import { setDb } from "../core/dbConnection";
import { createEmail } from "../emailDbService";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      external_id TEXT,
      source TEXT,
      account_id TEXT,
      direction TEXT,
      subject TEXT,
      body_plain TEXT,
      body_html TEXT,
      sender TEXT,
      recipients TEXT,
      cc TEXT,
      bcc TEXT,
      thread_id TEXT,
      in_reply_to TEXT,
      references_header TEXT,
      sent_at DATETIME,
      received_at DATETIME,
      has_attachments INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0,
      message_id_header TEXT,
      content_hash TEXT,
      labels TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT,
      resolved_contact_id TEXT,
      PRIMARY KEY (email_id, role, position),
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_email_participants_email_address ON email_participants(email_address);
  `);
}

describe("emailDbService.createEmail + participants (BACKLOG-1722)", () => {
  let db: DatabaseType;
  const USER_ID = "user-create-email-test";

  beforeEach(() => {
    db = new Database(":memory:") as DatabaseType;
    db.pragma("foreign_keys = ON");
    createSchema(db);
    db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    setDb(db);
    breadcrumbSpy.mockClear();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    setDb(null as unknown as DatabaseType);
  });

  it("writes email row without participants and emits a Sentry breadcrumb", async () => {
    await createEmail({
      user_id: USER_ID,
      sender: "alice@x.com",
      subject: "no-participants smoke test",
    });

    const count = (db.prepare("SELECT COUNT(*) as c FROM emails").get() as { c: number }).c;
    expect(count).toBe(1);

    const partCount = (
      db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    expect(partCount).toBe(0);

    expect(breadcrumbSpy).toHaveBeenCalledTimes(1);
    const call = breadcrumbSpy.mock.calls[0][0] as { category: string; message: string };
    expect(call.category).toBe("email.create");
    expect(call.message).toMatch(/without participants/i);
  });

  it("writes email + junction rows atomically when participants are provided", async () => {
    const result = await createEmail({
      user_id: USER_ID,
      sender: "Alice <alice@x.com>",
      recipients: "bob@y.com, carol@z.com",
      subject: "with-participants",
      participants: [
        { email_address: "alice@x.com", display_name: "Alice", role: "from", position: 0 },
        { email_address: "bob@y.com", display_name: null, role: "to", position: 0 },
        { email_address: "carol@z.com", display_name: null, role: "to", position: 1 },
      ],
    });

    expect(result.id).toBeTruthy();
    expect(breadcrumbSpy).not.toHaveBeenCalled();

    const rows = db
      .prepare(
        `SELECT email_id, role, position, email_address, display_name
         FROM email_participants WHERE email_id = ? ORDER BY role, position`,
      )
      .all(result.id) as Array<{
        email_id: string;
        role: string;
        position: number;
        email_address: string;
        display_name: string | null;
      }>;

    expect(rows).toEqual([
      { email_id: result.id, role: "from", position: 0, email_address: "alice@x.com", display_name: "Alice" },
      { email_id: result.id, role: "to", position: 0, email_address: "bob@y.com", display_name: null },
      { email_id: result.id, role: "to", position: 1, email_address: "carol@z.com", display_name: null },
    ]);
  });

  it("treats lisa@x.com and alisa@x.com as DISTINCT participant rows (G2)", async () => {
    const e1 = await createEmail({
      user_id: USER_ID,
      sender: "lisa@x.com",
      recipients: "alisa@x.com",
      participants: [
        { email_address: "lisa@x.com", display_name: null, role: "from", position: 0 },
        { email_address: "alisa@x.com", display_name: null, role: "to", position: 0 },
      ],
    });

    const addrs = (
      db
        .prepare(
          "SELECT email_address FROM email_participants WHERE email_id = ? ORDER BY email_address",
        )
        .all(e1.id) as Array<{ email_address: string }>
    ).map((r) => r.email_address);

    expect(addrs).toEqual(["alisa@x.com", "lisa@x.com"]);
  });
});
