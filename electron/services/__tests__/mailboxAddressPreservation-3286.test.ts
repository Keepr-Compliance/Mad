/**
 * @jest-environment node
 *
 * BACKLOG-3286 — A TOKEN REFRESH MUST NOT ERASE THE MAILBOX ADDRESS.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Two Microsoft token refreshers saved their result through
 * `saveOAuthTokenSync`, which is an upsert: every column the payload omitted
 * was overwritten. The Outlook fetch refresh omitted the address and the
 * granted scopes, so one refresh left a connected mailbox with neither — and
 * when the row had been removed while a sync was running, the upsert created a
 * new active row. The Microsoft refresher copied the (by then empty) address
 * forward and wrote `scope` without the JSON encoding every reader expects.
 *
 * The fix, all asserted below:
 *   - both refreshers update the loaded row BY ID with only the fields the
 *     refresh produced (W, F, F2);
 *   - storage refuses a mailbox save with an empty address (S);
 *   - a mailbox row that already lost its address is repaired before any
 *     Outlook store path reads it (R — added with the repair).
 *
 * ===========================================================================
 * WHY A REAL, MIGRATED DATABASE
 * ===========================================================================
 * The defect lives in SQL: an `ON CONFLICT … DO UPDATE` that overwrites
 * omitted columns, and an `INSERT` that fires when the row is gone. A mocked
 * `saveOAuthToken` cannot show either. Every assertion reads the row back from
 * a database built by the app's own `runMigrations()` on the real driver —
 * same harness as `electron/__tests__/transactionNullClear-2759.test.ts`.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/mailboxAddressPreservation-3286.test.ts
 *
 * ===========================================================================
 * WHERE THE SHAPES COME FROM
 * ===========================================================================
 * - 401 error and refresh response: `outlookFetchService.test.ts` ("should
 *   retry request after successful token refresh") and `TokenResponse` in
 *   `microsoftAuthService.ts`.
 * - Stored scopes: the connect handlers pass the response's space-separated
 *   `scope` string, which the upsert stores JSON-encoded.
 * - A refresh response without `refresh_token` or `scope` is a DEFENSIVE case,
 *   not an observed one: the app requests offline access, for which the
 *   provider documents both fields.
 *
 * The network is never reached: axios is mocked and the provider's token call
 * is spied. Fixture values are invented.
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
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
jest.mock("axios");
// For the email store path (R controls): the same three stand-ins as
// emailSyncService.forceRecache-2856.test.ts — retries run once, the cache
// window is fixed, and the derivation reprocess pass is a no-op.
jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));
jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));
jest.mock("../emailDerivationReprocessService", () => ({
  reprocessEmailDerivations: jest.fn().mockResolvedValue({ scanned: 0, rewritten: 0, unchanged: 0, batches: 0 }),
}));

import axios from "axios";
import { setDb, setDbPath, setEncryptionKey } from "../db/core/dbConnection";
import type outlookFetchServiceType from "../outlookFetchService";
import type microsoftAuthServiceType from "../microsoftAuthService";
import type connectionStatusServiceType from "../connectionStatusService";
import type * as emailSyncModule from "../emailSyncService";
import type { StoreableEmail } from "../emailSyncService";

// Bypass the moduleNameMapper that rewrites the driver to the auto-mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

type RefreshResponse = Awaited<ReturnType<typeof microsoftAuthServiceType.refreshToken>>;

const USER = "user-3286";
const ADDRESS = "mailbox-owner@example.invalid";
/** What the row holds before a refresh. Deliberately DIFFERENT from RESPONSE_SCOPE (K1). */
const SEEDED_SCOPES = JSON.stringify("openid profile User.Read");
/** What the refresh response carries. */
const RESPONSE_SCOPE = "User.Read Mail.Read Contacts.Read";
const SEEDED_PERMISSIONS_AT = "2026-01-01T00:00:00.000Z";

const mockAxios = axios as unknown as jest.Mock;

describe("a token refresh keeps the mailbox address (BACKLOG-3286)", () => {
  jest.setTimeout(120000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let db: DatabaseType;
  let tmpDir: string;
  let outlookFetch: typeof outlookFetchServiceType;
  let microsoftAuth: typeof microsoftAuthServiceType;
  let connectionStatus: typeof connectionStatusServiceType;
  let emailSync: typeof emailSyncModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logMock: any;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3286-address-"));
    const dbFile = path.join(tmpDir, "mad.db");
    db = new RealDatabase(dbFile) as unknown as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Deferred requires so the jest.mock factories above apply first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");
    await service.runMigrations();
    db = service.db as DatabaseType;
    setDb(db);

    // oauth_tokens.user_id is a real foreign key, and foreign_keys is ON.
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'microsoft', 'oid-3286')",
    ).run(USER, ADDRESS);

    /* eslint-disable @typescript-eslint/no-require-imports */
    outlookFetch = require("../outlookFetchService").default;
    microsoftAuth = require("../microsoftAuthService").default;
    connectionStatus = require("../connectionStatusService").default;
    emailSync = require("../emailSyncService");
    logMock = require("../logService").default;
    /* eslint-enable @typescript-eslint/no-require-imports */
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

  beforeEach(() => {
    jest.restoreAllMocks();
    mockAxios.mockReset();
    jest.clearAllMocks();
    db.prepare("DELETE FROM emails WHERE user_id = ?").run(USER);
    db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(USER);
  });

  // -------------------------------------------------------------------------
  // Fixture helpers. Pre-state is raw SQL so it never depends on the fix.
  // -------------------------------------------------------------------------
  function seedMailbox(opts: {
    provider?: "google" | "microsoft";
    address: string | null;
    scopes: string | null;
    expiresAt?: string;
  }): void {
    const provider = opts.provider ?? "microsoft";
    db.prepare(
      `INSERT INTO oauth_tokens
         (id, user_id, provider, purpose, access_token, refresh_token, token_expires_at,
          scopes_granted, connected_email_address, mailbox_connected, permissions_granted_at)
       VALUES (?, ?, ?, 'mailbox', 'stored-access', 'stored-refresh', ?, ?, ?, 1, ?)`,
    ).run(
      `row-${provider}`,
      USER,
      provider,
      opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
      opts.scopes,
      opts.address,
      SEEDED_PERMISSIONS_AT,
    );
  }

  /** The mailbox row as the DATABASE has it. */
  function row(provider: "google" | "microsoft" = "microsoft"): Record<string, unknown> | undefined {
    return db
      .prepare("SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ? AND purpose = 'mailbox'")
      .get(USER, provider) as Record<string, unknown> | undefined;
  }

  function refreshResponse(overrides: { refreshToken?: string | null; scope?: string | null } = {}): RefreshResponse {
    const response: Record<string, unknown> = { access_token: "refreshed-access", expires_in: 3600 };
    const refreshToken = overrides.refreshToken === undefined ? "refreshed-refresh" : overrides.refreshToken;
    const scope = overrides.scope === undefined ? RESPONSE_SCOPE : overrides.scope;
    if (refreshToken !== null) response.refresh_token = refreshToken;
    if (scope !== null) response.scope = scope;
    return response as unknown as RefreshResponse;
  }

  /**
   * An Outlook fetch whose first Graph call answers 401, which runs the fetch
   * service's own refresh. Same 401 shape and call sequence as the existing
   * "should retry request after successful token refresh" test.
   */
  async function outlookFetchWith401(
    response: RefreshResponse,
    opts: { beforeFirstCall?: () => void; initialize?: boolean } = {},
  ): Promise<jest.SpyInstance> {
    let calls = 0;
    mockAxios.mockImplementation(() => {
      calls++;
      if (calls === 1) opts.beforeFirstCall?.();
      if (calls <= 2) return Promise.reject({ response: { status: 401 }, message: "Unauthorized" });
      return Promise.resolve({ data: { value: [], "@odata.count": 0 } });
    });
    const spy = jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(response);
    if (opts.initialize !== false) await outlookFetch.initialize(USER);
    await outlookFetch.searchEmails({});
    return spy;
  }

  // -------------------------------------------------------------------------
  // ANCHOR — every assertion below is meaningless if the chain did not run.
  // -------------------------------------------------------------------------
  it("migrated a real on-disk database to the head migration", () => {
    const head = service.constructor.MIGRATIONS.length
      ? service.constructor.MIGRATIONS[service.constructor.MIGRATIONS.length - 1].version
      : service.constructor.BASELINE_VERSION;
    const version = (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version;
    expect(version).toBe(head);
  });

  // -------------------------------------------------------------------------
  // W — the Outlook fetch refresh
  // -------------------------------------------------------------------------
  describe("W1: a 401 refresh during an Outlook fetch", () => {
    beforeEach(async () => {
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      await outlookFetchWith401(refreshResponse());
    });

    it("keeps the mailbox address", () => {
      expect(row()?.connected_email_address).toBe(ADDRESS);
    });

    it("stores the new access token and a new expiry", () => {
      expect(row()?.access_token).toBe("refreshed-access");
      expect(Date.parse(String(row()?.token_expires_at))).toBeGreaterThan(Date.now() + 3000_000);
    });

    it("stores the new refresh token", () => {
      expect(row()?.refresh_token).toBe("refreshed-refresh");
    });

    it("leaves the connection's other columns alone", () => {
      expect(row()?.permissions_granted_at).toBe(SEEDED_PERMISSIONS_AT);
      expect(row()?.mailbox_connected).toBe(1);
      expect(row()?.is_active).toBe(1);
    });

    it("retries the Graph request with the new access token", () => {
      const last = mockAxios.mock.calls[mockAxios.mock.calls.length - 1][0] as {
        headers: Record<string, string>;
      };
      expect(last.headers.Authorization).toBe("Bearer refreshed-access");
    });
  });

  describe("W1-rt: a refresh response without a refresh token", () => {
    it("keeps the stored refresh token, in the row and in memory", async () => {
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      await outlookFetchWith401(refreshResponse({ refreshToken: null }));
      expect(row()?.refresh_token).toBe("stored-refresh");

      // A second 401 on the SAME service instance, without re-initializing, must
      // present the stored refresh token — not `undefined` from the response.
      const spy = await outlookFetchWith401(refreshResponse({ refreshToken: null }), { initialize: false });
      expect(spy).toHaveBeenCalledWith("stored-refresh");
    });
  });

  describe("W1-del: the mailbox is removed while the sync runs", () => {
    it("does not bring the row back", async () => {
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      await outlookFetchWith401(refreshResponse(), {
        beforeFirstCall: () => db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(USER),
      });
      expect(row()).toBeUndefined();
    });

    it("does not bring the row back when it is removed while the refresh itself is in flight", async () => {
      // The late variant: the row still exists when the 401 arrives and is gone
      // by the time the refresh returns. Catches an implementation that reads
      // the row first and writes it back afterwards.
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      await outlookFetch.initialize(USER);
      let calls = 0;
      mockAxios.mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject({ response: { status: 401 }, message: "Unauthorized" });
        return Promise.resolve({ data: { value: [], "@odata.count": 0 } });
      });
      jest.spyOn(microsoftAuth, "refreshToken").mockImplementation(async () => {
        db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(USER);
        return refreshResponse();
      });
      await outlookFetch.searchEmails({});
      expect(row()).toBeUndefined();
    });
  });

  describe("W2: the Outlook fetch refresh followed by the Microsoft refresher", () => {
    it("still has the address, and the refresher reports success", async () => {
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      await outlookFetchWith401(refreshResponse());
      jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(refreshResponse());
      const result = await microsoftAuth.refreshAccessToken(USER);
      expect(result.success).toBe(true);
      expect(row()?.connected_email_address).toBe(ADDRESS);
    });
  });

  // -------------------------------------------------------------------------
  // F2 — scopes from BOTH refreshers (K1: seeded value differs from response)
  // -------------------------------------------------------------------------
  describe("F2: granted scopes written by a refresh", () => {
    const writers: Array<[string, (response: RefreshResponse) => Promise<void>]> = [
      ["the Outlook fetch refresh", async (response) => { await outlookFetchWith401(response); }],
      [
        "the Microsoft refresher",
        async (response) => {
          jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(response);
          const result = await microsoftAuth.refreshAccessToken(USER);
          expect(result.success).toBe(true);
        },
      ],
    ];
    const seeds: Array<[string, string | null]> = [
      ["no stored scopes", null],
      ["different stored scopes", SEEDED_SCOPES],
    ];

    for (const [writerName, runWriter] of writers) {
      for (const [seedName, seeded] of seeds) {
        it(`${writerName}, ${seedName}: a response scope is stored and reads back as that string`, async () => {
          seedMailbox({ address: ADDRESS, scopes: seeded });
          await runWriter(refreshResponse({ scope: RESPONSE_SCOPE }));
          expect(row()?.scopes_granted).toBe(JSON.stringify(RESPONSE_SCOPE));
          const token = await service.getOAuthToken(USER, "microsoft", "mailbox");
          expect(token.scopes_granted).toBe(RESPONSE_SCOPE);
        });

        it(`${writerName}, ${seedName}: no scope in the response leaves stored scopes unchanged`, async () => {
          seedMailbox({ address: ADDRESS, scopes: seeded });
          await runWriter(refreshResponse({ scope: null }));
          expect(row()?.scopes_granted ?? null).toBe(seeded);
        });

        it(`${writerName}, ${seedName}: an empty response scope leaves stored scopes unchanged`, async () => {
          seedMailbox({ address: ADDRESS, scopes: seeded });
          await runWriter(refreshResponse({ scope: "" }));
          expect(row()?.scopes_granted ?? null).toBe(seeded);
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // F1 — no false "connection expired" for a row that already lost its address
  // -------------------------------------------------------------------------
  describe("F1: an expired token on a row with no address", () => {
    it("refreshes and reports the mailbox connected, not expired", async () => {
      seedMailbox({ address: null, scopes: null, expiresAt: new Date(Date.now() - 3600_000).toISOString() });
      jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(refreshResponse());
      const status = await connectionStatus.checkMicrosoftConnection(USER);
      expect(status.error ?? null).toBeNull();
      expect(status.connected).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // S — storage refuses a mailbox save with an empty address
  // -------------------------------------------------------------------------
  describe("S1: a mailbox save with an empty address is refused", () => {
    for (const provider of ["google", "microsoft"] as const) {
      for (const address of [undefined, null, ""]) {
        for (const connectedFlag of ["omitted", "true"] as const) {
          it(`${provider}, address ${JSON.stringify(address)}, mailbox_connected ${connectedFlag}: throws and leaves the stored row as it was`, async () => {
            seedMailbox({ provider, address: ADDRESS, scopes: SEEDED_SCOPES });
            const payload: Record<string, unknown> = {
              access_token: "overwrite-attempt",
              token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
              connected_email_address: address,
            };
            if (connectedFlag === "true") payload.mailbox_connected = true;

            let thrown: unknown = null;
            try {
              await service.saveOAuthToken(USER, provider, "mailbox", payload);
            } catch (error) {
              thrown = error;
            }

            expect((thrown as Error | null)?.name).toBe("DatabaseError");
            expect(row(provider)?.connected_email_address).toBe(ADDRESS);
            expect(row(provider)?.access_token).toBe("stored-access");
          });
        }
      }
    }

    it("S1-neg-a: a login (authentication) token with no address is still saved", async () => {
      await service.saveOAuthToken(USER, "microsoft", "authentication", {
        access_token: "login-access",
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const saved = db
        .prepare("SELECT access_token FROM oauth_tokens WHERE user_id = ? AND purpose = 'authentication'")
        .get(USER) as { access_token: string } | undefined;
      expect(saved?.access_token).toBe("login-access");
      db.prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND purpose = 'authentication'").run(USER);
    });

    it("S1-neg-b: a mailbox save with an address is still saved", async () => {
      await service.saveOAuthToken(USER, "microsoft", "mailbox", {
        access_token: "connect-access",
        connected_email_address: ADDRESS,
        mailbox_connected: true,
      });
      expect(row()?.connected_email_address).toBe(ADDRESS);
      expect(row()?.access_token).toBe("connect-access");
    });
  });

  // -------------------------------------------------------------------------
  // R — a row that already lost its address is repaired before a store reads it
  // -------------------------------------------------------------------------
  const PROFILE_PATH = "/me?$select=mail,userPrincipalName";

  /** Graph stand-in: the profile request answers from `profile`; everything else is empty. */
  function graph(profile: (attempt: number) => Promise<unknown>): { profileAttempts: () => number } {
    let attempts = 0;
    mockAxios.mockImplementation((config: { url?: string }) => {
      if (String(config.url).endsWith(PROFILE_PATH)) {
        attempts++;
        return profile(attempts);
      }
      return Promise.resolve({ data: { value: [], "@odata.count": 0 } });
    });
    return { profileAttempts: () => attempts };
  }
  const profileOk = () => Promise.resolve({ data: { mail: ADDRESS, userPrincipalName: ADDRESS } });
  const httpError = (status: number) => Promise.reject({ response: { status }, message: `HTTP ${status}` });

  /**
   * An email the user SENT, in the shape the fetch services hand to the store
   * (fixture shape from emailSyncService.forceRecache-2856.test.ts). Its
   * direction can only be "outbound" if the store knows the mailbox address.
   */
  function sentEmail(n: number): StoreableEmail {
    return {
      id: `sent-3286-${n}`,
      threadId: `thread-3286-${n}`,
      subject: `Sent ${n}`,
      from: ADDRESS,
      to: "recipient@example.invalid",
      cc: null,
      bcc: null,
      body: "<p>Hello</p>",
      bodyPlain: "Hello",
      date: new Date("2026-03-02T10:00:00Z"),
      messageIdHeader: `<sent-3286-${n}@example.invalid>`,
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      participants: [
        { role: "from", position: 0, email_address: ADDRESS, display_name: null },
        { role: "to", position: 0, email_address: "recipient@example.invalid", display_name: null },
      ],
    } as StoreableEmail;
  }

  function storedDirection(externalId: string): string | null | "(no row)" {
    const stored = db
      .prepare("SELECT direction FROM emails WHERE user_id = ? AND external_id = ?")
      .get(USER, externalId) as { direction: string | null } | undefined;
    return stored === undefined ? "(no row)" : stored.direction;
  }

  /** Every log call's arguments, flattened, for the "no address in logs" check. */
  function loggedText(): string {
    return ["info", "warn", "error", "debug"]
      .flatMap((level) => (logMock[level] as jest.Mock).mock.calls)
      .map((args) => JSON.stringify(args))
      .join("\n");
  }

  describe("R1: a sync entry repairs the address before the store reads it", () => {
    it("restores the address and stores a sent email as outbound", async () => {
      seedMailbox({ address: null, scopes: null });
      graph(profileOk);
      await outlookFetch.initialize(USER);
      await emailSync.storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [sentEmail(1)] });
      expect(row()?.connected_email_address).toBe(ADDRESS);
      expect(storedDirection("sent-3286-1")).toBe("outbound");
      expect(loggedText()).not.toContain(ADDRESS);
    });

    it("R1-pos: with the address already present, the same email is outbound (the fixture can pass)", async () => {
      seedMailbox({ address: ADDRESS, scopes: SEEDED_SCOPES });
      const calls = graph(profileOk);
      await outlookFetch.initialize(USER);
      await emailSync.storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [sentEmail(2)] });
      expect(storedDirection("sent-3286-2")).toBe("outbound");
      expect(calls.profileAttempts()).toBe(0);
    });
  });

  describe("R2: the post-login precache repairs the address with no expiry and no connection check", () => {
    async function precacheWith(address: string | null, email: StoreableEmail): Promise<void> {
      seedMailbox({ address, scopes: address ? SEEDED_SCOPES : null });
      graph(profileOk);
      jest.spyOn(outlookFetch, "searchEmails").mockResolvedValue([email] as never);
      jest.spyOn(outlookFetch, "searchAllFolders").mockResolvedValue([] as never);
      jest.spyOn(outlookFetch, "getAttachments").mockResolvedValue([]);
      const checkSpy = jest.spyOn(connectionStatus, "checkMicrosoftConnection");
      await emailSync.default.precacheEmails(USER);
      expect(checkSpy).not.toHaveBeenCalled();
    }

    it("restores the address and stores a sent email as outbound", async () => {
      await precacheWith(null, sentEmail(3));
      expect(row()?.connected_email_address).toBe(ADDRESS);
      expect(storedDirection("sent-3286-3")).toBe("outbound");
    });

    it("R2-pos: with the address already present, the same email is outbound (the fixture can pass)", async () => {
      await precacheWith(ADDRESS, sentEmail(4));
      expect(storedDirection("sent-3286-4")).toBe("outbound");
    });
  });

  describe("R3: the repair is one best-effort attempt", () => {
    /** Drive a promise to completion under fake timers, advancing them rather than waiting. */
    async function settle<T>(promise: Promise<T>): Promise<T> {
      let settled = false;
      promise.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      for (let i = 0; i < 400 && !settled; i++) {
        await jest.advanceTimersByTimeAsync(5_000);
      }
      expect(settled).toBe(true);
      return promise;
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it("a failing profile request is tried once, initialize still succeeds, and the sync still stores", async () => {
      seedMailbox({ address: null, scopes: null });
      const calls = graph(() => httpError(500));
      jest.useFakeTimers();
      const ready = await settle(outlookFetch.initialize(USER));
      jest.useRealTimers();

      expect(calls.profileAttempts()).toBe(1);
      expect(ready).toBe(true);
      expect(row()?.connected_email_address ?? null).toBeNull();
      expect(logMock.warn).toHaveBeenCalledWith(
        "Mailbox address repair failed; continuing without it",
        "OutlookFetch",
        expect.anything(),
      );

      await emailSync.storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [sentEmail(5)] });
      expect(storedDirection("sent-3286-5")).toBeNull();
    });

    it("after a 401 and a refresh, the retried profile request is also tried once", async () => {
      seedMailbox({ address: null, scopes: null });
      const calls = graph((attempt) => (attempt === 1 ? httpError(401) : httpError(500)));
      const refreshSpy = jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(refreshResponse());
      jest.useFakeTimers();
      const ready = await settle(outlookFetch.initialize(USER));
      jest.useRealTimers();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(calls.profileAttempts()).toBe(2);
      expect(ready).toBe(true);
    });
  });

  describe("R4: the repair runs with the loaded row's tokens", () => {
    it("a 401 on the profile request refreshes with the stored refresh token and the address is restored", async () => {
      seedMailbox({ address: null, scopes: null });
      // Clear what an earlier initialize left on the shared service instance, so
      // only this row's tokens can make the refresh possible.
      Object.assign(outlookFetch as unknown as Record<string, unknown>, {
        accessToken: null,
        refreshToken: null,
        tokenId: null,
      });
      graph((attempt) => (attempt === 1 ? httpError(401) : profileOk()));
      const refreshSpy = jest.spyOn(microsoftAuth, "refreshToken").mockResolvedValue(refreshResponse());

      await outlookFetch.initialize(USER);

      expect(refreshSpy).toHaveBeenCalledWith("stored-refresh");
      expect(row()?.connected_email_address).toBe(ADDRESS);
      expect(row()?.access_token).toBe("refreshed-access");
    });
  });
});
