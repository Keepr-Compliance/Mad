/**
 * @jest-environment node
 */
/**
 * BACKLOG-3837 parity: planCommunicationDatesOn must equal the old
 * `participants_flat LIKE '%' || key || '%'` join at every boundary. The old SQL
 * below is the oracle (copied from the pre-3837 backfillContactCommunicationDates).
 * Corpus transcribed from the review sweep; contacts/messages are inserted
 * through the real schema.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import { planCommunicationDatesOn } from "../db/wizardMessageScansDb";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/x"), isPackaged: true } }));

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const OLD = `
    SELECT cp.contact_id, MAX(m.sent_at) as last_msg_date
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id AND c.user_id = ? AND c.is_imported = 1
    JOIN messages m ON (
      m.user_id = ?
      AND (m.channel = 'sms' OR m.channel = 'imessage')
      AND (m.associated_message_type IS NULL OR m.associated_message_type NOT BETWEEN 2000 AND 3005)
      AND m.participants_flat LIKE '%' || SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) || '%'
    )
    WHERE LENGTH(SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)) >= 7
    GROUP BY cp.contact_id`;

const U = "u1";
// [contactId, phone_e164[], imported?, user]
const CONTACTS: Array<[string, string[], number?, string?]> = [
  ["k7", ["+5550123"]], // key length exactly 7
  ["k6", ["+555012"]], // key length 6: excluded
  ["cc", ["+12125550101"]], // flat with and without country code
  ["fmt", ["+13125550102"]], // only a formatted flat exists: no match either way
  ["multi", ["+14155550103", "+16505550104"]], // several phones, max across them
  ["sub", ["+5550105"]], // 7-digit key that is a substring of longer numbers (over-match)
  ["intl", ["+442071234567"]], // longer than 10 digits: last 10
  ["grp", ["+17185550106"]], // only inside a comma list
  ["react", ["+17185550107"]], // only reactions
  ["rcs", ["+17185550108"]], // only rcs/email channel
  ["nulld", ["+17185550109"]], // only messages with NULL sent_at
  ["alpha", ["+ABCdefg12"]], // ASCII letters: case-insensitive both ways
  ["notimp", ["+17185550111"], 0], // not imported
  ["other", ["+17185550112"], 1, "u2"], // other user's contact
  ["under", ["+1718_550113"]], // LIKE wildcard in key (manual entry)
  ["pct", ["+1718%550114"]], // LIKE wildcard in key
  ["uni", ["+ÄBC12345"]], // non-ASCII letter
  ["dash", ["+1 (917) 555-0115"]], // stripped punctuation in key
  ["dot", ["917.555.0116"]], // '.' not stripped
  ["mail", ["+Alice@Exa"]], // email-handle flat, mixed case key
  ["wild", ["+AB%12345"]], // wildcard AND ASCII capitals in one key
  ["nodate", ["+17185550117"]], // matched only by an empty flat's neighbour: no match
  ["unilow", ["+äbc7654321"]], // lowercase non-ASCII key vs uppercase non-ASCII flat: no match
];
// [flat, sent_at, channel, amt, user]
const MSGS: Array<[string | null, unknown, string, number | null, string?]> = [
  ["5550123", "2024-01-01T00:00:00.000Z", "sms", null],
  ["555012", "2024-01-02T00:00:00.000Z", "sms", null],
  ["12125550101", "2024-01-03T00:00:00.000Z", "imessage", null],
  ["2125550101", "2024-01-04T00:00:00.000Z", "sms", null],
  ["+1 (312) 555-0102", "2024-01-05T00:00:00.000Z", "sms", null],
  ["14155550103", "2024-01-06T00:00:00.000Z", "sms", null],
  ["16505550104", "2024-01-07T00:00:00.000Z", "imessage", null],
  ["15550105999", "2024-01-08T00:00:00.000Z", "sms", null],
  ["2125550105", "2024-01-09T00:00:00.000Z", "sms", null],
  ["442071234567", "2024-01-10T00:00:00.000Z", "sms", null],
  ["2071234567", "2024-01-11T00:00:00.000Z", "sms", null],
  ["19175550199,17185550106,alice@example.com", "2024-01-12T00:00:00.000Z", "imessage", null],
  ["17185550107", "2024-01-13T00:00:00.000Z", "imessage", 2000],
  ["17185550107", "2024-01-13T00:00:00.000Z", "imessage", 3005],
  
  ["17185550108", "2024-01-14T00:00:00.000Z", "email", null],
  ["17185550109", null, "sms", null],
  ["xxabcDEFG12", "2024-01-15T00:00:00.000Z", "sms", null],
  ["17185550111", "2024-01-16T00:00:00.000Z", "sms", null],
  ["17185550112", "2024-01-17T00:00:00.000Z", "sms", null, "u2"],
  ["17185550112", "2024-01-17T00:00:00.000Z", "sms", null],
  ["17189550113", "2024-01-18T00:00:00.000Z", "sms", null], // '_' would match '9'
  ["1718999550114", "2024-01-19T00:00:00.000Z", "sms", null], // '%' would match '99'
  ["äbc12345", "2024-01-20T00:00:00.000Z", "sms", null],
  ["19175550115", "2024-01-21T00:00:00.000Z", "sms", null],
  ["917.555.0116", "2024-01-22T00:00:00.000Z", "sms", null],
  ["", "2024-01-23T00:00:00.000Z", "sms", null],
  [null, "2024-01-24T00:00:00.000Z", "sms", null],
  ["Alice@Example.com", "2024-01-25T00:00:00.000Z", "imessage", null],
  ["abxx12345", "2024-01-26T00:00:00.000Z", "sms", null], // '%' matches 'xx'; case-insensitive
  ["ABxx12345", "2024-01-27T00:00:00.000Z", "sms", null],
  ["ÄBC7654321", "2024-01-26T00:00:00.000Z", "sms", null], // toLowerCase would fold Ä to ä and match "unilow"
];

let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require(DRIVER);
  new Database(":memory:").close();
} catch {
  Database = null;
}
(Database ? describe : describe.skip)("BACKLOG-3837 backfill parity with the old LIKE join", () => {
  it("every boundary: same contacts, same dates", () => {
    const db = new Database(":memory:");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    for (const u of [U, "u2"]) {
      db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(u, `${u}@example.test`, `o-${u}`);
    }
    let p = 0;
    for (const [id, phones, imp = 1, user = U] of CONTACTS) {
      db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported, source) VALUES (?, ?, ?, ?, 'contacts_app')").run(id, user, id, imp);
      for (const ph of phones) {
        db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary, source) VALUES (?, ?, ?, 1, 'import')").run(`p${p++}`, id, ph);
      }
    }
    let i = 0;
    for (const [flat, sent, channel, amt, user = U] of MSGS) {
      db.prepare(
        "INSERT INTO messages (id, user_id, channel, external_id, direction, participants_flat, sent_at, associated_message_type) VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?)",
      ).run(`m${i}`, user, channel, `e${i++}`, flat, sent, amt);
    }
    const oldRows = db.prepare(OLD).all(U, U) as Array<{ contact_id: string; last_msg_date: unknown }>;
    const newRows = planCommunicationDatesOn(db, U);
    // A NULL-dated match changes no data (the UPDATE sets NULL over NULL); the plan omits it by design.
    const o = new Map(oldRows.filter((r) => r.last_msg_date !== null).map((r) => [r.contact_id, r.last_msg_date]));
    const n = new Map<string, unknown>(newRows.map((r) => [r.contact_id, r.last_msg_date]));
    const ids = Array.from(new Set([...o.keys(), ...n.keys()])).sort();
    const diffs = ids.filter((id) => o.get(id) !== n.get(id)).map((id) => `${id}: old=${String(o.get(id))} new=${String(n.get(id))}`);
    // Non-vacuous: the oracle itself matches the quirky keys, and rejects the ones it must.
    expect(o.size).toBeGreaterThan(5);
    for (const id of ["under", "pct", "wild", "mail", "k7", "cc", "intl"]) expect(o.has(id)).toBe(true);
    for (const id of ["k6", "uni", "fmt", "react", "rcs", "notimp", "other", "nodate", "unilow"]) expect(o.has(id)).toBe(false);
    expect(diffs).toEqual([]);
  });
});
