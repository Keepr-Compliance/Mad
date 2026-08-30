/**
 * @jest-environment node
 *
 * BACKLOG-2560 — WRITERS MUST AGREE WITH THE DATABASE, AND THE PROOF IS THE ROW.
 *
 * ===========================================================================
 * WHY THESE ASSERTIONS READ THE ROW BACK
 * ===========================================================================
 * Every defect this file guards passed a green suite before it was found,
 * because the existing tests asserted a RETURN VALUE or a MOCK CALL:
 *
 *   - `updateLLMSettings(userId, {})` returned the current settings as a
 *     success value without ever calling `dbRun`. `removeApiKey` passed
 *     `{ <col>: undefined }`, the filter dropped it, and the user's API key
 *     stayed in the database while Settings reported success (BACKLOG-2932).
 *     `llmConfigService.test.ts` asserted the call carrying `undefined` — it
 *     enshrined the bug as the expectation.
 *
 *   - `saveFeedback` omitted `attachment_id` from its INSERT although the
 *     column is real (schema.sql:956) and `UserFeedback` declares it
 *     (models.ts:1421). Nothing observed the omission, because nothing looked
 *     at the stored row.
 *
 * So: a real file-backed database, taken through the app's own migration entry
 * point, and every assertion made against what SQLite actually holds.
 *
 * ===========================================================================
 * THE ANCHOR
 * ===========================================================================
 * A chain that stopped early would produce a smaller schema and let this file
 * "prove" that real columns are phantoms. `schema_version` is asserted equal to
 * the last entry in `MIGRATIONS` — read from the runner, never hardcoded —
 * before any column is compared. Same anchor as
 * `sqlFieldWhitelist.schemaParity.test.ts` (BACKLOG-2739).
 *
 * ===========================================================================
 * SETS, NOT COUNTS
 * ===========================================================================
 * Exact sorted sets throughout. A count cannot tell "wrote 9 columns" apart
 * from "wrote 9 columns, one of them the wrong one".
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
// safeStorage is unavailable under jest; the end-to-end block below only needs
// encrypt/decrypt to be total functions, never real crypto.
jest.mock("../../tokenEncryptionService", () => ({
  __esModule: true,
  default: {
    encrypt: jest.fn((v: string) => `encrypted:${v}`),
    decrypt: jest.fn((v: string) => String(v).replace(/^encrypted:/, "")),
  },
}));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import { saveFeedback } from "../feedbackDbService";
import {
  createLLMSettings,
  updateLLMSettings,
  clearLLMSettingsField,
  getLLMSettingsByUserId,
} from "../llmSettingsDbService";
import type { UserFeedback } from "../../../types";

// Bypass the Jest moduleNameMapper that rewrites the sqlite driver to the
// auto-mock — the whole point of this file is a real file-backed database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Invented identities only. No real contact data in fixtures.
const USER_ID = "2560-user-avery-lindqvist";
const USER_EMAIL = "avery.lindqvist@example.test";
const ATTACHMENT_ID = "2560-attachment-inspection-pdf";
const EMAIL_ID = "2560-email-inspection-thread";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("BACKLOG-2560 — writers vs the real database", () => {
  jest.setTimeout(120000);

  let service: AnyService;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2560-writers-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");

    await service.runMigrations();
    db = service.db as DatabaseType;
    setDb(db);

    // Parents for the foreign keys the fixtures below use. FKs stay ON, so an
    // invented id would fail loudly rather than quietly storing a dangling one.
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id, is_active)
       VALUES (?, ?, 'google', '2560-oauth-id', 1)`,
    ).run(USER_ID, USER_EMAIL);
    // `attachments` carries CHECK (message_id IS NOT NULL OR email_id IS NOT
    // NULL) (schema.sql:384), so an attachment needs a real parent email. The
    // first draft of this fixture invented a bare attachment row and the
    // constraint rejected it — transcribed from the schema, not guessed.
    db.prepare(
      `INSERT INTO emails (id, user_id, subject) VALUES (?, ?, 'Inspection report attached')`,
    ).run(EMAIL_ID, USER_ID);
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename)
       VALUES (?, ?, 'inspection-report.pdf')`,
    ).run(ATTACHMENT_ID, EMAIL_ID);
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    service.db = null;
    setDb(null as never);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  const realColumns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

  // -------------------------------------------------------------------------
  // ANCHOR — everything below is meaningless if the chain did not reach head.
  // -------------------------------------------------------------------------

  it("migrated a real on-disk database all the way to the head migration", () => {
    // BACKLOG-2993: the install head is schema.sql's own seed (the chain is
    // gone); chainHeadVersion() derives it from the artefacts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chainHeadVersion } = require("../../__tests__/helpers/chainHead") as typeof import("../../__tests__/helpers/chainHead");
    const head = chainHeadVersion();

    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(head);

    const list = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = list.find((r) => r.name === "main");
    expect(mainDb?.file).toBeTruthy();
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  });

  // -------------------------------------------------------------------------
  // classification_feedback — the phantom and the omission, both directions.
  // -------------------------------------------------------------------------

  describe("saveFeedback", () => {
    it("has no `field_name` column, so validating one proved nothing", () => {
      // The handler used to validate `field_name` and reject an over-long one.
      // This is the fact that made that validation a phantom.
      expect(realColumns("classification_feedback")).not.toContain("field_name");
      // ...and the exact set, so a future column cannot appear unnoticed.
      expect(realColumns("classification_feedback")).toEqual([
        "attachment_id",
        "contact_id",
        "corrected_value",
        "created_at",
        "feedback_type",
        "id",
        "message_id",
        "original_value",
        "reason",
        "transaction_id",
        "user_id",
      ]);
    });

    it("writes attachment_id — the column UserFeedback declares and the INSERT used to drop", async () => {
      const saved = await saveFeedback({
        user_id: USER_ID,
        attachment_id: ATTACHMENT_ID,
        feedback_type: "document_type",
        original_value: "other",
        corrected_value: "inspection",
        reason: "Header names it an inspection report",
      });

      // The ROW, not the returned object. Before this fix the return value
      // carried attachment_id back from the SELECT as NULL and no assertion
      // on the return value would have distinguished the two.
      const row = db
        .prepare("SELECT * FROM classification_feedback WHERE id = ?")
        .get(saved.id) as Record<string, unknown>;

      expect(row.attachment_id).toBe(ATTACHMENT_ID);

      // Exact set of columns this write populated. A count would not tell
      // "wrote attachment_id" apart from "wrote something else instead".
      const populated = Object.keys(row)
        .filter((k) => row[k] !== null)
        .sort();
      expect(populated).toEqual([
        "attachment_id",
        "corrected_value",
        "created_at",
        "feedback_type",
        "id",
        "original_value",
        "reason",
        "user_id",
      ]);
    });

    it("drops a phantom field instead of storing it, and still lands the real ones", async () => {
      // Exactly what the IPC handler does: an unknown key arrives from the
      // renderer through `sanitizeObject` and is spread into the payload.
      const withPhantom = {
        user_id: USER_ID,
        feedback_type: "contact_role",
        corrected_value: "buyer_agent",
        field_name: "a".repeat(150),
      } as unknown as Omit<UserFeedback, "id" | "created_at">;

      const saved = await saveFeedback(withPhantom);

      const row = db
        .prepare("SELECT * FROM classification_feedback WHERE id = ?")
        .get(saved.id) as Record<string, unknown>;

      expect(Object.keys(row)).not.toContain("field_name");
      expect(row.corrected_value).toBe("buyer_agent");
    });
  });

  // -------------------------------------------------------------------------
  // llm_settings — BACKLOG-2932. The bug's signature is that no UPDATE ran.
  // -------------------------------------------------------------------------

  describe("clearing an API key (BACKLOG-2932)", () => {
    beforeEach(() => {
      db.prepare("DELETE FROM llm_settings WHERE user_id = ?").run(USER_ID);
      createLLMSettings(USER_ID);
      updateLLMSettings(USER_ID, {
        openai_api_key_encrypted: "encrypted-openai-key-fixture",
        anthropic_api_key_encrypted: "encrypted-anthropic-key-fixture",
      });
    });

    const storedKeys = () =>
      db
        .prepare(
          "SELECT openai_api_key_encrypted AS openai, anthropic_api_key_encrypted AS anthropic FROM llm_settings WHERE user_id = ?",
        )
        .get(USER_ID) as { openai: string | null; anthropic: string | null };

    it("removes the key from the DATABASE, not just from the returned object", () => {
      expect(storedKeys().openai).toBe("encrypted-openai-key-fixture");

      clearLLMSettingsField(USER_ID, "openai_api_key_encrypted");

      // THIS is the assertion the old code failed. It returned the settings
      // object as success while the row below still held the key.
      expect(storedKeys().openai).toBeNull();
    });

    it("clears only the column asked for", () => {
      clearLLMSettingsField(USER_ID, "openai_api_key_encrypted");

      const keys = storedKeys();
      expect(keys.openai).toBeNull();
      expect(keys.anthropic).toBe("encrypted-anthropic-key-fixture");
    });

    it("refuses a column that is not clearable", () => {
      expect(() =>
        clearLLMSettingsField(
          USER_ID,
          "preferred_provider" as unknown as "openai_api_key_encrypted",
        ),
      ).toThrow(/not clearable/);

      // ...and left the row alone.
      expect(
        (
          db
            .prepare("SELECT preferred_provider AS p FROM llm_settings WHERE user_id = ?")
            .get(USER_ID) as { p: string }
        ).p,
      ).toBe("openai");
    });

    it("throws on a payload with no writable field instead of reporting success", () => {
      // The shape that let `removeApiKey` report success for a write that never
      // happened: every value dropped, nothing left to set.
      expect(() => updateLLMSettings(USER_ID, {})).toThrow(/No valid fields to update/);
      expect(() =>
        updateLLMSettings(USER_ID, { openai_api_key_encrypted: undefined }),
      ).toThrow(/No valid fields to update/);

      // The row is untouched either way — a throw must not be a partial write.
      expect(storedKeys().openai).toBe("encrypted-openai-key-fixture");
      expect(getLLMSettingsByUserId(USER_ID)?.anthropic_api_key_encrypted).toBe(
        "encrypted-anthropic-key-fixture",
      );
    });

    /**
     * THE CONTROL THAT WOULD HAVE CAUGHT BACKLOG-2932.
     *
     * `llmConfigService.test.ts` mocks the whole db module, so reverting
     * `removeApiKey` to its `{ <col>: undefined }` payload leaves that suite
     * fully green — measured, 40/40 passing with the bug reinstated. The defect
     * lives in the gap between the caller and the writer, and only a test that
     * drives the real caller into a real database can stand in that gap.
     */
    it("removeApiKey — the real caller, against the real row", async () => {
      // Deferred require so the mock factories above are applied first.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const configService = require("../../llm/llmConfigService").default;

      expect(storedKeys().openai).toBe("encrypted-openai-key-fixture");

      await configService.removeApiKey(USER_ID, "openai");

      expect(storedKeys().openai).toBeNull();
      expect(storedKeys().anthropic).toBe("encrypted-anthropic-key-fixture");
    });
  });
});
