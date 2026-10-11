/**
 * @jest-environment node
 *
 * BACKLOG-3903 — disconnecting a mailbox stops its in-flight fetch.
 *
 * Founder, Windows 2.39.0: connected the wrong mailbox during onboarding,
 * disconnected it in Settings, connected another; emails from the first were
 * still imported afterwards.
 *
 * THE MECHANISM THESE TESTS REPRODUCE (traced, emailSyncService.ts):
 *   - the disconnect handler deleted the token row and told no fetch;
 *   - a fetch that had already run `initialize()` kept paging with the token the
 *     fetch service holds in memory (Microsoft has no revocation endpoint);
 *   - `fetchStoreAndDedup` wrote whatever `fetchFn()` returned, unconditionally.
 *
 * "Disconnect" here is what the handler now does first —
 * `invalidateMailboxFetches(provider)` — plus the token row going away (or, for
 * the reconnect case, being replaced by a different mailbox's row). That the
 * handler calls it, and calls it before the delete, is pinned in
 * `handlers/__tests__/sharedAuthHandlers.test.ts`.
 *
 * Runs on the real SQLite driver. Under plain node the shared binary does not
 * load; run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  getRawDatabase: () => db,
}));

const mockGetOAuthToken = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: jest.fn(),
  },
}));

const mockOutlookInit = jest.fn();
const mockOutlookSearch = jest.fn();
const mockOutlookSearchAll = jest.fn();
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockOutlookInit(...a),
    searchEmails: (...a: unknown[]) => mockOutlookSearch(...a),
    searchAllFolders: (...a: unknown[]) => mockOutlookSearchAll(...a),
    getAttachments: jest.fn().mockResolvedValue([]),
  },
}));

const mockGmailInit = jest.fn();
const mockGmailSearch = jest.fn();
const mockGmailSearchAll = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInit(...a),
    searchEmails: (...a: unknown[]) => mockGmailSearch(...a),
    searchAllLabels: (...a: unknown[]) => mockGmailSearchAll(...a),
    getAttachments: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));

jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));

const mockReprocess = jest.fn();
jest.mock("../emailDerivationReprocessService", () => ({
  reprocessEmailDerivations: (...a: unknown[]) => mockReprocess(...a),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import emailSyncService from "../emailSyncService";
import type { EmailPrecacheProgress } from "../emailPrecacheProgress";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3903";

const OUTLOOK_TOKEN = {
  id: "acct-outlook",
  access_token: "at",
  connected_email_address: "me@example.com",
};

/** A provider row in the shape the real Outlook mapper emits. */
function providerEmail(n: number) {
  return {
    id: `ext-${n}`,
    subject: `Subject ${n}`,
    from: `sender${n}@example.com`,
    to: "me@example.com",
    cc: null,
    bcc: null,
    body: `<html><body><p>Message ${n}.</p></body></html>`,
    bodyPlain: `Message ${n}.`,
    date: new Date(`2026-03-01T10:00:00Z`),
    threadId: `thread-${n}`,
    messageIdHeader: `<msg-${n}@example.com>`,
    hasAttachments: false,
    attachments: [],
    participants: [
      { role: "from", position: 0, email_address: `sender${n}@example.com`, display_name: null },
      { role: "to", position: 0, email_address: "me@example.com", display_name: null },
    ],
  };
}

function loadSchema(database: DatabaseType): void {
  database.pragma("foreign_keys = OFF");
  database.exec(fs.readFileSync(SCHEMA, "utf8"));
  database.pragma("foreign_keys = ON");
}

function seedParents(): void {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'microsoft', ?)`,
  ).run(USER, "me@example.com", "oid-1");
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-outlook', ?, 'microsoft', 'mailbox', 'me@example.com')`,
  ).run(USER);
}

function seedEmail(id: string, externalId: string): void {
  db.prepare(
    `INSERT INTO emails
       (id, user_id, external_id, source, account_id, subject, body_plain, body_html,
        sender, recipients, sent_at, received_at, message_id_header, derived_version)
     VALUES (?, ?, ?, 'outlook', 'acct-outlook', ?, 'truncated…', '<html/>',
             'someone@example.com', 'me@example.com', ?, ?, ?, 0)`,
  ).run(id, USER, externalId, `Seeded ${id}`, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", `<seed-${id}@example.com>`);
}

const liveRowIds = (): Set<string> =>
  new Set(
    (db.prepare(`SELECT id FROM emails WHERE user_id = ?`).all(USER) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );

import { currentMailboxGeneration, invalidateMailboxFetches } from "../mailboxFetchGeneration";

const outlookRows = (): Array<{ external_id: string; account_id: string | null }> =>
  db
    .prepare(`SELECT external_id, account_id FROM emails WHERE user_id = ? AND source = 'outlook' ORDER BY external_id`)
    .all(USER) as Array<{ external_id: string; account_id: string | null }>;

const SECOND_MAILBOX = {
  id: "acct-second",
  access_token: "at-2",
  connected_email_address: "second@example.com",
};

/** The connected Outlook mailbox row, as `getOAuthToken` will return it. */
let outlookTokenRow: typeof OUTLOOK_TOKEN | typeof SECOND_MAILBOX | null = OUTLOOK_TOKEN;

const GMAIL_TOKEN = {
  id: "acct-gmail",
  access_token: "gt",
  connected_email_address: "me@gmail.example.com",
};

const SECOND_GMAIL = {
  id: "acct-gmail-second",
  access_token: "gt-2",
  connected_email_address: "second@gmail.example.com",
};

/** The connected Gmail mailbox row, as `getOAuthToken` will return it. */
let gmailTokenRow: typeof GMAIL_TOKEN | typeof SECOND_GMAIL | null = null;

const gmailRows = (): Array<{ external_id: string; account_id: string | null }> =>
  db
    .prepare(`SELECT external_id, account_id FROM emails WHERE user_id = ? AND source = 'gmail' ORDER BY external_id`)
    .all(USER) as Array<{ external_id: string; account_id: string | null }>;

/** Pressing Disconnect on the Gmail mailbox, in the handler's order. */
function disconnectGmail(): void {
  invalidateMailboxFetches("google");
  gmailTokenRow = null;
}

/** Disconnect the first Gmail mailbox, then connect a different one. */
function disconnectGmailThenConnectSecond(): void {
  disconnectGmail();
  gmailTokenRow = SECOND_GMAIL;
}

/** What pressing Disconnect does, in the order the handler does it. */
function disconnectOutlook(): void {
  invalidateMailboxFetches("microsoft");
  outlookTokenRow = null;
}

/** Disconnect the first mailbox, then connect a different one. */
function disconnectThenConnectSecond(): void {
  disconnectOutlook();
  outlookTokenRow = SECOND_MAILBOX;
}

const FOLDER_COUNT = 5;
const PER_FOLDER = 4;
const FULL_MAILBOX = FOLDER_COUNT * PER_FOLDER; // 20
let foldersWalked = 0;
let onFolderFetched: (folderIndex: number) => void = () => {};

/** The folder walk, consulting the signal between folders like the real loop. */
async function walkFolders(options?: { signal?: AbortSignal }) {
  const out: ReturnType<typeof providerEmail>[] = [];
  for (let folder = 0; folder < FOLDER_COUNT; folder++) {
    if (options?.signal?.aborted) break;
    await Promise.resolve();
    foldersWalked++;
    for (let i = 0; i < PER_FOLDER; i++) out.push(providerEmail(folder * PER_FOLDER + i));
    onFolderFetched(folder);
  }
  return out;
}

/**
 * A fetch that never looks at the signal — the shape of every non-pre-cache
 * fetch path (per-transaction sync, provider search), which pass no signal at
 * all. It keeps going on the token the fetch service holds in memory.
 */
async function walkFoldersIgnoringSignal() {
  return walkFolders(undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-second', ?, 'microsoft', 'authentication', 'second@example.com')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-gmail', ?, 'google', 'mailbox', 'me@gmail.example.com')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-gmail-second', ?, 'google', 'authentication', 'second@gmail.example.com')`,
  ).run(USER);

  outlookTokenRow = OUTLOOK_TOKEN;
  foldersWalked = 0;
  onFolderFetched = () => {};
  gmailTokenRow = null;
  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft" ? outlookTokenRow : provider === "google" ? gmailTokenRow : null,
  );
  mockGmailInit.mockResolvedValue(false);
  mockGmailSearch.mockResolvedValue([]);
  mockGmailSearchAll.mockResolvedValue([]);
  mockOutlookInit.mockResolvedValue(true);
  mockOutlookSearch.mockResolvedValue([]);
  mockOutlookSearchAll.mockImplementation(walkFolders);
  mockReprocess.mockResolvedValue({
    scanned: 0,
    rewritten: 0,
    unchanged: 0,
    batches: 0,
    cancelled: false,
    skippedNeedsRefetch: false,
  });
});

afterEach(() => {
  db.close();
});

describe("BACKLOG-3903 — disconnecting a mailbox stops its in-flight fetch", () => {
  /** Baseline: the fixture imports the whole mailbox when nobody disconnects. */
  it("imports the whole mailbox when nobody disconnects", async () => {
    await emailSyncService.precacheEmails(USER);
    expect(outlookRows()).toHaveLength(FULL_MAILBOX);
    expect(foldersWalked).toBe(FOLDER_COUNT);
  });

  /**
   * THE FOUNDER'S CASE. Disconnect during the import; nothing from that
   * mailbox may be written afterwards. On the unfixed build all 20 land.
   */
  it("writes nothing from the mailbox when it is disconnected mid-fetch", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) disconnectOutlook();
    };
    const result = await emailSyncService.precacheEmails(USER);

    expect(foldersWalked).toBeGreaterThanOrEqual(2); // the disconnect really landed mid-walk
    expect(outlookRows()).toEqual([]);
    expect(result.stored).toBe(0);
    // A disconnect is not the user's Cancel, and not a token error to reconnect.
    expect(result.cancelled).toBeUndefined();
    expect(result.providerError).toBeUndefined();
  });

  /** The abort layer: the walk stops at the next folder boundary. */
  it("stops fetching at the next folder after the disconnect", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) disconnectOutlook();
    };
    await emailSyncService.precacheEmails(USER);
    expect(foldersWalked).toBe(2);
  });

  /**
   * Reconnect to a DIFFERENT mailbox mid-fetch. The token row exists again, so
   * a check of "is a mailbox connected" passes; the first mailbox's emails must
   * still not be written — and certainly not stamped with the second's account.
   */
  it("writes none of the first mailbox's emails after a different mailbox is connected", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) disconnectThenConnectSecond();
    };
    await emailSyncService.precacheEmails(USER);
    expect(outlookRows()).toEqual([]);
  });

  /**
   * A later round of the same run. The disconnect lands during the inbox round;
   * the all-folders round STARTS after it, still on the first mailbox's token,
   * and does not look at the signal (as the non-pre-cache paths do not). A
   * check that reads the generation when the write step starts, rather than
   * when the run bound itself to the token, passes this round through.
   */
  it("writes nothing from a later round that started after the disconnect", async () => {
    mockOutlookSearch.mockImplementation(async () => {
      disconnectThenConnectSecond();
      return [providerEmail(100), providerEmail(101)];
    });
    mockOutlookSearchAll.mockImplementation(walkFoldersIgnoringSignal);

    await emailSyncService.precacheEmails(USER);

    // The fixed build never even starts the folder walk: the write step sees the
    // run's token is gone before it calls `fetchFn`. A build that checks too
    // late walks all five folders and writes them.
    expect(foldersWalked).toBe(0);
    expect(outlookRows()).toEqual([]);
  });

  /**
   * Re-cache (force run) writes to staging, and staging becomes live at the
   * swap. A disconnect after the last staged write but before the swap must
   * leave live untouched.
   */
  it("does not swap a re-cache into live when a mailbox was disconnected before the swap", async () => {
    seedEmail("live-1", "ext-900");
    const before = liveRowIds();
    const events: EmailPrecacheProgress[] = [];

    const result = await emailSyncService.precacheEmails(
      USER,
      (p) => {
        events.push(p);
        // The event emitted after the Outlook block has finished staging.
        if (p.phase === "fetching" && p.stage === undefined && p.current === FULL_MAILBOX) {
          disconnectOutlook();
        }
      },
      { force: true },
    );

    expect(events.some((e) => e.phase === "fetching" && e.current === FULL_MAILBOX)).toBe(true);
    expect(result.forceSwap).toBeUndefined();
    expect(result.cancelled).toBe(true);
    expect(liveRowIds()).toEqual(before);
  });

  /** A disconnect of the OTHER provider leaves this one's import alone. */
  it("keeps importing Outlook when Gmail is disconnected", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) invalidateMailboxFetches("google");
    };
    await emailSyncService.precacheEmails(USER);
    expect(outlookRows()).toHaveLength(FULL_MAILBOX);
  });
});

/**
 * The same cases for Gmail. The write step works out which provider's counter
 * to read from the batch's provider; these fail if a Gmail batch reads the
 * Microsoft counter. Only Gmail is connected here.
 */
describe("BACKLOG-3903 — disconnecting a Gmail mailbox stops its in-flight fetch", () => {
  beforeEach(() => {
    outlookTokenRow = null;
    gmailTokenRow = GMAIL_TOKEN;
    mockGmailInit.mockResolvedValue(true);
    mockGmailSearch.mockResolvedValue([]);
    mockGmailSearchAll.mockImplementation(walkFolders);
    // The counters are module state and the Outlook cases above bump Microsoft's.
    // Start both at the same value, so a Gmail batch that read the wrong counter
    // is not refused by the mismatch alone — it must be caught by a disconnect.
    while (currentMailboxGeneration("google") < currentMailboxGeneration("microsoft")) {
      invalidateMailboxFetches("google");
    }
    while (currentMailboxGeneration("microsoft") < currentMailboxGeneration("google")) {
      invalidateMailboxFetches("microsoft");
    }
  });

  /** Baseline: the fixture imports the whole Gmail mailbox when nobody disconnects. */
  it("imports the whole Gmail mailbox when nobody disconnects", async () => {
    await emailSyncService.precacheEmails(USER);
    const rows = gmailRows();
    expect(rows).toHaveLength(FULL_MAILBOX);
    expect(rows.every((r) => r.account_id === "acct-gmail")).toBe(true);
    expect(foldersWalked).toBe(FOLDER_COUNT);
  });

  it("writes nothing from the Gmail mailbox when it is disconnected mid-fetch", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) disconnectGmail();
    };
    const result = await emailSyncService.precacheEmails(USER);

    expect(foldersWalked).toBeGreaterThanOrEqual(2);
    expect(gmailRows()).toEqual([]);
    expect(result.stored).toBe(0);
    expect(result.cancelled).toBeUndefined();
    expect(result.providerError).toBeUndefined();
  });

  it("writes none of the first Gmail mailbox's emails after a different one is connected", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) disconnectGmailThenConnectSecond();
    };
    await emailSyncService.precacheEmails(USER);
    expect(gmailRows()).toEqual([]);
  });

  /** A later Gmail round that starts after the disconnect, ignoring the signal. */
  it("writes nothing from a later Gmail round that started after the disconnect", async () => {
    mockGmailSearch.mockImplementation(async () => {
      disconnectGmailThenConnectSecond();
      return [providerEmail(100), providerEmail(101)];
    });
    mockGmailSearchAll.mockImplementation(walkFoldersIgnoringSignal);

    await emailSyncService.precacheEmails(USER);

    expect(foldersWalked).toBe(0);
    expect(gmailRows()).toEqual([]);
  });

  /** A disconnect of Outlook leaves the Gmail import alone. */
  it("keeps importing Gmail when Outlook is disconnected", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) invalidateMailboxFetches("microsoft");
    };
    await emailSyncService.precacheEmails(USER);
    expect(gmailRows()).toHaveLength(FULL_MAILBOX);
  });
});
