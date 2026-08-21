/**
 * @jest-environment node
 *
 * MIGRATION v64 — RE-KEY THE PERSISTED PHONE LOOKUP KEYS (BACKLOG-2753)
 *
 * ===========================================================================
 * WHAT THIS PROVES, AND WHY THE FAILING HALF IS THE POINT
 * ===========================================================================
 * BACKLOG-2635 (PR #2325) changed `toLookupKey` so an Israeli number stored
 * domestically and the same number stored E.164 land on ONE key. The key is
 * PERSISTED in three stores, so every row already on disk carries the OLD key.
 *
 * Test 1 below runs the REAL contact-search SQL against a database whose rows
 * were written under the old rule, with the new rule computing the needle, and
 * asserts the contact is NOT FOUND. That is the regression this migration
 * exists to prevent, reproduced rather than described. Test 2 applies v64 to
 * the same database and asserts the same search now finds it.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE — THE OLD KEYS ARE NOT INVENTED
 * ===========================================================================
 * Old-rule keys are produced by `v40Key` below, a FROZEN transcription of the
 * rule that shipped, taken from
 *     git show 25fe2f4e1:electron/utils/phoneNormalization.ts   (lines 86-95)
 * — the develop commit this branch is based on, i.e. the code that wrote the
 * rows on the founder's disk. It is frozen rather than imported for the reason
 * PR #2325 gives for its own v40 parity table: importing the live function
 * would make the fixture follow the fix and the test could never go red.
 *
 * `frozen(raw) !== live(raw)` is asserted for every Israeli seed, so a fixture
 * that silently became new-shape fails loudly instead of passing vacuously.
 *
 * Keys are never written as literals: `check:pii` rejects sliced pseudo-US keys
 * (they read as real numbers), and a literal would drift. Every expectation is
 * computed from the frozen or the live rule at run time.
 *
 * All numbers are reserved `555-01xx` subscriber ranges inside synthetic
 * national/international shells. Nothing here is dialable.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// Bypass the Jest moduleNameMapper that rewrites the driver to the auto-mock —
// this file is about real SQL, real PRIMARY KEY collisions and a real UPDATE.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { toLookupKey } from "../../utils/phoneNormalization";
import { LOCAL_REACTION_EXCLUSION } from "../db/reactionExclusion";

// ---------------------------------------------------------------------------
// The migration under test, taken from the real chain (not a copy).
// ---------------------------------------------------------------------------

// The module's default export is the singleton INSTANCE; MIGRATIONS is a static
// on its class, reached through the constructor — the same route
// databaseService.onDiskUpgrade.test.ts uses (:597).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const serviceSingleton = require("../databaseService").default as object;
const DatabaseService = serviceSingleton.constructor as unknown as {
  MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }>;
};

const V64 = (
  DatabaseService.MIGRATIONS as Array<{
    version: number;
    description: string;
    migrate: (d: DatabaseType) => void;
  }>
).find((m) => m.version === 64);

/**
 * The SHIPPED lookup rule, frozen. Transcribed verbatim from
 * `git show 25fe2f4e1:electron/utils/phoneNormalization.ts` (toLookupKey body).
 * DO NOT "fix" this to agree with the live helper — disagreeing with it is the
 * entire content of this fixture.
 */
function v40Key(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

const USER_ID = "u-2753";
const OTHER_USER_ID = "u-2753-other";

/** Israeli landline, domestic form — 9 digits, so v40 kept it whole. */
const IL_LANDLINE_DOMESTIC = "03-555-0121";
/** The same number in E.164 — v40 sliced the country code off. */
const IL_LANDLINE_E164 = "+972 3 555 0121";
/** Israeli mobile, domestic form — 10 digits, v40 kept all ten. */
const IL_MOBILE_DOMESTIC = "052-555-0123";
/** The same mobile in E.164 — how message participants actually arrive. */
const IL_MOBILE_E164 = "+972525550123";
/** A NANP number, untouched by the rule change — the anti-control. */
const US_NUMBER = "+1 (415) 555-0109";

// ---------------------------------------------------------------------------
// Production-shape schema subset. Table bodies are copied from
// electron/database/schema.sql so PRIMARY KEY / NOT NULL behaviour is real.
// ---------------------------------------------------------------------------

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      is_imported INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_display TEXT,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_contact_phones_normalized ON contact_phones(phone_normalized);

    CREATE TABLE external_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phones_json TEXT,
      phones_normalized_json TEXT,
      emails_json TEXT,
      last_message_at DATETIME,
      source TEXT
    );

    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id),
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      channel TEXT,
      participants_flat TEXT,
      sent_at DATETIME,
      associated_message_type INTEGER
    );
  `);
  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(OTHER_USER_ID);
}

// ---------------------------------------------------------------------------
// Seeders — every stored key comes from the FROZEN rule, i.e. from the shipped
// producer, exactly as a real database on disk would carry it.
// ---------------------------------------------------------------------------

function seedContactPhone(
  db: DatabaseType,
  id: string,
  displayName: string,
  rawPhone: string,
): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
  ).run(`c-${id}`, USER_ID, displayName);
  db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, ?, 1, 'import')`,
  ).run(`cp-${id}`, `c-${id}`, rawPhone, rawPhone, v40Key(rawPhone));
}

function seedExternalContact(db: DatabaseType, id: string, rawPhones: string[]): void {
  db.prepare(
    `INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, source)
     VALUES (?, ?, ?, ?, ?, 'iphone')`,
  ).run(
    id,
    USER_ID,
    `External ${id}`,
    JSON.stringify(rawPhones),
    JSON.stringify(rawPhones.map(v40Key).filter((k) => k.length > 0)),
  );
}

function seedPhoneLastMessage(
  db: DatabaseType,
  rawPhone: string,
  at: string,
  userId: string = USER_ID,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
  ).run(v40Key(rawPhone), userId, at);
}

function seedMessage(
  db: DatabaseType,
  id: string,
  participantsFlat: string,
  sentAt: string,
  opts: { channel?: string; reactionType?: number | null; userId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, participants_flat, sent_at, associated_message_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER_ID,
    opts.channel ?? "imessage",
    participantsFlat,
    sentAt,
    opts.reactionType ?? null,
  );
}

// ---------------------------------------------------------------------------
// Readers — EXACT SETS, never counts.
// ---------------------------------------------------------------------------

function contactPhoneKeys(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT phone_normalized AS k FROM contact_phones ORDER BY id")
      .all() as Array<{ k: string | null }>
  )
    .map((r) => String(r.k))
    .sort();
}

function externalKeySets(db: DatabaseType): Record<string, string> {
  const rows = db
    .prepare("SELECT id, phones_normalized_json AS j FROM external_contacts ORDER BY id")
    .all() as Array<{ id: string; j: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.id, String(r.j)]));
}

/** Every phone_last_message row, as `user|key|timestamp` — content, not counts. */
function plmRows(db: DatabaseType): string[] {
  return (
    db
      .prepare(
        "SELECT user_id, phone_normalized, last_message_at FROM phone_last_message",
      )
      .all() as Array<{ user_id: string; phone_normalized: string; last_message_at: string }>
  )
    .map((r) => `${r.user_id}|${r.phone_normalized}|${r.last_message_at}`)
    .sort();
}

/**
 * The REAL phone branch of `contactDbService.searchContactsForSelection`
 * (contactDbService.ts:2425-2433): the needle is `toLookupKey(query)` — the
 * LIVE rule — matched with LIKE against the PERSISTED `phone_normalized`.
 * Replicated rather than imported so this file needs no Electron module graph;
 * the two lines that decide the outcome are the ones copied.
 */
function searchContactIdsByPhone(db: DatabaseType, query: string): string[] {
  const pattern = `%${toLookupKey(query)}%`;
  return (
    db
      .prepare(
        `SELECT DISTINCT c.id AS id
           FROM contacts c
           JOIN contact_phones cp ON cp.contact_id = c.id
          WHERE c.user_id = ?
            AND cp.phone_normalized LIKE ?`,
      )
      .all(USER_ID, pattern) as Array<{ id: string }>
  )
    .map((r) => r.id)
    .sort();
}

// ---------------------------------------------------------------------------

describe("migration v64 — re-key persisted phone lookup keys (BACKLOG-2753)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as DatabaseType;
    db.pragma("foreign_keys = ON");
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function runV64(): void {
    if (!V64) throw new Error("migration v64 not found in DatabaseService.MIGRATIONS");
    V64.migrate(db);
  }

  // -------------------------------------------------------------------------
  // FIXTURE INTEGRITY — the seeds really are old-shape
  // -------------------------------------------------------------------------

  it("the frozen v40 rule disagrees with the live rule on every Israeli seed (fixture is genuinely old-shape)", () => {
    for (const raw of [
      IL_LANDLINE_DOMESTIC,
      IL_LANDLINE_E164,
      IL_MOBILE_DOMESTIC,
      IL_MOBILE_E164,
    ]) {
      expect(v40Key(raw)).not.toBe(toLookupKey(raw));
    }
    // ...and agrees on the NANP population, which is what makes this a re-key
    // and not a rewrite. If this line ever fails, v64 is touching rows it has
    // no business touching.
    expect(v40Key(US_NUMBER)).toBe(toLookupKey(US_NUMBER));
  });

  it("v64 is the last migration in the chain and its version is unique", () => {
    const versions = (
      DatabaseService.MIGRATIONS as Array<{ version: number }>
    ).map((m) => m.version);
    expect(Math.max(...versions)).toBe(64);
    expect(versions.filter((v) => v === 64)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // CONTROL 1 — THE REGRESSION, BOTH HALVES
  // -------------------------------------------------------------------------

  describe("control 1 — the regression the migration exists to prevent", () => {
    beforeEach(() => {
      seedContactPhone(db, "il-landline", "Noa Landline", IL_LANDLINE_DOMESTIC);
      seedContactPhone(db, "il-mobile", "Noa Mobile", IL_MOBILE_DOMESTIC);
      seedContactPhone(db, "us", "Pat NANP", US_NUMBER);
    });

    it("RED HALF: with #2325's rule and NO migration, an Israeli contact is unreachable by its own number", () => {
      // The founder types the number in either form. Both compute the NEW key.
      expect(searchContactIdsByPhone(db, IL_LANDLINE_E164)).toEqual([]);
      expect(searchContactIdsByPhone(db, IL_LANDLINE_DOMESTIC)).toEqual([]);
      expect(searchContactIdsByPhone(db, IL_MOBILE_E164)).toEqual([]);
      expect(searchContactIdsByPhone(db, IL_MOBILE_DOMESTIC)).toEqual([]);

      // The NANP contact is found even without the migration — which is what
      // makes the four failures above about Israeli keys and not about the
      // search replica being broken.
      expect(searchContactIdsByPhone(db, US_NUMBER)).toEqual(["c-us"]);
    });

    it("GREEN HALF: after v64 the same searches find the same contacts, in both forms", () => {
      runV64();

      expect(searchContactIdsByPhone(db, IL_LANDLINE_E164)).toEqual(["c-il-landline"]);
      expect(searchContactIdsByPhone(db, IL_LANDLINE_DOMESTIC)).toEqual(["c-il-landline"]);
      expect(searchContactIdsByPhone(db, IL_MOBILE_E164)).toEqual(["c-il-mobile"]);
      expect(searchContactIdsByPhone(db, IL_MOBILE_DOMESTIC)).toEqual(["c-il-mobile"]);
      expect(searchContactIdsByPhone(db, US_NUMBER)).toEqual(["c-us"]);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 2 — EXACT KEY SETS, BEFORE AND AFTER
  // -------------------------------------------------------------------------

  describe("control 2 — exact key sets, never counts", () => {
    it("contact_phones: every key moves to the live rule's value, and only the Israeli ones move", () => {
      seedContactPhone(db, "il-landline", "Noa Landline", IL_LANDLINE_DOMESTIC);
      seedContactPhone(db, "il-e164", "Noa E164", IL_LANDLINE_E164);
      seedContactPhone(db, "il-mobile", "Noa Mobile", IL_MOBILE_DOMESTIC);
      seedContactPhone(db, "us", "Pat NANP", US_NUMBER);

      const before = contactPhoneKeys(db);
      expect(before).toEqual(
        [
          v40Key(IL_LANDLINE_DOMESTIC),
          v40Key(IL_LANDLINE_E164),
          v40Key(IL_MOBILE_DOMESTIC),
          v40Key(US_NUMBER),
        ].sort(),
      );

      runV64();

      expect(contactPhoneKeys(db)).toEqual(
        [
          toLookupKey(IL_LANDLINE_DOMESTIC),
          toLookupKey(IL_LANDLINE_E164),
          toLookupKey(IL_MOBILE_DOMESTIC),
          toLookupKey(US_NUMBER),
        ].sort(),
      );

      // The domestic and the E.164 form of ONE number now share ONE key — the
      // whole point of BACKLOG-2635, now true of the PERSISTED rows.
      expect(toLookupKey(IL_LANDLINE_DOMESTIC)).toBe(toLookupKey(IL_LANDLINE_E164));

      // The NANP row is byte-unchanged. Asserted by identity, not by "count of
      // changed rows", because a migration rewriting the wrong rows keeps counts.
      const usKeyAfter = (
        db
          .prepare("SELECT phone_normalized AS k FROM contact_phones WHERE id = 'cp-us'")
          .get() as { k: string }
      ).k;
      expect(usKeyAfter).toBe(v40Key(US_NUMBER));
    });

    it("contact_phones: recomputes from phone_e164, so a slice(-10)-mangled key is RECOVERED", () => {
      // This row is why the migration reads the SOURCE column: re-keying the
      // stored key alone could never get the country code back.
      seedContactPhone(db, "mangled", "Noa E164", IL_LANDLINE_E164);
      expect(toLookupKey(v40Key(IL_LANDLINE_E164))).not.toBe(toLookupKey(IL_LANDLINE_E164));

      runV64();

      expect(contactPhoneKeys(db)).toEqual([toLookupKey(IL_LANDLINE_E164)]);
    });

    it("contact_phones: a NULL key (a row that never went through v40's backfill) is filled, not skipped", () => {
      seedContactPhone(db, "null-key", "Noa Null", US_NUMBER);
      db.prepare("UPDATE contact_phones SET phone_normalized = NULL WHERE id = 'cp-null-key'").run();
      expect(contactPhoneKeys(db)).toEqual(["null"]);

      runV64();

      expect(contactPhoneKeys(db)).toEqual([toLookupKey(US_NUMBER)]);
    });

    it("external_contacts: the parallel array is recomputed from phones_json, entry by entry", () => {
      seedExternalContact(db, "x-il", [IL_LANDLINE_E164, IL_MOBILE_DOMESTIC]);
      seedExternalContact(db, "x-us", [US_NUMBER]);
      seedExternalContact(db, "x-empty", []);

      expect(externalKeySets(db)).toEqual({
        "x-il": JSON.stringify([v40Key(IL_LANDLINE_E164), v40Key(IL_MOBILE_DOMESTIC)]),
        "x-us": JSON.stringify([v40Key(US_NUMBER)]),
        "x-empty": JSON.stringify([]),
      });

      runV64();

      expect(externalKeySets(db)).toEqual({
        "x-il": JSON.stringify([toLookupKey(IL_LANDLINE_E164), toLookupKey(IL_MOBILE_DOMESTIC)]),
        "x-us": JSON.stringify([toLookupKey(US_NUMBER)]),
        "x-empty": JSON.stringify([]),
      });
    });

    it("external_contacts: invalid JSON becomes [] and a NULL array is populated — v40's own convention", () => {
      seedExternalContact(db, "x-broken", [US_NUMBER]);
      db.prepare("UPDATE external_contacts SET phones_json = '{not json' WHERE id = 'x-broken'").run();
      seedExternalContact(db, "x-null", [IL_MOBILE_DOMESTIC]);
      db.prepare(
        "UPDATE external_contacts SET phones_normalized_json = NULL WHERE id = 'x-null'",
      ).run();

      runV64();

      expect(externalKeySets(db)).toEqual({
        "x-broken": JSON.stringify([]),
        "x-null": JSON.stringify([toLookupKey(IL_MOBILE_DOMESTIC)]),
      });
    });

    it("phone_last_message: an E.164-sourced key is recovered from `messages`, which is the only place the country code survives", () => {
      // How the founder's Israeli threads really look: participants arrive
      // E.164, so v40 stored the SLICED key and re-keying it could not help.
      seedPhoneLastMessage(db, IL_MOBILE_E164, "2026-03-01 10:00:00");
      seedMessage(db, "m1", IL_MOBILE_E164, "2026-03-01 10:00:00");

      expect(plmRows(db)).toEqual([`${USER_ID}|${v40Key(IL_MOBILE_E164)}|2026-03-01 10:00:00`]);
      expect(toLookupKey(v40Key(IL_MOBILE_E164))).not.toBe(toLookupKey(IL_MOBILE_E164));

      runV64();

      // Both rows present: the recovered correct key AND the stale one, which
      // is the declared no-row-loss residual, asserted rather than implied.
      expect(plmRows(db)).toEqual(
        [
          `${USER_ID}|${toLookupKey(IL_MOBILE_E164)}|2026-03-01 10:00:00`,
          `${USER_ID}|${toLookupKey(v40Key(IL_MOBILE_E164))}|2026-03-01 10:00:00`,
        ].sort(),
      );
    });

    it("phone_last_message: a row whose messages are gone is carried, re-keyed, never dropped", () => {
      // syncDbService deletes messages by sync session and by source, so this
      // state is reachable in production. A rebuild-only migration loses it.
      seedPhoneLastMessage(db, IL_LANDLINE_DOMESTIC, "2026-02-02 09:00:00");
      // no messages at all

      runV64();

      expect(plmRows(db)).toEqual([
        `${USER_ID}|${toLookupKey(IL_LANDLINE_DOMESTIC)}|2026-02-02 09:00:00`,
      ]);
    });

    it("phone_last_message: rows are per-user, and one user's re-key never reaches another's", () => {
      seedPhoneLastMessage(db, IL_MOBILE_DOMESTIC, "2026-01-01 00:00:00", USER_ID);
      seedPhoneLastMessage(db, IL_MOBILE_DOMESTIC, "2026-06-06 06:00:00", OTHER_USER_ID);

      runV64();

      expect(plmRows(db)).toEqual(
        [
          `${USER_ID}|${toLookupKey(IL_MOBILE_DOMESTIC)}|2026-01-01 00:00:00`,
          `${OTHER_USER_ID}|${toLookupKey(IL_MOBILE_DOMESTIC)}|2026-06-06 06:00:00`,
        ].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 3 — COLLISION: TWO OLD KEYS, ONE NEW KEY
  // -------------------------------------------------------------------------

  describe("control 3 — collision policy: MAX(last_message_at), and no row lost", () => {
    it("the two inputs really do have DISTINCT old keys and an IDENTICAL new key", () => {
      // Without this the "collision" tests below could be testing nothing.
      expect(v40Key(IL_MOBILE_DOMESTIC)).not.toBe(v40Key(IL_MOBILE_E164));
      expect(toLookupKey(IL_MOBILE_DOMESTIC)).toBe(toLookupKey(IL_MOBILE_E164));
    });

    it("existing row NEWER than the message: the existing timestamp wins, one row survives", () => {
      seedPhoneLastMessage(db, IL_MOBILE_DOMESTIC, "2026-05-05 05:00:00");
      seedMessage(db, "m-older", IL_MOBILE_E164, "2026-01-01 01:00:00");

      runV64();

      const key = toLookupKey(IL_MOBILE_DOMESTIC);
      expect(plmRows(db)).toEqual([`${USER_ID}|${key}|2026-05-05 05:00:00`]);
    });

    it("message NEWER than the existing row: the message timestamp wins, one row survives", () => {
      // The mirror ordering. Running only one of these would leave MAX proven
      // by coincidence — whichever source happened to be folded last.
      seedPhoneLastMessage(db, IL_MOBILE_DOMESTIC, "2026-01-01 01:00:00");
      seedMessage(db, "m-newer", IL_MOBILE_E164, "2026-05-05 05:00:00");

      runV64();

      const key = toLookupKey(IL_MOBILE_DOMESTIC);
      expect(plmRows(db)).toEqual([`${USER_ID}|${key}|2026-05-05 05:00:00`]);
    });

    it("two PERSISTED rows whose old keys differ and whose new keys collide fold to one, keeping the later date", () => {
      // The PK-rewrite case with no messages involved at all: both rows are
      // already on disk under different keys. Neither is discarded — the
      // survivor carries the max, which is what the table means.
      seedPhoneLastMessage(db, IL_LANDLINE_DOMESTIC, "2026-04-04 04:00:00");
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
      ).run(v40Key(IL_LANDLINE_E164), USER_ID, "2026-07-07 07:00:00");

      const before = plmRows(db);
      expect(before).toHaveLength(2);
      expect(new Set(before)).toEqual(
        new Set([
          `${USER_ID}|${v40Key(IL_LANDLINE_DOMESTIC)}|2026-04-04 04:00:00`,
          `${USER_ID}|${v40Key(IL_LANDLINE_E164)}|2026-07-07 07:00:00`,
        ]),
      );

      runV64();

      // Note the E.164 side is the MANGLED key, so it re-keys to itself and
      // stays as its own row (the declared residual). The DOMESTIC side moves
      // onto the correct key. Nothing vanished: both timestamps are still here.
      const rows = plmRows(db);
      expect(rows).toEqual(
        [
          `${USER_ID}|${toLookupKey(IL_LANDLINE_DOMESTIC)}|2026-04-04 04:00:00`,
          `${USER_ID}|${toLookupKey(v40Key(IL_LANDLINE_E164))}|2026-07-07 07:00:00`,
        ].sort(),
      );
    });

    it("a true PK collision between two persisted rows keeps the later date and loses no data", () => {
      // Two rows whose OLD keys differ only in a leading trunk 0 vs the mobile
      // shape — both re-key onto ONE new key, so the PRIMARY KEY forces a fold.
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
      ).run(v40Key(IL_MOBILE_DOMESTIC), USER_ID, "2026-03-03 03:00:00");
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
      ).run(toLookupKey(IL_MOBILE_DOMESTIC), USER_ID, "2026-09-09 09:00:00");

      expect(plmRows(db)).toHaveLength(2);

      runV64();

      expect(plmRows(db)).toEqual([
        `${USER_ID}|${toLookupKey(IL_MOBILE_DOMESTIC)}|2026-09-09 09:00:00`,
      ]);
    });

    it("...and the SAME PK collision with the dates swapped still keeps the later one", () => {
      // The mirror of the case above. Rows are folded in rowid order, so with
      // only one ordering a plain last-write-wins would pass and MAX would be
      // proven by coincidence. Measured: replacing the MAX with an
      // unconditional `byKey.set` leaves the case above GREEN and turns this
      // one RED.
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
      ).run(v40Key(IL_MOBILE_DOMESTIC), USER_ID, "2026-09-09 09:00:00");
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
      ).run(toLookupKey(IL_MOBILE_DOMESTIC), USER_ID, "2026-03-03 03:00:00");

      runV64();

      expect(plmRows(db)).toEqual([
        `${USER_ID}|${toLookupKey(IL_MOBILE_DOMESTIC)}|2026-09-09 09:00:00`,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 4 — IDEMPOTENCY (BACKLOG-2752 replays the whole chain)
  // -------------------------------------------------------------------------

  describe("control 4 — idempotent: a second run changes nothing", () => {
    it("byte-diff of all three tables after a second run is empty", () => {
      seedContactPhone(db, "il-landline", "Noa Landline", IL_LANDLINE_DOMESTIC);
      seedContactPhone(db, "il-e164", "Noa E164", IL_LANDLINE_E164);
      seedContactPhone(db, "us", "Pat NANP", US_NUMBER);
      seedExternalContact(db, "x-il", [IL_LANDLINE_E164, IL_MOBILE_DOMESTIC]);
      seedPhoneLastMessage(db, IL_MOBILE_DOMESTIC, "2026-01-01 01:00:00");
      seedPhoneLastMessage(db, IL_LANDLINE_DOMESTIC, "2026-02-02 02:00:00");
      seedMessage(db, "m1", IL_MOBILE_E164, "2026-05-05 05:00:00");
      seedMessage(db, "m2", US_NUMBER, "2026-04-04 04:00:00");

      runV64();
      const afterFirst = {
        contactPhones: contactPhoneKeys(db),
        external: externalKeySets(db),
        plm: plmRows(db),
      };

      runV64();
      const afterSecond = {
        contactPhones: contactPhoneKeys(db),
        external: externalKeySets(db),
        plm: plmRows(db),
      };

      expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst));
    });

    it("a THIRD run still changes nothing — the fixed point is not a two-step cycle", () => {
      seedPhoneLastMessage(db, IL_MOBILE_E164, "2026-01-01 01:00:00");
      seedMessage(db, "m1", IL_MOBILE_E164, "2026-01-01 01:00:00");

      runV64();
      const first = plmRows(db);
      runV64();
      runV64();
      expect(plmRows(db)).toEqual(first);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 5 — THE REBUILD MIRRORS THE WRITER'S PREDICATE
  // -------------------------------------------------------------------------

  describe("control 5 — the messages rebuild uses the writer's own predicate", () => {
    it("excludes reactions exactly as backfillPhoneLastMessageTable does", () => {
      // A tapback carries an associated_message_type inside the band. If the
      // rebuild let it through, this key would appear with the LATER date.
      seedMessage(db, "m-real", IL_MOBILE_E164, "2026-01-01 01:00:00");
      seedMessage(db, "m-tapback", IL_MOBILE_E164, "2026-12-12 12:00:00", {
        reactionType: 2000,
      });

      runV64();

      expect(plmRows(db)).toEqual([
        `${USER_ID}|${toLookupKey(IL_MOBILE_E164)}|2026-01-01 01:00:00`,
      ]);
      // The clause is required live, not copied, so it cannot drift.
      expect(LOCAL_REACTION_EXCLUSION).toContain("associated_message_type");
    });

    it("ignores non-message channels", () => {
      seedMessage(db, "m-email", IL_MOBILE_E164, "2026-12-12 12:00:00", { channel: "email" });

      runV64();

      expect(plmRows(db)).toEqual([]);
    });

    it("splits participants_flat on commas and keys each one, including short codes", () => {
      // BACKLOG-1493: no minimum-digit filter, same as the writer.
      seedMessage(db, "m-group", `${IL_MOBILE_E164},${US_NUMBER},262966`, "2026-06-06 06:00:00");

      runV64();

      expect(plmRows(db)).toEqual(
        [
          `${USER_ID}|${toLookupKey(IL_MOBILE_E164)}|2026-06-06 06:00:00`,
          `${USER_ID}|${toLookupKey(US_NUMBER)}|2026-06-06 06:00:00`,
          `${USER_ID}|${toLookupKey("262966")}|2026-06-06 06:00:00`,
        ].sort(),
      );
    });

    it("never invents a row for a user_id that does not exist in users_local", () => {
      seedMessage(db, "m-ghost", IL_MOBILE_E164, "2026-06-06 06:00:00", {
        userId: "u-does-not-exist",
      });

      runV64();

      expect(plmRows(db)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 6 — GUARDS: PARTIAL SCHEMAS MUST NOT THROW
  // -------------------------------------------------------------------------

  describe("control 6 — guards, so a partial-schema fixture no-ops instead of throwing", () => {
    it("no-ops on a database with none of the three tables", () => {
      const bare = new Database(":memory:") as DatabaseType;
      try {
        bare.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
        expect(() => V64!.migrate(bare)).not.toThrow();
      } finally {
        bare.close();
      }
    });

    it("carries and re-keys existing rows when `messages` lacks the columns the rebuild needs", () => {
      // Several migration suites seed `messages` as (id, user_id, thread_id).
      // Without a COLUMN guard this migration would throw "no such column:
      // channel" on every chain run that starts below 64.
      db.exec("DROP TABLE messages");
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, thread_id TEXT)");
      seedPhoneLastMessage(db, IL_LANDLINE_DOMESTIC, "2026-02-02 02:00:00");

      expect(() => runV64()).not.toThrow();
      expect(plmRows(db)).toEqual([
        `${USER_ID}|${toLookupKey(IL_LANDLINE_DOMESTIC)}|2026-02-02 02:00:00`,
      ]);
    });

    it("no-ops when contact_phones exists but has no phone_normalized column (pre-v40 shape)", () => {
      db.exec("DROP TABLE contact_phones");
      db.exec(`
        CREATE TABLE contact_phones (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          phone_e164 TEXT NOT NULL
        )
      `);
      expect(() => runV64()).not.toThrow();
    });
  });
});
