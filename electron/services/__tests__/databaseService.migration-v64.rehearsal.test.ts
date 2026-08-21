/**
 * @jest-environment node
 *
 * MIGRATION v64 REHEARSED ON A REAL SNAPSHOT (BACKLOG-2753)
 *
 * ===========================================================================
 * WHY A FRESH DATABASE CANNOT TEST THIS MIGRATION
 * ===========================================================================
 * A fresh install runs migration v40, whose backfill `require`s the LIVE
 * lookup helper — so a fresh database is born with NEW-rule keys and v64 is a
 * no-op on it. It has no old-rule keys and therefore cannot fail. That is the
 * blind spot BACKLOG-2750 proved on the index bug, and BACKLOG-2700 built this
 * harness to close.
 *
 * This file therefore starts from `fixtures/v2.27.0-populated.sql` — the
 * SHIPPED v2.27.0 database at schema_version 55, produced by running the
 * shipped code (`buildV2270Fixture.gen.ts`) — restores it onto a real file,
 * seeds phone rows carrying keys from the SHIPPED rule, and then runs the
 * WHOLE chain through the public `runMigrations()`, exactly as a launch does.
 *
 * ===========================================================================
 * WHY THE PHONE ROWS ARE SEEDED RATHER THAN INHERITED
 * ===========================================================================
 * Measured, not assumed: the committed fixture's three `contact_phones` rows
 * carry `phone_normalized` NULL and it has no `phone_last_message` rows at all
 * (`grep -c "INSERT INTO \"phone_last_message\"" fixtures/v2.27.0-populated.sql`
 * -> 0). The generator writes those rows directly rather than through the
 * write path. So the snapshot supplies the thing that matters — a real,
 * complete, populated schema at a real shipped version, with all the chain
 * interactions that come with it — while the phone population this migration
 * acts on has to be added.
 *
 * Their keys come from `v40Key`, the frozen transcription of the shipped rule
 * (see databaseService.migration-v64.test.ts for its provenance), and every
 * seed is asserted `frozen(raw) !== live(raw)` so the fixture cannot quietly
 * become new-shape and start passing for the wrong reason.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as databaseService.migrationChainRehearsal.test.ts.
// Sentry.flush is included because runMigrations() awaits it on the failure
// path; without it a genuine migration failure surfaces as "Sentry.flush is
// not a function" instead of the real error.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
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
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { setDb, setDbPath, setEncryptionKey } from "../db/core/dbConnection";
import { toLookupKey } from "../../utils/phoneNormalization";
import {
  CONTACT_PHONE_IDS,
  EXTERNAL_CONTACT_IDS,
  EXPECTED_SHIPPED_VERSION,
  USER_ID,
} from "./fixtures/rehearsalCorpus";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const FIXTURE_SQL_PATH = path.join(__dirname, "fixtures", "v2.27.0-populated.sql");

/** The version the chain must land on — the LAST entry in MIGRATIONS. */
const HEAD_VERSION = 64;

/**
 * The SHIPPED lookup rule, frozen. Transcribed verbatim from
 * `git show 25fe2f4e1:electron/utils/phoneNormalization.ts` (toLookupKey body).
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

const IL_LANDLINE_DOMESTIC = "03-555-0121";
const IL_LANDLINE_E164 = "+972 3 555 0121";
const IL_MOBILE_DOMESTIC = "052-555-0123";
const IL_MOBILE_E164 = "+972525550123";
/** The NANP number the fixture's own `cp-2700-ben` row already carries. */
const FIXTURE_US_E164 = "+14155550102";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("migration v64 rehearsed on the shipped v2.27.0 snapshot (BACKLOG-2753)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  let db: DatabaseType;
  const createdTmpDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-rekey-2753-"));
    createdTmpDirs.push(tmpDir);
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    // ARRANGE — the shipped-state transcript, replayed onto a real file.
    db.exec(fs.readFileSync(FIXTURE_SQL_PATH, "utf8"));
    // The dump opens with `PRAGMA foreign_keys=OFF;` and never restores it; a
    // real launch migrates with enforcement ON (databaseService.ts:360), and
    // the runner's restore branch only fires if it was on to begin with.
    db.pragma("foreign_keys = ON");

    seedOldRulePhoneRows(db);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    if (service) {
      service.db = null;
      service.dbPath = null;
    }
    setDb(null as unknown as DatabaseType);
  });

  afterAll(() => {
    for (const dir of createdTmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /**
   * Bring the snapshot to the state a real shipped database is in: every
   * persisted key written by the SHIPPED rule.
   */
  function seedOldRulePhoneRows(target: DatabaseType): void {
    // The fixture's own three rows have NULL keys — give them the keys the
    // shipped write path would have written.
    const setKey = target.prepare("UPDATE contact_phones SET phone_normalized = ? WHERE id = ?");
    for (const row of target
      .prepare("SELECT id, phone_e164 FROM contact_phones")
      .all() as Array<{ id: string; phone_e164: string }>) {
      setKey.run(v40Key(row.phone_e164), row.id);
    }

    // Two Israeli contacts, one domestic and one E.164 — the population the
    // rule change targets, and the population that regresses without v64.
    const addContact = target.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
    );
    const addPhone = target.prepare(
      `INSERT INTO contact_phones
         (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, label, source, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'mobile', 'import', '2026-03-01 08:00:00')`,
    );
    addContact.run("c-2753-il-landline", USER_ID, "Rehearsal IL Landline");
    addPhone.run(
      "cp-2753-il-landline",
      "c-2753-il-landline",
      IL_LANDLINE_DOMESTIC,
      IL_LANDLINE_DOMESTIC,
      v40Key(IL_LANDLINE_DOMESTIC),
    );
    addContact.run("c-2753-il-mobile", USER_ID, "Rehearsal IL Mobile");
    addPhone.run(
      "cp-2753-il-mobile",
      "c-2753-il-mobile",
      IL_MOBILE_E164,
      IL_MOBILE_E164,
      v40Key(IL_MOBILE_E164),
    );

    // The external-contact store, keyed by the shipped rule too.
    const setExternal = target.prepare(
      "UPDATE external_contacts SET phones_normalized_json = ? WHERE id = ?",
    );
    for (const row of target
      .prepare("SELECT id, phones_json FROM external_contacts")
      .all() as Array<{ id: string; phones_json: string | null }>) {
      const phones = row.phones_json ? (JSON.parse(row.phones_json) as string[]) : [];
      setExternal.run(JSON.stringify(phones.map(v40Key).filter((k) => k.length > 0)), row.id);
    }
    target
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json, source, external_record_id, synced_at)
         VALUES (?, ?, ?, ?, ?, '[]', 'iphone', ?, '2026-03-01 08:00:00')`,
      )
      .run(
        "x-2753-il",
        USER_ID,
        "Rehearsal External IL",
        JSON.stringify([IL_MOBILE_DOMESTIC]),
        JSON.stringify([v40Key(IL_MOBILE_DOMESTIC)]),
        "ab-rec-2753",
      );

    // phone_last_message, as the shipped writer would have left it: keys from
    // the shipped rule over the raw message participants.
    const addPlm = target.prepare(
      "INSERT OR REPLACE INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
    );
    addPlm.run(v40Key(IL_MOBILE_E164), USER_ID, "2026-02-01 10:00:00");
    addPlm.run(v40Key(IL_LANDLINE_DOMESTIC), USER_ID, "2026-02-02 10:00:00");
    addPlm.run(v40Key(FIXTURE_US_E164), USER_ID, "2026-02-03 10:00:00");

    // A real message carrying the Israeli mobile in E.164 — the only place the
    // country code the old rule threw away still exists.
    target
      .prepare(
        `INSERT INTO messages
           (id, user_id, external_id, channel, direction, body_text, participants, participants_flat,
            thread_id, sent_at, has_attachments, is_false_positive, content_hash, message_type, created_at)
         VALUES (?, ?, 'msg-ext-2753', 'imessage', 'inbound', 'rehearsal', ?, ?,
                 'sms-thr-2753', '2026-02-01 10:00:00', 0, 0, 'hash-m2753', 'text', '2026-02-11 08:00:00')`,
      )
      .run("m-2753-il", USER_ID, JSON.stringify([IL_MOBILE_E164]), IL_MOBILE_E164);
  }

  async function upgrade(): Promise<void> {
    await service.runMigrations();
    db = service.db as DatabaseType;
  }

  function keyOf(phoneRowId: string): string | null {
    return (
      db
        .prepare("SELECT phone_normalized AS k FROM contact_phones WHERE id = ?")
        .get(phoneRowId) as { k: string | null } | undefined
    )?.k ?? null;
  }

  function plmRows(): string[] {
    return (
      db
        .prepare("SELECT user_id, phone_normalized, last_message_at FROM phone_last_message")
        .all() as Array<{ user_id: string; phone_normalized: string; last_message_at: string }>
    )
      .map((r) => `${r.user_id}|${r.phone_normalized}|${r.last_message_at}`)
      .sort();
  }

  function schemaVersion(): number {
    return (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
  }

  function ids(sql: string): string[] {
    return (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id).sort();
  }

  // -------------------------------------------------------------------------

  it("the snapshot really is the shipped one, and the seeds really are old-shape", () => {
    expect(schemaVersion()).toBe(EXPECTED_SHIPPED_VERSION);
    expect(EXPECTED_SHIPPED_VERSION).toBeLessThan(HEAD_VERSION);
    expect(service.dbPath).toBe(dbFile);
    expect(fs.statSync(dbFile).size).toBeGreaterThan(0);

    for (const raw of [IL_LANDLINE_DOMESTIC, IL_MOBILE_E164, IL_MOBILE_DOMESTIC]) {
      expect(v40Key(raw)).not.toBe(toLookupKey(raw));
    }
    // Every persisted key on the file is the SHIPPED rule's output, not the
    // live one — otherwise this rehearsal starts from the wrong state.
    expect(keyOf("cp-2753-il-landline")).toBe(v40Key(IL_LANDLINE_DOMESTIC));
    expect(keyOf("cp-2753-il-mobile")).toBe(v40Key(IL_MOBILE_E164));
    expect(keyOf("cp-2700-ben")).toBe(v40Key(FIXTURE_US_E164));
  });

  it("the whole chain runs and lands on head", async () => {
    await upgrade();
    expect(schemaVersion()).toBe(HEAD_VERSION);
  });

  it("after the real chain, every Israeli key on the file is the live rule's key", async () => {
    await upgrade();

    expect(keyOf("cp-2753-il-landline")).toBe(toLookupKey(IL_LANDLINE_DOMESTIC));
    expect(keyOf("cp-2753-il-mobile")).toBe(toLookupKey(IL_MOBILE_E164));
    // Domestic and E.164 forms of one number now meet on the PERSISTED rows.
    expect(toLookupKey(IL_LANDLINE_DOMESTIC)).toBe(toLookupKey(IL_LANDLINE_E164));

    // The snapshot's own NANP rows are byte-unchanged — a re-key, not a rewrite.
    expect(keyOf("cp-2700-ben")).toBe(v40Key(FIXTURE_US_E164));
  });

  it("the external-contact array on the file is recomputed, entry by entry", async () => {
    await upgrade();

    const row = db
      .prepare("SELECT phones_normalized_json AS j FROM external_contacts WHERE id = 'x-2753-il'")
      .get() as { j: string };
    expect(row.j).toBe(JSON.stringify([toLookupKey(IL_MOBILE_DOMESTIC)]));
  });

  it("phone_last_message is rebuilt from `messages` and loses no pre-existing row", async () => {
    const before = plmRows();
    expect(before).toHaveLength(3);

    await upgrade();

    const after = plmRows();

    // The correct key, RECOVERED from the message's E.164 participant — this
    // is the row the sliced key could never have produced on its own.
    expect(after).toContain(`${USER_ID}|${toLookupKey(IL_MOBILE_E164)}|2026-02-01 10:00:00`);

    // The landline row, re-keyed in place from a key `messages` cannot explain.
    expect(after).toContain(`${USER_ID}|${toLookupKey(IL_LANDLINE_DOMESTIC)}|2026-02-02 10:00:00`);

    // THE COLLISION, ARRIVING FROM THE SNAPSHOT'S OWN DATA rather than from a
    // constructed pair: the seeded NANP row (2026-02-03) and the fixture's own
    // `m-2700-sms-1` to the same number (2026-02-04) fold onto ONE key, and the
    // MAX wins. The older timestamp is not "lost" — it is the smaller half of a
    // maximum, which is precisely what this table stores.
    expect(after).toContain(`${USER_ID}|${toLookupKey(FIXTURE_US_E164)}|2026-02-04 13:00:00`);

    // NO ROW LOST: every key that existed before still exists (re-keyed), and
    // its timestamp never went backwards.
    const afterByKey = new Map(
      after.map((r) => {
        const [, key, at] = r.split("|");
        return [key, at];
      }),
    );
    for (const row of before) {
      const [, oldKey, oldAt] = row.split("|");
      const newKey = toLookupKey(oldKey);
      expect(afterByKey.has(newKey)).toBe(true);
      expect(afterByKey.get(newKey)! >= oldAt).toBe(true);
    }

    // The declared residual, asserted rather than implied: the sliced key that
    // `messages` re-derived correctly still sits there as its own orphan row.
    expect(after).toContain(`${USER_ID}|${toLookupKey(v40Key(IL_MOBILE_E164))}|2026-02-01 10:00:00`);
  });

  it("the snapshot's own records survive the chain BY IDENTITY, not by count", async () => {
    await upgrade();

    // The rows this migration rewrites in place must still BE the same rows.
    expect(ids("SELECT id FROM contact_phones WHERE id LIKE 'cp-2700-%'")).toEqual(
      [...CONTACT_PHONE_IDS].sort(),
    );
    expect(ids("SELECT id FROM external_contacts WHERE id LIKE 'x-2700-%'")).toEqual(
      [...EXTERNAL_CONTACT_IDS].sort(),
    );
  });

  it("a SECOND full run over the migrated file changes nothing (BACKLOG-2752 replay)", async () => {
    await upgrade();
    const first = {
      phones: db
        .prepare("SELECT id, phone_normalized FROM contact_phones ORDER BY id")
        .all(),
      external: db
        .prepare("SELECT id, phones_normalized_json FROM external_contacts ORDER BY id")
        .all(),
      plm: plmRows(),
    };

    // Force the chain to replay from below head, which is exactly what the
    // baseline clamp does on a below-baseline database.
    db.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(HEAD_VERSION - 1);
    await upgrade();

    expect(schemaVersion()).toBe(HEAD_VERSION);
    expect(
      JSON.stringify({
        phones: db.prepare("SELECT id, phone_normalized FROM contact_phones ORDER BY id").all(),
        external: db
          .prepare("SELECT id, phones_normalized_json FROM external_contacts ORDER BY id")
          .all(),
        plm: plmRows(),
      }),
    ).toBe(JSON.stringify(first));
  });
});
