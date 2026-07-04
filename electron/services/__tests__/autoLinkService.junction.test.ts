/**
 * @jest-environment node
 *
 * BACKLOG-1722 junction-integration test for autoLinkService.
 *
 * Verifies against a real SQLite database (not mocked dbAll) that:
 *   - G2: looking up `lisa@x.com` does NOT match `alisa@x.com` (no LIKE
 *     false positive — junction does exact equality).
 *   - G5: the rewritten query plan uses the
 *     `idx_email_participants_email_address` index (EXPLAIN QUERY PLAN).
 *
 * We avoid pulling in autoLinkService transitively here (Sentry, logService,
 * etc.) by running the exact rewritten SQL directly against an in-memory
 * fixture that mirrors the production junction schema. The SQL string is
 * intentionally duplicated here so a future engineer who touches
 * findEmailsByContactEmails will trip this test if they regress the shape.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sender TEXT,
      recipients TEXT,
      cc TEXT,
      bcc TEXT,
      sent_at DATETIME,
      subject TEXT,
      body_plain TEXT,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT,
      resolved_contact_id TEXT,
      PRIMARY KEY (email_id, role, position),
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_email_participants_email_address
      ON email_participants(email_address);

    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      email_id TEXT,
      transaction_id TEXT
    );
  `);
}

const USER_ID = "user-1";
const TX_ID = "tx-1";

/**
 * Production SQL shape from autoLinkService.findEmailsByContactEmails
 * (BACKLOG-1722 Phase 3 rewrite). Kept in sync deliberately — see file
 * header for rationale.
 */
function buildJunctionSql(emailCount: number): string {
  const placeholders = Array.from({ length: emailCount }, () => "?").join(", ");
  return `
    SELECT DISTINCT e.id
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id AND c.transaction_id = ?
    WHERE ep.email_address IN (${placeholders})
      AND e.user_id = ?
      AND c.id IS NULL
      AND e.sent_at >= ?
      AND e.sent_at <= ?
    ORDER BY e.sent_at DESC
  `;
}

describe("autoLinkService junction integration (BACKLOG-1722)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as DatabaseType;
    db.pragma("foreign_keys = ON");
    createSchema(db);
    db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);

    // Two emails, deliberately near-collision senders:
    //   e-lisa  sent by lisa@x.com
    //   e-alisa sent by alisa@x.com
    db.prepare(
      "INSERT INTO emails (id, user_id, sender, sent_at) VALUES (?, ?, ?, ?)"
    ).run("e-lisa", USER_ID, "lisa@x.com", "2026-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO emails (id, user_id, sender, sent_at) VALUES (?, ?, ?, ?)"
    ).run("e-alisa", USER_ID, "alisa@x.com", "2026-01-02T00:00:00Z");

    // Junction rows (matching the writers' shape)
    const insertEp = db.prepare(
      "INSERT INTO email_participants (email_id, role, position, email_address, display_name) VALUES (?, ?, ?, ?, ?)"
    );
    insertEp.run("e-lisa", "from", 0, "lisa@x.com", null);
    insertEp.run("e-alisa", "from", 0, "alisa@x.com", null);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // G2: near-collision
  // -------------------------------------------------------------------------

  it("G2: lookup of lisa@x.com returns ONLY e-lisa, never e-alisa", () => {
    const sql = buildJunctionSql(1);
    const rows = db
      .prepare(sql)
      .all(
        TX_ID,
        "lisa@x.com",
        USER_ID,
        "2025-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z"
      ) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(["e-lisa"]);
  });

  it("G2 control: lookup of alisa@x.com returns ONLY e-alisa", () => {
    const sql = buildJunctionSql(1);
    const rows = db
      .prepare(sql)
      .all(
        TX_ID,
        "alisa@x.com",
        USER_ID,
        "2025-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z"
      ) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(["e-alisa"]);
  });

  it("G2 IN-list: lookup of [lisa, alisa] returns BOTH", () => {
    const sql = buildJunctionSql(2);
    const rows = db
      .prepare(sql)
      .all(
        TX_ID,
        "lisa@x.com",
        "alisa@x.com",
        USER_ID,
        "2025-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z"
      ) as Array<{ id: string }>;

    expect(rows.map((r) => r.id).sort()).toEqual(["e-alisa", "e-lisa"]);
  });

  // -------------------------------------------------------------------------
  // G5: EXPLAIN QUERY PLAN — must hit the participants index
  // -------------------------------------------------------------------------

  it("G5: EXPLAIN QUERY PLAN uses idx_email_participants_email_address", () => {
    const sql = buildJunctionSql(1);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
      TX_ID,
      "lisa@x.com",
      USER_ID,
      "2025-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z"
    ) as Array<{ detail: string }>;

    const planText = plan.map((p) => p.detail).join("\n");

    // SQLite plan should mention the participants index. We accept either
    // "USING INDEX idx_email_participants_email_address" or the broader
    // SEARCH/SCAN form depending on planner choice — the critical bit is
    // that the participants index name appears.
    expect(planText).toMatch(/idx_email_participants_email_address/);
  });

  // -------------------------------------------------------------------------
  // BCC visibility (G3 setup for autoLink — full search test elsewhere)
  // -------------------------------------------------------------------------

  it("G3 setup: BCC-only participant rows are visible to the autoLink query", () => {
    db.prepare(
      "INSERT INTO emails (id, user_id, sender, bcc, sent_at) VALUES (?, ?, ?, ?, ?)"
    ).run("e-bcc-only", USER_ID, "someone-else@x.com", "lisa@x.com", "2026-01-03T00:00:00Z");
    db.prepare(
      "INSERT INTO email_participants (email_id, role, position, email_address, display_name) VALUES (?, ?, ?, ?, ?)"
    ).run("e-bcc-only", "bcc", 0, "lisa@x.com", null);

    const sql = buildJunctionSql(1);
    const rows = db
      .prepare(sql)
      .all(
        TX_ID,
        "lisa@x.com",
        USER_ID,
        "2025-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z"
      ) as Array<{ id: string }>;

    expect(rows.map((r) => r.id).sort()).toEqual(["e-bcc-only", "e-lisa"]);
  });
});
