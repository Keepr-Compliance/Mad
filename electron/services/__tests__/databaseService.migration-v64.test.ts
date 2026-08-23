/**
 * @jest-environment node
 *
 * MIGRATION v64 IN ISOLATION — BACKLOG-2630 slice 1, the phone re-key.
 *
 * ===========================================================================
 * WHY A FRESH DATABASE CANNOT TEST THIS
 * ===========================================================================
 * v64 exists to rewrite keys that were written by the OLD rule. A fresh install
 * has no old-rule keys, so it exercises the migration and proves nothing —
 * exactly the blind spot BACKLOG-2750 and BACKLOG-2751 were filed for, and the
 * documented trap that a migration passing CI can still break a real old→new
 * upgrade. So the fixture below is an UPGRADE: a post-v63 database whose three
 * key stores are populated the way `digits.slice(-10)` populated them, driven
 * through the real migration runner.
 *
 * SEEDING AND CLIPPING follow the v62/v63 idiom: seed at 63 and clip MIGRATIONS
 * to <= 64 so ONLY v64 runs, keeping every assertion here a statement about v64
 * when v65 lands.
 *
 * The repository is public. Every number is from a reserved fictional range
 * (NANP 555-01xx, Ofcom 020 7946 0xxx) or is synthetic.
 */

import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: mockFns, logService: mockFns };
});

jest.mock("../databaseEncryptionService", () => {
  const svc = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { databaseEncryptionService: svc, default: svc };
});

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { toLookupKey } from "../../utils/phoneNormalization";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
);

const USER_ID = "user-v64-test";
const CONTACT_ID = "contact-v64-test";

/**
 * `phone_last_message`, transcribed verbatim from `electron/database/schema.sql`
 * (the BACKLOG-567 / migration-24 block). The harness's v29 subset does not
 * carry this table, and hand-simplifying it would change the very thing v64
 * has to work around: `phone_normalized` is half of the PRIMARY KEY.
 */
const PHONE_LAST_MESSAGE_DDL = `
  CREATE TABLE IF NOT EXISTS phone_last_message (
    phone_normalized TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_message_at DATETIME NOT NULL,
    PRIMARY KEY (phone_normalized, user_id),
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_phone_last_msg_user ON phone_last_message(user_id);
`;

/**
 * The v40 columns, transcribed from migration v40's own ALTER statements.
 * The harness seeds the v29 shape, which predates them; a real database at v63
 * has had them since v40, and v64's whole job is to rewrite what they hold.
 */
const V40_COLUMNS_DDL = `
  ALTER TABLE contact_phones ADD COLUMN phone_normalized TEXT;
  CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized);
  ALTER TABLE external_contacts ADD COLUMN phones_normalized_json TEXT;
`;

/**
 * THE OLD RULE, transcribed. The fixture is seeded with what
 * `digits.slice(-10)` would have written — not with what looks plausible.
 */
function oldRuleKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/** Contact phones: the raw stored `phone_e164`, and what v64 must produce. */
const CONTACT_PHONES: Array<{ id: string; e164: string; expected: string }> = [
  { id: "cp-us-1", e164: "+14155550109", expected: "14155550109" },
  { id: "cp-us-2", e164: "+12015550123", expected: "12015550123" },
  { id: "cp-uk", e164: "+442079460958", expected: "442079460958" },
  { id: "cp-il", e164: "+97235550142", expected: "97235550142" },
  { id: "cp-leading-zero", e164: "+020794609", expected: "020794609" },
  { id: "cp-short", e164: "+12345", expected: "12345" },
  { id: "cp-alpha", e164: "VERIZON", expected: "VERIZON" },
];

/**
 * `phone_last_message` fixture.
 *
 * THE LAST THREE ROWS ARE THE POINT. A naive re-key — `toLookupKey(oldKey)` —
 * is NOT idempotent under the library rule, because an 11-or-12-digit non-US
 * key does not parse with a US default region, falls back, and gets sliced to
 * its last ten digits. Those shapes arise in the wild two ways: v64's own first
 * pass writes 11-digit keys, and BACKLOG-2752's baseline clamp REPLAYS the
 * chain on below-baseline databases. Without these rows the replay assertion
 * below would pass while the property was broken — the fixture-cannot-fail trap.
 */
const PHONE_LAST_MESSAGE: Array<{ key: string; at: string; expected: string; why: string }> = [
  { key: "4155550109", at: "2026-02-04T13:00:00.000Z", expected: "14155550109", why: "valid US 10-digit — re-keyed" },
  { key: "2015550123", at: "2026-02-05T09:30:00.000Z", expected: "12015550123", why: "valid US 10-digit — re-keyed" },
  { key: "1115550109", at: "2026-02-06T11:00:00.000Z", expected: "1115550109", why: "10 digits, invalid NANP area code — left alone" },
  { key: "0525550123", at: "2026-02-07T08:15:00.000Z", expected: "0525550123", why: "10 digits, leading zero: isPossible but not isValid — left alone" },
  { key: "262966", at: "2026-02-08T17:45:00.000Z", expected: "262966", why: "short code — BACKLOG-1493 requires it to survive" },
  { key: "VERIZON", at: "2026-02-09T06:00:00.000Z", expected: "VERIZON", why: "alphanumeric sender — left alone" },
  { key: "442079460958", at: "2026-02-10T22:10:00.000Z", expected: "442079460958", why: "12 digits — the replay landmine" },
  { key: "97235550142", at: "2026-02-11T12:20:00.000Z", expected: "97235550142", why: "11 digits, non-leading-1 — the replay landmine" },
  { key: "14155550199", at: "2026-02-12T15:05:00.000Z", expected: "14155550199", why: "11 digits leading 1 — the shape v64's own first pass writes" },
];

const EXTERNAL_PHONES = ["+1 (415) 555-0109", "555-0109", "VERIZON"];

describe("migration v64 — re-key persisted phone lookup keys (BACKLOG-2630)", () => {
  let harness: MigrationHarness;

  function dump(table: string): string {
    const rows = harness.db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all() as unknown[];
    return JSON.stringify(rows);
  }

  /** Seed at v63 AND clip the chain at v64 so ONLY v64 runs. */
  async function runV64(): Promise<void> {
    harness.db
      .prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 63)")
      .run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 64);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  beforeEach(() => {
    harness = createMigrationHarness();
    harness.db.exec(V40_COLUMNS_DDL);
    harness.db.exec(PHONE_LAST_MESSAGE_DDL);

    // The harness's v29 `users_local` is `(id)` only — seeded to satisfy the FK
    // on `phone_last_message` and `contacts`, nothing more.
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
      .run(CONTACT_ID, USER_ID, "V64 Fixture");

    const insertPhone = harness.db.prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
       VALUES (?, ?, ?, ?, ?, 0, 'import')`,
    );
    for (const row of CONTACT_PHONES) {
      insertPhone.run(row.id, CONTACT_ID, row.e164, row.e164, oldRuleKey(row.e164));
    }

    harness.db
      .prepare(
        `INSERT INTO external_contacts (id, user_id, source, external_record_id, name, phones_json, phones_normalized_json)
         VALUES (?, ?, 'macos', ?, ?, ?, ?)`,
      )
      .run(
        "ec-v64-1",
        USER_ID,
        "rec-1",
        "V64 External",
        JSON.stringify(EXTERNAL_PHONES),
        JSON.stringify(EXTERNAL_PHONES.map(oldRuleKey).filter((k) => k.length > 0)),
      );
    harness.db
      .prepare(
        `INSERT INTO external_contacts (id, user_id, source, external_record_id, name, phones_json, phones_normalized_json)
         VALUES (?, ?, 'macos', ?, ?, ?, ?)`,
      )
      .run("ec-v64-2", USER_ID, "rec-2", "V64 Malformed", "{not json", null);

    const insertPlm = harness.db.prepare(
      "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
    );
    for (const row of PHONE_LAST_MESSAGE) {
      insertPlm.run(row.key, USER_ID, row.at);
    }
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("SANITY: the harness wired the real driver, not the Jest auto-mock", () => {
    expect(harness.db.constructor).toBe(realDatabase);
    expect(typeof harness.db.prepare).toBe("function");
  });

  it("PRECONDITION: every seeded key is an OLD-rule key, and they disagree with the new rule", () => {
    // A migration test whose fixture already holds the right answer proves
    // nothing. This asserts the "before" is genuinely before.
    const stored = harness.db
      .prepare("SELECT id, phone_e164, phone_normalized FROM contact_phones ORDER BY id")
      .all() as Array<{ id: string; phone_e164: string; phone_normalized: string }>;

    const disagreeing = stored.filter((r) => r.phone_normalized !== toLookupKey(r.phone_e164));
    expect(disagreeing.map((r) => r.id).sort()).toEqual(
      ["cp-il", "cp-uk", "cp-us-1", "cp-us-2"], // the four the new rule moves
    );
    expect(stored.find((r) => r.id === "cp-us-1")?.phone_normalized).toBe("4155550109");
  });

  it("re-keys contact_phones to the EXACT expected key set", () => {
    return runV64().then(() => {
      const rows = harness.db
        .prepare("SELECT id, phone_normalized FROM contact_phones ORDER BY id")
        .all() as Array<{ id: string; phone_normalized: string }>;

      // Identity, not counts: the whole set, by id.
      expect(rows).toEqual(
        [...CONTACT_PHONES]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => ({ id: r.id, phone_normalized: r.expected })),
      );

      // ...and every one of them agrees with the LIVE function, which is the
      // property that actually matters: the app computes what the DB holds.
      for (const row of CONTACT_PHONES) {
        expect({ id: row.id, key: row.expected }).toEqual({
          id: row.id,
          key: toLookupKey(row.e164),
        });
      }
    });
  });

  it("re-keys external_contacts.phones_normalized_json, keeping v40's conventions", () => {
    return runV64().then(() => {
      const rows = harness.db
        .prepare("SELECT id, phones_normalized_json FROM external_contacts ORDER BY id")
        .all() as Array<{ id: string; phones_normalized_json: string }>;

      expect(rows).toEqual([
        {
          id: "ec-v64-1",
          phones_normalized_json: JSON.stringify(["14155550109", "5550109", "VERIZON"]),
        },
        // Unparseable JSON becomes `[]` rather than aborting the migration —
        // v40's convention, and `externalContactDbService`'s too.
        { id: "ec-v64-2", phones_normalized_json: "[]" },
      ]);
    });
  });

  it("re-keys phone_last_message to the EXACT expected key set, losing no row", () => {
    return runV64().then(() => {
      const rows = harness.db
        .prepare(
          "SELECT phone_normalized, last_message_at FROM phone_last_message ORDER BY phone_normalized",
        )
        .all() as Array<{ phone_normalized: string; last_message_at: string }>;

      const expected = PHONE_LAST_MESSAGE.map((r) => ({
        phone_normalized: r.expected,
        last_message_at: r.at,
      })).sort((a, b) => a.phone_normalized.localeCompare(b.phone_normalized));

      expect(rows).toEqual(expected);
      // No row is lost: the fold cannot drop one, and nothing here collides.
      expect(rows).toHaveLength(PHONE_LAST_MESSAGE.length);
    });
  });

  it("leaves short codes and alphanumeric senders alone — BACKLOG-1493 unbroken", () => {
    return runV64().then(() => {
      const keys = (
        harness.db
          .prepare("SELECT phone_normalized FROM phone_last_message")
          .all() as Array<{ phone_normalized: string }>
      ).map((r) => r.phone_normalized);

      expect(keys).toContain("262966");
      expect(keys).toContain("VERIZON");
    });
  });

  it("IS IDEMPOTENT: a replayed chain rewrites the same bytes", () => {
    return runV64()
      .then(() => {
        const after1 = {
          contact_phones: dump("contact_phones"),
          external_contacts: dump("external_contacts"),
          phone_last_message: dump("phone_last_message"),
        };
        // BACKLOG-2752's baseline clamp replays the chain on below-baseline
        // databases, so a second run is a real event, not a hypothetical.
        return runV64().then(() => after1);
      })
      .then((after1) => {
        expect(dump("contact_phones")).toBe(after1.contact_phones);
        expect(dump("external_contacts")).toBe(after1.external_contacts);
        expect(dump("phone_last_message")).toBe(after1.phone_last_message);
      });
  });

  it("THE IDEMPOTENCE FIXTURE CAN FAIL: the naive re-key mangles it", () => {
    // Without this, the replay assertion above is unfalsifiable — a fixture
    // holding only 10-digit keys would replay cleanly under a rule that is not
    // idempotent at all. Here the naive implementation
    // (`toLookupKey(existingKey)`) is run over the SAME fixture rows and shown
    // to destroy them, which is what makes the green above mean something.
    const naive = (key: string): string => toLookupKey(key);

    expect(naive("442079460958")).toBe("2079460958"); // 12-digit key, amputated
    expect(naive("97235550142")).toBe("7235550142"); // 11-digit key, amputated

    // The naive rule is a FIXED POINT for the US shape, which is precisely why
    // a 10-digit-only fixture cannot catch the bug: "14155550199" parses as a
    // valid US number and comes back unchanged. A replay test seeded only with
    // US numbers would be green under an implementation that destroys every
    // international key.
    expect(naive("14155550199")).toBe("14155550199");

    // The two landmine shapes are the ones that mangle, and they are in the
    // fixture above.
    for (const key of ["442079460958", "97235550142"]) {
      expect({ key, naive: naive(key) }).not.toEqual({ key, naive: key });
    }
  });

  it("keeps a below-floor value SEARCHABLE after the migration — the 2754 half that would break", () => {
    // BACKLOG-2754: had the digit floor been built into the lookup key, this
    // row's key would be empty, the search needle would be '%%', and a 3-to-6
    // digit query would match every contact on file. Asserted through real SQL
    // against the real column, after the real migration.
    return runV64().then(() => {
      // A 6-digit value chosen NOT to be a substring of any other fixture key,
      // so the assertion below is about the floor and not about substring luck.
      const belowFloor = "409215";
      harness.db
        .prepare(
          `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
           VALUES (?, ?, ?, ?, ?, 0, 'manual')`,
        )
        .run("cp-below-floor", CONTACT_ID, belowFloor, belowFloor, toLookupKey(belowFloor));

      // It is STORED, with a real key.
      expect(toLookupKey(belowFloor)).toBe("409215");

      const needle = `%${toLookupKey(belowFloor)}%`;
      expect(needle).not.toBe("%%");

      // It is SEARCHABLE, and it is the only thing that query finds.
      const hits = harness.db
        .prepare("SELECT id FROM contact_phones WHERE phone_normalized LIKE ? ORDER BY id")
        .all(needle) as Array<{ id: string }>;
      expect(hits.map((h) => h.id)).toEqual(["cp-below-floor"]);

      // THE COUNTERFACTUAL, run rather than described: with the floor at the key
      // layer the needle collapses to '%%' and the same query returns EVERY row.
      // This is the total false positive BACKLOG-2754 refused to ship.
      const collapsed = harness.db
        .prepare("SELECT id FROM contact_phones WHERE phone_normalized LIKE ?")
        .all("%%") as Array<{ id: string }>;
      expect(collapsed.length).toBe(CONTACT_PHONES.length + 1);
      expect(collapsed.length).toBeGreaterThan(hits.length);
    });
  });

  it("records itself in the chain exactly once, at version 64", () => {
    return runV64().then(() => {
      const version = (
        harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(version).toBe(64);

      const klass = harness.service.constructor as {
        MIGRATIONS: Array<{ version: number }>;
      };
      expect(klass.MIGRATIONS.filter((m) => m.version === 64)).toHaveLength(1);
      expect(Math.max(...klass.MIGRATIONS.map((m) => m.version))).toBe(64);
    });
  });
});
