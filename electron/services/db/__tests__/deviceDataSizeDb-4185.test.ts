/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185: the worker's data-size counts, against a REAL encrypted
 * database built from schema.sql with the real driver (skipped where the
 * driver cannot load, like the other real-module suites).
 * Mutations: drop a user_id filter (the other user's rows are counted); drop
 * the mailbox / is_active filter (auth or inactive tokens are counted).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "4185".repeat(16);
const USER = "user-4185";
const OTHER = "user-other";

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[4185] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

maybe("BACKLOG-4185 deviceDataSize (real encrypted DB)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readDeviceDataSizeOn, DEVICE_DATA_SIZE_SQL } = require("../deviceDataSizeDb") as typeof import("../deviceDataSizeDb");
  let dir: string;
  let db: DatabaseType;

  beforeAll(() => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4185-"));
    db = new (Database as NonNullable<typeof Database>)(nodePath.join(dir, "mad.db"));
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8"));
    const addUser = db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)");
    for (const u of [USER, OTHER]) addUser.run(u, `${u}@example.test`, `oauth-${u}`);
    const msg = db.prepare(
      "INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, sent_at, metadata) VALUES (?, ?, 'sms', 'inbound', 'hi', '{}', '', ?, '{}')",
    );
    const contact = db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'x')");
    const ext = db.prepare("INSERT INTO external_contacts (id, user_id, name, external_record_id) VALUES (?, ?, 'x', ?)");
    const tok = db.prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose, is_active) VALUES (?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 7; i++) msg.run(`m${i}`, USER, new Date(1_700_000_000_000 + i).toISOString());
      for (let i = 0; i < 3; i++) msg.run(`o${i}`, OTHER, new Date(1_700_000_000_000 + i).toISOString());
      for (let i = 0; i < 4; i++) contact.run(`c${i}`, USER);
      contact.run("oc", OTHER);
      for (let i = 0; i < 5; i++) ext.run(`e${i}`, USER, `r${i}`);
      ext.run("oe", OTHER, "or");
      tok.run("t1", USER, "google", "mailbox", 1);
      tok.run("t2", USER, "microsoft", "mailbox", 0); // inactive
      tok.run("t3", USER, "google", "authentication", 1); // sign-in, not a mailbox
      tok.run("t4", OTHER, "google", "mailbox", 1);
    })();
  });

  afterAll(() => {
    db?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts only this user's rows, and only active mailbox tokens", () => {
    expect(readDeviceDataSizeOn(db, USER)).toEqual({ messages: 7, contacts: 4, addressBook: 5, mailAccounts: 1 });
    expect(readDeviceDataSizeOn(db, "nobody")).toEqual({ messages: 0, contacts: 0, addressBook: 0, mailAccounts: 0 });
  });

  it("every count is served by an index (no full table scan)", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${DEVICE_DATA_SIZE_SQL}`).all(USER, USER, USER, USER) as Array<{ detail: string }>).map((r) => r.detail);
    for (const t of ["messages", "contacts", "external_contacts", "oauth_tokens"]) {
      const line = plan.find((d) => new RegExp(`\\b${t}\\b`).test(d));
      expect({ t, line }).toEqual({ t, line: expect.stringMatching(/USING (COVERING )?INDEX/) });
    }
  });
});
