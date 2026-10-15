/**
 * @jest-environment node
 *
 * BACKLOG-3868 (create freeze): linking a contact's chats to a new deal recounts the
 * deal's text threads after every thread link. At 108 chats that was one 300+ ms block on
 * a Mac (~4x on the founder's PC). autoLinkCommunicationsForContact now gives the event
 * loop a turn every AUTO_LINK_THREADS_PER_TURN thread links.
 *
 * REAL schema.sql, real driver: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <file>
 * Reserved 555-01xx numbers, .test addresses.
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import { AUTO_LINK_THREADS_PER_TURN, autoLinkCommunicationsForContact } from "../autoLinkService";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3868] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "38680000-0000-4000-8000-0000000000aa"; // pii-allow-uuid: invented, not from any live row
const TXN = "38680000-0000-4000-8000-0000000000bb"; // pii-allow-uuid: invented, not from any live row
const PHONE = "+12065550103";
const CHATS = 24;

maybe("autoLinkCommunicationsForContact yields while it links chats (BACKLOG-3868)", () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, '1 Probe Way', 'active', '2020-01-01T00:00:00Z')").run(TXN, USER);
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c1', ?, 'Party', 'manual')").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('cp1', 'c1', ?, ?)").run(PHONE, PHONE.replace(/\D/g, ""));
    db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('tc1', ?, 'c1')").run(TXN);
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, 'imessage', 'inbound', ?, ?, ?, '2025-01-01T00:00:00Z', 'text')`,
    );
    // one contact, CHATS chat ids (macOS writes a new chat id per service / handle variant)
    for (let t = 0; t < CHATS; t++) {
      ins.run(`m${t}`, USER, `g${t}`, JSON.stringify({ from: PHONE, to: ["+19995550100"] }), "12065550103,19995550100", `macos-chat-${t}`);
    }
    setDb(db);
  });
  afterEach(() => db.close());

  it(`links every chat and gives the event loop at least one turn per ${AUTO_LINK_THREADS_PER_TURN} chats`, async () => {
    let turns = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const res = await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    running = false;
    const linked = db.prepare("SELECT thread_id FROM communications WHERE transaction_id = ? ORDER BY thread_id").all(TXN) as Array<{ thread_id: string }>;
    expect(res.messagesLinked).toBe(CHATS);
    expect(linked).toHaveLength(CHATS);
    expect(turns).toBeGreaterThanOrEqual(Math.floor(CHATS / AUTO_LINK_THREADS_PER_TURN));
  });
});
