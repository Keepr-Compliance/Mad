/**
 * @jest-environment node
 *
 * BACKLOG-2960 wave 1 lane A — llmSettingsDbService AGAINST A REAL DATABASE.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS BEFORE THE CONVERSION
 * ===========================================================================
 * The export seam turns every `db/**` export promise-returning. The failure
 * mode of that conversion is not a crash — it is a caller that forgets to
 * `await` and reads properties off a `Promise`, which are all `undefined`.
 * Nothing throws. The app quietly reports "no API key", "no consent",
 * "no budget limit".
 *
 * SR 6683f005 §4-A1 measured this module as a BLIND SPOT: twelve test files
 * reach it, `llmSettingsDbService.test.ts` mocks `../core/dbConnection`, and
 * nine of the rest mock `llmConfigService` itself. The only real-driver reader
 * is `writerColumnParity-2560.test.ts`, and it covers four of the ten exports
 * and one caller path. A dropped `await` in the other six, or in any of the
 * caller paths below, would have been invisible.
 *
 * So this file is committed FIRST, green against the UNCONVERTED synchronous
 * code, and the conversion lands on top of it. Every assertion is made against
 * what SQLite actually holds, or against a value the caller actually returns —
 * never against a mock call.
 *
 * ===========================================================================
 * THE THREE CALLER PATHS, AND WHY EACH IS HERE
 * ===========================================================================
 *   1. `LLMConfigService.getUserConfig` — seven of its methods read the seam.
 *      A dropped `await` yields `hasConsent: false` and
 *      `platformAllowanceRemaining: NaN`.
 *
 *   2. `hybridExtractorService.getLLMConfig` -> `getDecryptedApiKey`, which
 *      reaches the seam through `require('../db/llmSettingsDbService')`
 *      (hybridExtractorService.ts:848). `require()` is untyped, so the value is
 *      `any`: `tsc` cannot see a dropped `await` there and neither can
 *      `no-floating-promises`. `if (!settings)` on a `Promise` is FALSE, the
 *      encrypted key reads `undefined`, and the method returns `null` — the LLM
 *      path disables itself with every static check green. This is the one
 *      assertion in the file that no machine other than a real run can make.
 *
 *   3. `BaseLLMService.checkBudget` / `recordUsage` through `LLMDbCallbacks`
 *      (baseLLMService.ts:24-26), which `llmConfigService.ts:104-111` fills
 *      with the seam functions directly. `incrementTokenUsage` is declared
 *      `=> void`, and TypeScript accepts a `=> Promise<void>` there, so that
 *      one is a silent floating promise unless the interface moves with the
 *      seam. A dropped `await` in `checkBudget` makes an over-budget user
 *      `allowed: true`.
 *
 * ===========================================================================
 * FIXTURES
 * ===========================================================================
 * Invented identities only. No real contact data — this repository is public.
 * The schema is taken through the app's own migration entry point and anchored
 * to the chain head before anything else is asserted, so a chain that stopped
 * early cannot let this file "prove" that real columns are phantoms.
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
// safeStorage is unavailable under jest. The caller blocks below only need
// encrypt/decrypt to be total, invertible functions — never real crypto — so
// that "the key that came back is the key that went in" is checkable.
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
import {
  getLLMSettingsByUserId,
  createLLMSettings,
  getOrCreateLLMSettings,
  updateLLMSettings,
  clearLLMSettingsField,
  incrementTokenUsage,
  incrementPlatformAllowanceUsage,
  resetMonthlyUsage,
  setLLMDataConsent,
  deleteLLMSettings,
} from "../llmSettingsDbService";

// Bypass the Jest moduleNameMapper that rewrites the sqlite driver to the
// auto-mock — the whole point of this file is a real file-backed database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Invented identities only. No real contact data in fixtures.
const USER_ID = "2960-user-rowan-castellanos";
const USER_EMAIL = "rowan.castellanos@example.test";
const OPENAI_KEY = "sk-fixture-openai-2960";
const ANTHROPIC_KEY = "sk-fixture-anthropic-2960";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("BACKLOG-2960 — llmSettingsDbService and its callers, against the real row", () => {
  jest.setTimeout(120000);

  let service: AnyService;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2960-llm-"));
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

    // `llm_settings.user_id` is a FK to `users_local(id)` (schema.sql). FKs stay
    // ON, so an invented user id would fail loudly rather than quietly storing
    // a dangling row.
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id, is_active)
       VALUES (?, ?, 'google', '2960-oauth-id', 1)`,
    ).run(USER_ID, USER_EMAIL);
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

  /** The stored row, read with the raw driver — never through the module under test. */
  const storedRow = (): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM llm_settings WHERE user_id = ?").get(USER_ID) as
      | Record<string, unknown>
      | undefined;

  const rowCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM llm_settings WHERE user_id = ?").get(USER_ID) as {
      n: number;
    }).n;

  const today = (): string =>
    (db.prepare("SELECT DATE('now') AS d").get() as { d: string }).d;

  beforeEach(async () => {
    db.prepare("DELETE FROM llm_settings WHERE user_id = ?").run(USER_ID);
    await createLLMSettings(USER_ID);
  });

  // -------------------------------------------------------------------------
  // ANCHOR — everything below is meaningless if the chain did not reach head.
  // -------------------------------------------------------------------------

  it("migrated a real on-disk database all the way to the head migration", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chainHeadVersion } = require("../../__tests__/helpers/chainHead") as typeof import("../../__tests__/helpers/chainHead");
    const head = chainHeadVersion();

    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;

    expect(version).toBe(head);
  });

  // -------------------------------------------------------------------------
  // THE TEN SEAM EXPORTS, each asserted against the stored row.
  // -------------------------------------------------------------------------

  describe("createLLMSettings", () => {
    it("writes a row and returns settings that match it", async () => {
      db.prepare("DELETE FROM llm_settings WHERE user_id = ?").run(USER_ID);
      expect(rowCount()).toBe(0);

      const created = await createLLMSettings(USER_ID);

      expect(rowCount()).toBe(1);
      const row = storedRow();
      expect(row).toBeDefined();
      expect(created.id).toBe(row!.id);
      expect(created.user_id).toBe(USER_ID);
      // BACKLOG-2313: auto-detect defaults OFF, and the default is the schema's,
      // not this file's opinion of it.
      expect(row!.enable_auto_detect).toBe(0);
      expect(created.enable_auto_detect).toBe(false);
    });

    /**
     * A FAILED WRITE THROWS SYNCHRONOUSLY. This is the seam property, and it has
     * no schema dependency: `updateLLMSettings` on a user with no row fails in
     * the module's own read-back, not in SQLite.
     *
     * These wrappers are plain functions returning promises, never `async`, so
     * the throw happens BEFORE the promise is constructed and an enclosing
     * `better-sqlite3` transaction rolls back rather than committing over it
     * (SR 79c3aa69 §2a). `expect(() => …).toThrow()` — not `.rejects` — is what
     * asserts that, and it is what goes red if anyone makes one of these
     * `async`.
     */
    it("a failed write throws SYNCHRONOUSLY, not as a rejection", () => {
      db.prepare("DELETE FROM llm_settings WHERE user_id = ?").run(USER_ID);
      expect(rowCount()).toBe(0);

      expect(() => updateLLMSettings(USER_ID, { openai_model: "gpt-4o" })).toThrow(
        `LLM settings not found for user ${USER_ID}`,
      );
    });

    /**
     * The same property provoked at the DRIVER instead of in application code.
     *
     * The DDL is asserted first, from the migrated database rather than from
     * `schema.sql`, because without the constraint the assertion below proves
     * nothing — and because this test failed on CI while passing locally
     * (BACKLOG-2960 lane A round 1, PR #2544). If it fails again, the first
     * assertion names the cause instead of leaving it to be guessed at.
     */
    it("refuses a second row for the same user (user_id is UNIQUE)", () => {
      const ddl = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_settings'",
          )
          .get() as { sql: string }
      ).sql;
      expect(ddl).toMatch(/user_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

      expect(rowCount()).toBe(1);
      expect(() => createLLMSettings(USER_ID)).toThrow(/UNIQUE constraint failed/);
      expect(rowCount()).toBe(1);
    });
  });

  describe("getLLMSettingsByUserId", () => {
    it("returns the values SQLite holds, with INTEGER 0/1 mapped to boolean", async () => {
      db.prepare(
        `UPDATE llm_settings
            SET tokens_used_this_month = 4321,
                use_platform_allowance = 1,
                enable_role_extraction = 0
          WHERE user_id = ?`,
      ).run(USER_ID);

      const settings = await getLLMSettingsByUserId(USER_ID);

      expect(settings).not.toBeNull();
      expect(settings!.tokens_used_this_month).toBe(4321);
      expect(settings!.use_platform_allowance).toBe(true);
      expect(settings!.enable_role_extraction).toBe(false);
    });

    it("returns null for a user with no row", async () => {
      expect(await getLLMSettingsByUserId("2960-user-with-no-settings")).toBeNull();
    });
  });

  describe("getOrCreateLLMSettings", () => {
    it("returns the EXISTING row rather than creating a second one", async () => {
      const existingId = storedRow()!.id;

      const settings = await getOrCreateLLMSettings(USER_ID);

      expect(settings.id).toBe(existingId);
      expect(rowCount()).toBe(1);
    });

    it("creates the row when there is none", async () => {
      db.prepare("DELETE FROM llm_settings WHERE user_id = ?").run(USER_ID);
      expect(rowCount()).toBe(0);

      const settings = await getOrCreateLLMSettings(USER_ID);

      expect(rowCount()).toBe(1);
      expect(settings.user_id).toBe(USER_ID);
      expect(settings.id).toBe(storedRow()!.id);
    });
  });

  describe("updateLLMSettings", () => {
    it("changes the ROW, not just the returned object", async () => {
      const returned = await updateLLMSettings(USER_ID, {
        preferred_provider: "anthropic",
        anthropic_model: "claude-3-opus-20240229",
        budget_limit_tokens: 12345,
      });

      const row = storedRow()!;
      expect(row.preferred_provider).toBe("anthropic");
      expect(row.anthropic_model).toBe("claude-3-opus-20240229");
      expect(row.budget_limit_tokens).toBe(12345);
      expect(returned.preferred_provider).toBe("anthropic");
      expect(returned.budget_limit_tokens).toBe(12345);
    });

    it("stores booleans as SQLite INTEGER 0/1", async () => {
      await updateLLMSettings(USER_ID, {
        use_platform_allowance: true,
        enable_auto_detect: true,
        enable_role_extraction: false,
      });

      const row = storedRow()!;
      expect(row.use_platform_allowance).toBe(1);
      expect(row.enable_auto_detect).toBe(1);
      expect(row.enable_role_extraction).toBe(0);
    });

    it("writes only the columns supplied and leaves the rest alone", async () => {
      await updateLLMSettings(USER_ID, { openai_model: "gpt-4o" });

      const row = storedRow()!;
      expect(row.openai_model).toBe("gpt-4o");
      expect(row.anthropic_model).toBe("claude-3-haiku-20240307");
      expect(row.preferred_provider).toBe("openai");
    });
  });

  describe("clearLLMSettingsField", () => {
    beforeEach(async () => {
      await updateLLMSettings(USER_ID, {
        openai_api_key_encrypted: `encrypted:${OPENAI_KEY}`,
        anthropic_api_key_encrypted: `encrypted:${ANTHROPIC_KEY}`,
      });
    });

    it("sets the column to NULL in the row and leaves its sibling", async () => {
      await clearLLMSettingsField(USER_ID, "openai_api_key_encrypted");

      const row = storedRow()!;
      expect(row.openai_api_key_encrypted).toBeNull();
      expect(row.anthropic_api_key_encrypted).toBe(`encrypted:${ANTHROPIC_KEY}`);
    });
  });

  describe("incrementTokenUsage", () => {
    it("accumulates into the row rather than replacing it", async () => {
      await incrementTokenUsage(USER_ID, 100);
      await incrementTokenUsage(USER_ID, 250);

      expect(storedRow()!.tokens_used_this_month).toBe(350);
    });
  });

  describe("incrementPlatformAllowanceUsage", () => {
    it("accumulates into platform_allowance_used, and not into tokens_used_this_month", async () => {
      await incrementPlatformAllowanceUsage(USER_ID, 40);
      await incrementPlatformAllowanceUsage(USER_ID, 60);

      const row = storedRow()!;
      expect(row.platform_allowance_used).toBe(100);
      expect(row.tokens_used_this_month).toBe(0);
    });
  });

  describe("resetMonthlyUsage", () => {
    it("zeroes the month's tokens, stamps the reset date, and leaves the allowance alone", async () => {
      await updateLLMSettings(USER_ID, {
        tokens_used_this_month: 9000,
        platform_allowance_used: 77,
      });

      await resetMonthlyUsage(USER_ID);

      const row = storedRow()!;
      expect(row.tokens_used_this_month).toBe(0);
      expect(row.budget_reset_date).toBe(today());
      expect(row.platform_allowance_used).toBe(77);
    });
  });

  describe("setLLMDataConsent", () => {
    it("records consent and stamps the time it was given", async () => {
      const settings = await setLLMDataConsent(USER_ID, true);

      const row = storedRow()!;
      expect(row.llm_data_consent).toBe(1);
      expect(row.llm_data_consent_at).not.toBeNull();
      expect(settings.llm_data_consent).toBe(true);
    });

    it("withdrawing consent clears the timestamp too", async () => {
      await setLLMDataConsent(USER_ID, true);
      const settings = await setLLMDataConsent(USER_ID, false);

      const row = storedRow()!;
      expect(row.llm_data_consent).toBe(0);
      expect(row.llm_data_consent_at).toBeNull();
      expect(settings.llm_data_consent).toBe(false);
    });
  });

  describe("deleteLLMSettings", () => {
    it("removes the row", async () => {
      expect(rowCount()).toBe(1);

      await deleteLLMSettings(USER_ID);

      expect(rowCount()).toBe(0);
      expect(await getLLMSettingsByUserId(USER_ID)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CALLER PATH 1 — LLMConfigService, the seven methods that read the seam.
  // -------------------------------------------------------------------------

  describe("LLMConfigService against the real row", () => {
    // Deferred require so the mock factories above are applied first.
    const configService = (): AnyService =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../llm/llmConfigService").default;

    it("getUserConfig reports the row's real values, not the shape of a Promise", async () => {
      await updateLLMSettings(USER_ID, {
        openai_api_key_encrypted: `encrypted:${OPENAI_KEY}`,
        preferred_provider: "openai",
        openai_model: "gpt-4o",
        tokens_used_this_month: 1500,
        budget_limit_tokens: 20000,
        platform_allowance_tokens: 5000,
        platform_allowance_used: 1200,
        use_platform_allowance: true,
        enable_auto_detect: true,
      });
      await setLLMDataConsent(USER_ID, true);

      const config = await configService().getUserConfig(USER_ID);

      // A dropped `await` inside getUserConfig makes every one of these read off
      // a Promise: the booleans go false and the arithmetic goes NaN.
      expect(config.hasOpenAI).toBe(true);
      expect(config.hasAnthropic).toBe(false);
      expect(config.hasConsent).toBe(true);
      expect(config.preferredProvider).toBe("openai");
      expect(config.openAIModel).toBe("gpt-4o");
      expect(config.tokensUsed).toBe(1500);
      expect(config.budgetLimit).toBe(20000);
      expect(config.usePlatformAllowance).toBe(true);
      expect(config.autoDetectEnabled).toBe(true);
      expect(config.platformAllowanceRemaining).toBe(3800);
      expect(Number.isNaN(config.platformAllowanceRemaining)).toBe(false);
    });

    it("setApiKey stores the ENCRYPTED key in the row", async () => {
      await configService().setApiKey(USER_ID, "anthropic", ANTHROPIC_KEY);

      const row = storedRow()!;
      expect(row.anthropic_api_key_encrypted).toBe(`encrypted:${ANTHROPIC_KEY}`);
      expect(row.anthropic_api_key_encrypted).not.toBe(ANTHROPIC_KEY);
    });

    it("removeApiKey clears the row's column and leaves the other provider", async () => {
      await configService().setApiKey(USER_ID, "openai", OPENAI_KEY);
      await configService().setApiKey(USER_ID, "anthropic", ANTHROPIC_KEY);

      await configService().removeApiKey(USER_ID, "openai");

      const row = storedRow()!;
      expect(row.openai_api_key_encrypted).toBeNull();
      expect(row.anthropic_api_key_encrypted).toBe(`encrypted:${ANTHROPIC_KEY}`);
    });

    it("updatePreferences writes each preference to the row", async () => {
      await configService().updatePreferences(USER_ID, {
        preferredProvider: "anthropic",
        openAIModel: "gpt-4o",
        anthropicModel: "claude-3-opus-20240229",
        enableAutoDetect: true,
        enableRoleExtraction: false,
        usePlatformAllowance: true,
        budgetLimit: 4242,
      });

      const row = storedRow()!;
      expect(row.preferred_provider).toBe("anthropic");
      expect(row.openai_model).toBe("gpt-4o");
      expect(row.anthropic_model).toBe("claude-3-opus-20240229");
      expect(row.enable_auto_detect).toBe(1);
      expect(row.enable_role_extraction).toBe(0);
      expect(row.use_platform_allowance).toBe(1);
      expect(row.budget_limit_tokens).toBe(4242);
    });

    it("recordConsent writes consent to the row", async () => {
      await configService().recordConsent(USER_ID, true);

      expect(storedRow()!.llm_data_consent).toBe(1);
      expect(storedRow()!.llm_data_consent_at).not.toBeNull();
    });

    it("getUsageStats reports the row's numbers, and the remaining budget arithmetic", async () => {
      await updateLLMSettings(USER_ID, {
        tokens_used_this_month: 800,
        budget_limit_tokens: 2000,
        platform_allowance_tokens: 500,
        platform_allowance_used: 125,
        budget_reset_date: "2026-09-01",
      });

      const stats = await configService().getUsageStats(USER_ID);

      expect(stats.tokensThisMonth).toBe(800);
      expect(stats.budgetLimit).toBe(2000);
      expect(stats.budgetRemaining).toBe(1200);
      expect(stats.platformAllowance).toBe(500);
      expect(stats.platformUsed).toBe(125);
      expect(stats.resetDate).toBe("2026-09-01");
    });

    it("canUseLLM refuses when the row says consent was never given", async () => {
      await setLLMDataConsent(USER_ID, false);
      await configService().setApiKey(USER_ID, "openai", OPENAI_KEY);

      const availability = await configService().canUseLLM(USER_ID);

      expect(availability.canUse).toBe(false);
      expect(availability.reason).toMatch(/consent/i);
    });
  });

  // -------------------------------------------------------------------------
  // CALLER PATH 2 — hybridExtractorService's `require()`d read.
  //
  // THE ONE NO STATIC CHECK CAN MAKE. `require()` returns `any`, so a dropped
  // `await` at hybridExtractorService.ts:853 is invisible to `tsc` and to
  // `no-floating-promises`. It does not throw either: `if (!settings)` on a
  // Promise is false, the encrypted key reads `undefined`, and the method
  // returns null — "LLM not configured", silently and permanently.
  //
  // `getLLMConfig` is private; it is driven here through a documented cast
  // because the public entries (`extract`, `extractContactRoles`) go on to make
  // provider API calls, and the boundary this test is about is upstream of them.
  // -------------------------------------------------------------------------

  describe("hybridExtractorService.getLLMConfig — the require()d read of the seam", () => {
    it("returns the DECRYPTED key that the real row holds", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const extractor: AnyService = require("../../extraction/hybridExtractorService").default;

      await updateLLMSettings(USER_ID, {
        openai_api_key_encrypted: `encrypted:${OPENAI_KEY}`,
        preferred_provider: "openai",
        openai_model: "gpt-4o-mini",
      });
      await setLLMDataConsent(USER_ID, true);

      const llmConfig = await extractor.getLLMConfig({
        userId: USER_ID,
        useLLM: true,
        usePatternMatching: true,
      });

      expect(llmConfig).not.toBeNull();
      expect(llmConfig.provider).toBe("openai");
      expect(llmConfig.apiKey).toBe(OPENAI_KEY);
      expect(llmConfig.model).toBe("gpt-4o-mini");
    });

    it("returns null when the row genuinely has no key — the honest null, for contrast", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const extractor: AnyService = require("../../extraction/hybridExtractorService").default;

      await clearLLMSettingsField(USER_ID, "openai_api_key_encrypted");
      await setLLMDataConsent(USER_ID, true);

      const llmConfig = await extractor.getLLMConfig({
        userId: USER_ID,
        useLLM: true,
        usePatternMatching: true,
      });

      expect(llmConfig).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CALLER PATH 3 — LLMDbCallbacks, the interface the seam is injected into.
  // -------------------------------------------------------------------------

  describe("BaseLLMService through LLMDbCallbacks", () => {
    /**
     * Built exactly as `llmConfigService.ts:104-111` builds it — the seam
     * functions handed straight to the interface. If the interface stops
     * matching the seam, this is where it shows.
     */
    const serviceWithCallbacks = (): AnyService => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAIService } = require("../../llm/openAIService");
      const svc = new OpenAIService();
      svc.setDbCallbacks({
        getSettings: getLLMSettingsByUserId,
        incrementTokenUsage: incrementTokenUsage,
        resetMonthlyUsage: resetMonthlyUsage,
      });
      return svc;
    };

    it("checkBudget REFUSES a request that exceeds the row's remaining budget", async () => {
      await updateLLMSettings(USER_ID, {
        budget_limit_tokens: 1000,
        tokens_used_this_month: 900,
        // Set to this month, or shouldResetMonthly() fires and zeroes the usage
        // before the limit is compared (baseLLMService.ts:286).
        budget_reset_date: today(),
        use_platform_allowance: false,
      });

      const result = await serviceWithCallbacks().checkBudget(USER_ID, {
        promptTokens: 400,
        maxCompletionTokens: 100,
        totalEstimate: 500,
        estimatedCost: 0.01,
      });

      // A dropped `await` on getSettings makes `settings` a Promise:
      // `budget_limit_tokens` reads undefined, `!limit` is true, and this
      // returns { allowed: true, remaining: Infinity } for an over-budget user.
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(100);
    });

    it("checkBudget ALLOWS a request inside the budget", async () => {
      await updateLLMSettings(USER_ID, {
        budget_limit_tokens: 10000,
        tokens_used_this_month: 900,
        budget_reset_date: today(),
        use_platform_allowance: false,
      });

      const result = await serviceWithCallbacks().checkBudget(USER_ID, {
        promptTokens: 400,
        maxCompletionTokens: 100,
        totalEstimate: 500,
        estimatedCost: 0.01,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9100);
    });

    it("recordUsage increments the ROW through the injected callback", async () => {
      await serviceWithCallbacks().recordUsage(USER_ID, {
        promptTokens: 30,
        completionTokens: 12,
        totalTokens: 42,
        estimatedCost: 0.001,
      });

      // The callback is declared `=> void`, which TypeScript accepts a
      // promise-returning function for. Only the row can say whether it ran.
      expect(storedRow()!.tokens_used_this_month).toBe(42);
    });
  });
});
